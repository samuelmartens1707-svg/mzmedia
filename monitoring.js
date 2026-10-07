// ─── Monitoring: Selbsttest (/api/health) + Fehler-Mails an den Admin ───────────
//
// /api/health    – wird von UptimeRobot alle 5 Minuten aufgerufen. 200 = alles ok,
//                  503 = mindestens ein Teil (Datenbank, Foto-Ordner, Mailserver) klemmt.
//                  Liefert nur ok/Fehlercode je Bereich — keine Zugangsdaten, keine Kundendaten.
// Fehler-Mails   – jede Antwort mit Status >= 500 (und unbehandelte Fehler im Prozess) löst
//                  eine kurze Mail an ADMIN_EMAIL aus, höchstens eine pro Fehlerart und Stunde.
//                  Ist der Mailserver selbst kaputt, kann natürlich keine Mail rausgehen —
//                  das fängt UptimeRobot über /api/health ab.

const fs   = require('fs');
const path = require('path');
const multer = require('multer');

const ALERT_COOLDOWN_MS    = 60 * 60 * 1000; // eine Mail pro Fehlerart und Stunde
const SMTP_OK_CACHE_MS     = 15 * 60 * 1000; // erfolgreichen SMTP-Check nicht bei jedem Aufruf wiederholen
const SMTP_MIN_RECHECK_MS  = 60 * 1000;      // auch fehlgeschlagene Checks höchstens 1x pro Minute
const CHECK_TIMEOUT_MS     = 8000;

// Sprechende Namen für die Fehler-Mail (erster passender Eintrag gewinnt)
const AREA_LABELS = [
  [/^\/api\/contact/,                         'Kontaktformular der Startseite'],
  [/^\/api\/mediabox-anfrage/,                'Mediabox-Anfrageformular'],
  [/\/send-email$/,                           'Bilder-Mail an einen Kunden'],
  [/\/invoice$/,                              'Rechnung (sevDesk)'],
  [/^\/api\/admin\/clients\/:clientId\/photos/, 'Foto-Upload für einen Kunden'],
  [/^\/api\/admin\/clients/,                  'Kundenverwaltung im Admin-Panel'],
  [/^\/api\/admin\/home-images/,              'Website-Bilder im Admin-Panel'],
  [/^\/api\/(home-images?|mediabox-images)/,  'Bilder auf der öffentlichen Website'],
  [/^\/api\/g\//,                             'Kunden-Galerie (Link)'],
  [/^\/api\/resend-gallery-link/,             'Galerie-Link erneut zusenden'],
  [/^\/api\/admin\/mediabox-availability|^\/api\/mediabox-availability/, 'Mediabox-Belegungskalender'],
  [/^\/api\/admin/,                           'Admin-Panel'],
];

function areaLabel(route) {
  const hit = AREA_LABELS.find(([re]) => re.test(route));
  return hit ? hit[1] : route;
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(label + ' Zeitüberschreitung'), { code: 'TIMEOUT' })), CHECK_TIMEOUT_MS)),
  ]);
}

function formatNow() {
  return new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'medium' });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setupMonitoring({ app, pool, transporter, uploadsDir, ensureHomeImagesTable, ensureClientsTable }) {
  const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const alertRecipient = () => process.env.ADMIN_EMAIL || process.env.CONTACT_EMAIL || process.env.SMTP_USER;

  // ── Fehler-Mails (gedrosselt) ──
  const alerts = new Map(); // Fehlerart → { lastSent, suppressed }

  async function notifyAdmin(kind, { area, status, message, detail }) {
    const now = Date.now();
    const entry = alerts.get(kind) || { lastSent: 0, suppressed: 0 };
    if (now - entry.lastSent < ALERT_COOLDOWN_MS) {
      entry.suppressed++;
      alerts.set(kind, entry);
      return;
    }
    const suppressed = entry.suppressed;
    alerts.set(kind, { lastSent: now, suppressed: 0 });

    if (!smtpConfigured() || !alertRecipient()) {
      console.error('[MONITORING] Fehler-Mail nicht möglich (SMTP/ADMIN_EMAIL fehlt):', kind, message);
      return;
    }
    const rows = [
      ['Bereich', area],
      ['Zeitpunkt', formatNow()],
      status ? ['Status', String(status)] : null,
      message ? ['Meldung', message] : null,
      detail && detail !== message ? ['Technisch', detail] : null,
      suppressed ? ['Hinweis', `${suppressed} weitere gleichartige Fehler in der letzten Stunde wurden nicht einzeln gemeldet.`] : null,
    ].filter(Boolean);
    try {
      await transporter.sendMail({
        from:    process.env.MAIL_FROM || process.env.SMTP_USER,
        to:      alertRecipient(),
        subject: `⚠️ Fehler auf der Website: ${area}`,
        html: `
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#23271F;">
            <p>Auf der Website ist gerade ein Fehler aufgetreten:</p>
            <table cellpadding="6" style="border-collapse:collapse;">
              ${rows.map(([k, v]) => `<tr><td style="color:#6E7A63;vertical-align:top;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}
            </table>
            <p style="color:#6E7A63;font-size:12px;">Weitere Fehler dieser Art werden frühestens in einer Stunde wieder gemeldet.
            Die Container-Logs bei mittwald enthalten die vollständigen Details.</p>
          </div>`,
        text: 'Auf der Website ist gerade ein Fehler aufgetreten:\n\n' + rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
          '\n\nWeitere Fehler dieser Art werden frühestens in einer Stunde wieder gemeldet.',
      });
      console.log('[MONITORING] Fehler-Mail gesendet:', kind);
    } catch (err) {
      console.error('[MONITORING] Fehler-Mail konnte nicht gesendet werden:', err.message);
    }
  }

  // ── Jede 5xx-Antwort melden ──
  // Muss VOR den Routen registriert werden. Die Fehlermeldung aus res.json({ error }) wird mitgeschickt.
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = body => {
      if (body && typeof body.error === 'string') res.locals.errorMessage = body.error;
      return json(body);
    };
    res.on('finish', () => {
      if (res.statusCode < 500 || req.path === '/api/health') return;
      // Routen-Muster statt echter URL — enthält nie Galerie-Tokens oder Kunden-IDs
      const route = req.route?.path ? req.baseUrl + req.route.path : req.path;
      notifyAdmin(`${req.method} ${route} ${res.statusCode}`, {
        area: areaLabel(route),
        status: res.statusCode,
        message: res.locals.errorMessage,
        detail: res.locals.errorDetail,
      });
    });
    next();
  });

  // ── Selbsttest ──
  let smtpCache = { at: 0, ok: false, code: null };

  async function checkSmtp() {
    if (!smtpConfigured()) return 'nicht konfiguriert';
    const age = Date.now() - smtpCache.at;
    if ((smtpCache.ok && age < SMTP_OK_CACHE_MS) || (!smtpCache.ok && age < SMTP_MIN_RECHECK_MS)) {
      return smtpCache.ok ? 'ok' : 'fehler: ' + smtpCache.code;
    }
    try {
      await withTimeout(transporter.verify(), 'Mailserver');
      smtpCache = { at: Date.now(), ok: true, code: null };
      return 'ok';
    } catch (err) {
      smtpCache = { at: Date.now(), ok: false, code: err.code || err.responseCode || 'unbekannt' };
      console.error('[HEALTH] Mailserver:', err.message);
      return 'fehler: ' + smtpCache.code;
    }
  }

  async function check(name, fn) {
    try {
      await withTimeout(fn(), name);
      return 'ok';
    } catch (err) {
      console.error(`[HEALTH] ${name}:`, err.message);
      return 'fehler: ' + (err.code || 'unbekannt');
    }
  }

  app.get('/api/health', async (req, res) => {
    const [datenbank, websiteBilder, kunden, fotoOrdner, mailserver] = await Promise.all([
      check('Datenbank', () => pool.query('SELECT 1')),
      check('Website-Bilder', async () => { await ensureHomeImagesTable(); await pool.query('SELECT COUNT(*) FROM home_images'); }),
      check('Kunden', async () => { await ensureClientsTable(); await pool.query('SELECT COUNT(*) FROM clients'); }),
      check('Foto-Ordner', async () => {
        fs.mkdirSync(uploadsDir, { recursive: true });
        const probe = path.join(uploadsDir, '.healthcheck');
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
      }),
      checkSmtp(),
    ]);
    const checks = { datenbank, websiteBilder, kunden, fotoOrdner, mailserver };
    const ok = Object.values(checks).every(v => v === 'ok');
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fehler', checks, zeit: new Date().toISOString() });
  });

  // ── Abschließender Fehler-Handler (nach allen Routen registrieren) ──
  // Upload-Fehler (falsches Format, zu groß) sind Nutzerfehler → 400, ohne Alarm.
  function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Datei ist zu groß.' : 'Upload fehlgeschlagen: ' + err.message });
    }
    if (/^Nur Bilder erlaubt/.test(err.message || '')) return res.status(400).json({ error: err.message });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Ungültige Anfrage.' });
    console.error('[ERROR]', req.method, req.path, err);
    res.locals.errorDetail = err.message;
    res.status(500).json({ error: 'Interner Serverfehler.' });
  }

  // ── Unbehandelte Fehler im Prozess ──
  process.on('unhandledRejection', reason => {
    console.error('[MONITORING] Unbehandelte Promise-Ablehnung:', reason);
    notifyAdmin('unhandledRejection', { area: 'Server (unbehandelter Fehler)', message: String(reason?.message || reason) });
  });
  process.on('uncaughtException', err => {
    console.error('[MONITORING] Unbehandelter Fehler — Server wird beendet:', err);
    // Wie ohne Handler beenden (Zustand unklar), aber vorher noch Bescheid geben
    notifyAdmin('uncaughtException', { area: 'Server abgestürzt', message: err.message, detail: 'Der Server-Prozess wird beendet und muss neu starten.' })
      .finally(() => setTimeout(() => process.exit(1), 500));
    setTimeout(() => process.exit(1), 10000).unref();
  });

  return { notifyAdmin, errorHandler };
}

module.exports = { setupMonitoring };
