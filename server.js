require('dotenv').config();

const express    = require('express');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cors       = require('cors');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const {
  pool,
  ensureHomeImagesTable,
  ensureClientsTable,
  ensurePasswordResetsTable,
  ensureAdminSettingsTable,
  ensureAdminPasswordResetsTable,
} = require('./db');

const app      = express();
const PORT     = process.env.PORT || 3000;
const SECRET   = process.env.JWT_SECRET || 'mzmedia-dev-secret-change-in-production';
const BASE_PATH = process.env.BASE_PATH || '/website';

// Tabellen im Hintergrund sicherstellen — blockiert den Start nicht, falls die
// DB gerade nicht erreichbar ist. Kunden-Routen liefern in dem Fall 503, bis die
// Verbindung wieder da ist (ensureClientsTable() versucht es bei jedem Aufruf erneut).
ensureHomeImagesTable()
  .then(() => console.log('[DB] home_images Tabelle bereit.'))
  .catch(err => console.warn('[DB] Verbindung fehlgeschlagen — Homepage-Bildverwaltung vorübergehend deaktiviert:', err.message));

ensureClientsTable()
  .then(() => console.log('[DB] clients Tabelle bereit.'))
  .catch(err => console.warn('[DB] Verbindung fehlgeschlagen — Kunden-Login/Verwaltung vorübergehend deaktiviert:', err.message));

ensurePasswordResetsTable()
  .then(() => console.log('[DB] password_resets Tabelle bereit.'))
  .catch(err => console.warn('[DB] Verbindung fehlgeschlagen — Passwort-vergessen vorübergehend deaktiviert:', err.message));

ensureAdminSettingsTable()
  .then(() => console.log('[DB] admin_settings Tabelle bereit.'))
  .catch(err => console.warn('[DB] Verbindung fehlgeschlagen — Admin-Passwort-Änderung vorübergehend deaktiviert (Login läuft über ADMIN_PASSWORD weiter):', err.message));

ensureAdminPasswordResetsTable()
  .then(() => console.log('[DB] admin_password_resets Tabelle bereit.'))
  .catch(err => console.warn('[DB] Verbindung fehlgeschlagen — Admin-Passwort-vergessen vorübergehend deaktiviert:', err.message));

// Log every incoming request so container logs show the raw URL
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Strip BASE_PATH prefix so all routes work identically locally and on server
app.use((req, res, next) => {
  if (BASE_PATH && req.url.startsWith(BASE_PATH)) {
    const stripped = req.url.slice(BASE_PATH.length) || '/';
    console.log(`[BASE_PATH] ${req.url} → ${stripped}`);
    req.url = stripped;
  }
  next();
});

// ─── Mailer ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function buildEmailHtml(client, password, galleryUrl) {
  const templatePath = path.join(__dirname, 'templates', 'credentials-email.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  const shootingParts = [];
  if (client.shootingType) shootingParts.push(client.shootingType);
  if (client.shootingDate) {
    const d = new Date(client.shootingDate);
    shootingParts.push(d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }));
  }
  const shootingInfo = shootingParts.join(' vom ');

  html = html
    .replace(/{{CLIENT_NAME}}/g,    client.name)
    .replace(/{{CLIENT_EMAIL}}/g,   client.email)
    .replace(/{{CLIENT_PASSWORD}}/g, password)
    .replace(/{{GALLERY_URL}}/g,    galleryUrl)
    .replace(/{{FROM_EMAIL}}/g,     process.env.SMTP_USER || '')
    .replace(/{{#if SHOOTING_INFO}}[\s\S]*?{{\/if}}/g,
      shootingInfo ? `vom Shooting <strong style="color:#23271F;">${shootingInfo}</strong>` : '');

  return html;
}

const UPLOADS_DIR  = path.join(__dirname, 'uploads');

// ─── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Simple in-memory rate limiter (max 3 requests per IP per minute)
const contactRateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of contactRateLimitMap) {
    if (now > entry.reset) contactRateLimitMap.delete(ip);
  }
}, 5 * 60_000);

function isRateLimited(ip) {
  const now = Date.now();
  const entry = contactRateLimitMap.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  contactRateLimitMap.set(ip, entry);
  return entry.count > 3;
}

const CLIENT_FIELDS_SQL = 'id, name, email, password_hash AS passwordHash, shooting_date AS shootingDate, shooting_type AS shootingType';

async function findClientByEmail(email) {
  const [[row]] = await pool.query(
    `SELECT ${CLIENT_FIELDS_SQL} FROM clients WHERE email = ?`, [email.toLowerCase()]
  );
  return row || null;
}

async function findClientById(id) {
  const [[row]] = await pool.query(`SELECT ${CLIENT_FIELDS_SQL} FROM clients WHERE id = ?`, [id]);
  return row || null;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  try {
    req.client = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sitzung abgelaufen. Bitte neu anmelden.' });
  }
}

// ─── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Multer (per-client upload folder) ─────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.clientId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },  // 50 MB
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt (JPEG, PNG, WebP).'));
  }
});

// ─── Routes ────────────────────────────────────────────────

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte einen Moment.' });
  }

  const { name, email, type, message, website } = req.body;

  // Honeypot: bots fill this hidden field, humans don't
  if (website) return res.json({ ok: true });

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[CONTACT] SMTP nicht konfiguriert – Nachricht nicht gesendet.');
    return res.json({ ok: true });
  }

  try {
    await transporter.sendMail({
      from:    process.env.MAIL_FROM || process.env.SMTP_USER,
      to:      process.env.CONTACT_EMAIL || process.env.SMTP_USER,
      replyTo: email,
      subject: `Neue Kontaktanfrage von ${name} — mz media`,
      html: `
        <h2 style="font-family:sans-serif;color:#23271F;">Neue Anfrage über das Kontaktformular</h2>
        <p style="font-family:sans-serif;"><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p style="font-family:sans-serif;"><strong>E-Mail:</strong> ${escapeHtml(email)}</p>
        <p style="font-family:sans-serif;"><strong>Projektart:</strong> ${escapeHtml(type || '—')}</p>
        <p style="font-family:sans-serif;"><strong>Nachricht:</strong></p>
        <p style="font-family:sans-serif;white-space:pre-wrap;">${escapeHtml(message)}</p>
      `,
      text: `Name: ${name}\nE-Mail: ${email}\nArt: ${type || '—'}\n\n${message}`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONTACT] E-Mail Fehler:', err.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden. Bitte versuche es später erneut.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich.' });

  let client;
  try {
    await ensureClientsTable();
    client = await findClientByEmail(email);
  } catch (err) {
    return res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
  if (!client) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

  const ok = await bcrypt.compare(password, client.passwordHash);
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

  const token = jwt.sign({ id: client.id, email: client.email, name: client.name }, SECRET, { expiresIn: '7d' });
  res.json({ token, name: client.name, shootingDate: client.shootingDate, shootingType: client.shootingType });
});

// POST /api/forgot-password — Body: { email }
// Antwortet immer mit { ok: true }, egal ob die E-Mail existiert (kein Leak, welche
// Adressen registriert sind). Existiert sie, wird ein Reset-Link per Mail verschickt.
app.post('/api/forgot-password', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte einen Moment.' });
  }

  const { email } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: 'Bitte eine E-Mail-Adresse eingeben.' });

  try {
    await ensurePasswordResetsTable();
    const client = await findClientByEmail(email);

    if (client && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      await pool.query(
        'INSERT INTO password_resets (client_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 1 HOUR)',
        [client.id, tokenHash]
      );

      const resetUrl = `${req.protocol}://${req.get('host')}${BASE_PATH}/gallery.html?reset=${token}`;
      await transporter.sendMail({
        from:    process.env.MAIL_FROM || process.env.SMTP_USER,
        to:      client.email,
        subject: 'Passwort zurücksetzen — mz media',
        html: `
          <p style="font-family:sans-serif;">Hallo ${escapeHtml(client.name)},</p>
          <p style="font-family:sans-serif;">du kannst dein Passwort über den folgenden Link zurücksetzen (gültig für 1 Stunde):</p>
          <p style="font-family:sans-serif;"><a href="${resetUrl}">${resetUrl}</a></p>
          <p style="font-family:sans-serif;">Wenn du das nicht angefordert hast, kannst du diese Mail ignorieren.</p>
        `,
        text: `Hallo ${client.name},\n\nPasswort zurücksetzen (gültig 1 Stunde): ${resetUrl}\n\nWenn du das nicht angefordert hast, ignoriere diese Mail.`,
      });
    }
  } catch (err) {
    console.error('[FORGOT-PASSWORD] Fehler:', err.message);
    // Bewusst trotzdem { ok: true } — kein Hinweis nach außen, ob ein Fehler DB- oder Mail-seitig war.
  }

  res.json({ ok: true });
});

// POST /api/reset-password — Body: { token, password }
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token und neues Passwort erforderlich.' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });

  try {
    await ensurePasswordResetsTable();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [[reset]] = await pool.query(
      'SELECT id, client_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
      [tokenHash]
    );
    if (!reset) return res.status(400).json({ error: 'Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.' });

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE clients SET password_hash = ? WHERE id = ?', [passwordHash, reset.client_id]);
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [reset.id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// GET /api/my-photos  — returns list of photo filenames for logged-in client
app.get('/api/my-photos', authMiddleware, async (req, res) => {
  let client;
  try {
    await ensureClientsTable();
    client = await findClientById(req.client.id);
  } catch (err) {
    return res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
  if (!client) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  const dir = path.join(UPLOADS_DIR, client.id);
  let files = [];
  if (fs.existsSync(dir)) {
    files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => ({ filename: f, url: `/api/photo/${client.id}/${f}` }));
  }
  res.json({ photos: files, name: client.name, shootingDate: client.shootingDate, shootingType: client.shootingType });
});

// GET /api/photo/:clientId/:filename  — serve photo (auth required)
app.get('/api/photo/:clientId/:filename', authMiddleware, (req, res) => {
  if (req.client.id !== req.params.clientId) return res.status(403).json({ error: 'Kein Zugriff.' });

  const filePath = path.join(UPLOADS_DIR, req.params.clientId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Bild nicht gefunden.' });
  res.sendFile(filePath);
});

// GET /api/download/:clientId/:filename  — force download
app.get('/api/download/:clientId/:filename', authMiddleware, (req, res) => {
  if (req.client.id !== req.params.clientId) return res.status(403).json({ error: 'Kein Zugriff.' });

  const filePath = path.join(UPLOADS_DIR, req.params.clientId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Bild nicht gefunden.' });
  res.download(filePath, req.params.filename);
});

// ─── Admin routes (einfacher Auth über separates Admin-Passwort) ──────────

// Admin-Passwort liegt normalerweise in admin_settings (DB), damit es über das Panel
// änderbar ist. Solange dort keine Zeile existiert (frisches Deployment / DB down),
// fällt der Vergleich auf process.env.ADMIN_PASSWORD zurück — Admin-Login bleibt so
// auch ohne DB-Verbindung nutzbar.
async function getAdminPasswordHash() {
  await ensureAdminSettingsTable();
  const [[row]] = await pool.query('SELECT password_hash FROM admin_settings WHERE id = 1');
  return row ? row.password_hash : null;
}

async function verifyAdminPassword(password) {
  try {
    const hash = await getAdminPasswordHash();
    if (hash) return bcrypt.compare(password, hash);
  } catch (err) {
    console.warn('[ADMIN] admin_settings nicht erreichbar, Fallback auf ADMIN_PASSWORD:', err.message);
  }
  return password === (process.env.ADMIN_PASSWORD || 'admin1234');
}

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  if (!(await verifyAdminPassword(req.body.password || ''))) {
    return res.status(401).json({ error: 'Falsches Passwort.' });
  }
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '1d' });
  res.json({ token });
});

function adminMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Nicht angemeldet.' });
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    if (payload.role !== 'admin') throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'Kein Zugriff.' });
  }
}

// POST /api/admin/change-password — Body: { currentPassword, newPassword }
app.post('/api/admin/change-password', adminMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
  }
  if (!(await verifyAdminPassword(currentPassword))) {
    return res.status(401).json({ error: 'Aktuelles Passwort ist falsch.' });
  }

  try {
    await ensureAdminSettingsTable();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'INSERT INTO admin_settings (id, password_hash) VALUES (1, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
      [passwordHash]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar — Passwort konnte nicht gespeichert werden.' });
  }
});

// POST /api/admin/forgot-password — schickt einen Reset-Link an die konfigurierte Admin-Mail.
// Anders als beim Kunden-Login gibt es hier keine E-Mail-Eingabe (nur ein Admin-Zugang),
// daher darf die Antwort auch konkrete Fehler zeigen statt sich generisch zu geben.
app.post('/api/admin/forgot-password', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte einen Moment.' });
  }

  const adminEmail = process.env.ADMIN_EMAIL || process.env.CONTACT_EMAIL || process.env.SMTP_USER;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !adminEmail) {
    return res.status(503).json({ error: 'E-Mail-Versand ist nicht konfiguriert (SMTP/ADMIN_EMAIL in .env).' });
  }

  try {
    await ensureAdminPasswordResetsTable();
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await pool.query(
      'INSERT INTO admin_password_resets (token_hash, expires_at) VALUES (?, NOW() + INTERVAL 1 HOUR)',
      [tokenHash]
    );

    const resetUrl = `${req.protocol}://${req.get('host')}${BASE_PATH}/admin.html?reset=${token}`;
    await transporter.sendMail({
      from:    process.env.MAIL_FROM || process.env.SMTP_USER,
      to:      adminEmail,
      subject: 'Admin-Passwort zurücksetzen — mz media',
      html: `
        <p style="font-family:sans-serif;">Für das Admin-Panel wurde ein Passwort-Reset angefordert.</p>
        <p style="font-family:sans-serif;">Link (gültig für 1 Stunde): <a href="${resetUrl}">${resetUrl}</a></p>
        <p style="font-family:sans-serif;">Wenn du das nicht warst, kannst du diese Mail ignorieren.</p>
      `,
      text: `Admin-Passwort zurücksetzen (gültig 1 Stunde): ${resetUrl}\n\nWenn du das nicht warst, ignoriere diese Mail.`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN-FORGOT-PASSWORD] Fehler:', err.message);
    res.status(503).json({ error: 'Link konnte nicht verschickt werden. Bitte später erneut versuchen.' });
  }
});

// POST /api/admin/reset-password — Body: { token, password }
app.post('/api/admin/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token und neues Passwort erforderlich.' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });

  try {
    await ensureAdminPasswordResetsTable();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [[reset]] = await pool.query(
      'SELECT id FROM admin_password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
      [tokenHash]
    );
    if (!reset) return res.status(400).json({ error: 'Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.' });

    await ensureAdminSettingsTable();
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO admin_settings (id, password_hash) VALUES (1, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
      [passwordHash]
    );
    await pool.query('UPDATE admin_password_resets SET used_at = NOW() WHERE id = ?', [reset.id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// GET /api/admin/clients
app.get('/api/admin/clients', adminMiddleware, async (req, res) => {
  try {
    await ensureClientsTable();
    const [rows] = await pool.query(
      `SELECT id, name, email, shooting_date AS shootingDate, shooting_type AS shootingType FROM clients ORDER BY created_at DESC`
    );
    res.json({ clients: rows });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// POST /api/admin/clients  — create new client
app.post('/api/admin/clients', adminMiddleware, async (req, res) => {
  const { name, email, password, shootingDate, shootingType } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, Email und Passwort erforderlich.' });

  try {
    await ensureClientsTable();
    if (await findClientByEmail(email)) {
      return res.status(409).json({ error: 'Email bereits vorhanden.' });
    }

    const id = 'c' + Date.now();
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO clients (id, name, email, password_hash, shooting_date, shooting_type) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, email, passwordHash, shootingDate || '', shootingType || '']
    );
    res.status(201).json({ id, name, email });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// POST /api/admin/clients/:clientId/photos  — upload photos
app.post('/api/admin/clients/:clientId/photos', adminMiddleware, upload.array('photos', 100), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Keine Dateien hochgeladen.' });
  res.json({ uploaded: req.files.map(f => f.filename) });
});

// DELETE /api/admin/clients/:clientId/photos/:filename
app.delete('/api/admin/clients/:clientId/photos/:filename', adminMiddleware, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.clientId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Bild nicht gefunden.' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// GET /api/admin/clients/:clientId/photos  — list photos (admin)
app.get('/api/admin/clients/:clientId/photos', adminMiddleware, (req, res) => {
  const dir = path.join(UPLOADS_DIR, req.params.clientId);
  let photos = [];
  if (fs.existsSync(dir)) {
    photos = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => ({ filename: f }));
  }
  res.json({ photos });
});

// GET /api/admin/photo/:clientId/:filename  — serve photo for admin preview
app.get('/api/admin/photo/:clientId/:filename', (req, res) => {
  const { auth } = req.query;
  if (!auth) return res.status(401).end();
  try { const p = jwt.verify(auth, SECRET); if (p.role !== 'admin') throw new Error(); }
  catch { return res.status(401).end(); }
  const filePath = path.join(UPLOADS_DIR, req.params.clientId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// GET /api/my-photos-admin/:clientId  — photo count helper for admin dashboard
app.get('/api/my-photos-admin/:clientId', adminMiddleware, (req, res) => {
  const dir = path.join(UPLOADS_DIR, req.params.clientId);
  let photos = [];
  if (fs.existsSync(dir)) {
    photos = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f));
  }
  res.json({ photos: photos.map(f => ({ filename: f })) });
});

// POST /api/admin/clients/:clientId/send-email
// Body: { password, galleryUrl }
app.post('/api/admin/clients/:clientId/send-email', adminMiddleware, async (req, res) => {
  const { password, galleryUrl } = req.body;
  if (!password || !galleryUrl) return res.status(400).json({ error: 'password und galleryUrl erforderlich.' });

  let client;
  try {
    await ensureClientsTable();
    client = await findClientById(req.params.clientId);
  } catch (err) {
    return res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
  if (!client) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({ error: 'SMTP nicht konfiguriert. Bitte .env-Datei ausfüllen.' });
  }

  try {
    const html = buildEmailHtml(client, password, galleryUrl);
    await transporter.sendMail({
      from:    process.env.MAIL_FROM || process.env.SMTP_USER,
      to:      client.email,
      subject: `Deine Bilder sind fertig — mz media`,
      html,
      text:
        `Hallo ${client.name},\n\n` +
        `deine Fotos sind fertig!\n\n` +
        `Link: ${galleryUrl}\n` +
        `E-Mail: ${client.email}\n` +
        `Passwort: ${password}\n\n` +
        `Viele Grüße,\nMiguel`
    });
    res.json({ ok: true, to: client.email });
  } catch (err) {
    console.error('E-Mail Fehler:', err.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden: ' + err.message });
  }
});

// ─── Homepage-Bilder (Hero, About, Galerie) ──────────────────
// Bilder werden als BLOB in der Datenbank gespeichert (nicht auf der Festplatte),
// damit sie über beliebige Deploys/Redeploys hinweg erhalten bleiben.

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },  // 8 MB
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt (JPEG, PNG, WebP, GIF).'));
  }
});

function homeImageUrl(id) { return `/api/home-image/${id}`; }

// GET /api/home-images — öffentlich, Metadaten aller Homepage-Bilder
app.get('/api/home-images', async (req, res) => {
  try {
    await ensureHomeImagesTable();
    const [rows] = await pool.query(
      'SELECT id, slot, category, sort_order FROM home_images ORDER BY sort_order ASC, id ASC'
    );
    const bySlot = s => rows.find(r => r.slot === s);
    const hero         = bySlot('hero');
    const aboutMain    = bySlot('about-main');
    const aboutAccent  = bySlot('about-accent');
    res.json({
      hero:        hero        ? { id: hero.id,        url: homeImageUrl(hero.id) }        : null,
      aboutMain:   aboutMain   ? { id: aboutMain.id,    url: homeImageUrl(aboutMain.id) }   : null,
      aboutAccent: aboutAccent ? { id: aboutAccent.id,  url: homeImageUrl(aboutAccent.id) } : null,
      gallery: rows.filter(r => r.slot === 'gallery')
                   .map(r => ({ id: r.id, category: r.category, url: homeImageUrl(r.id) })),
    });
  } catch (err) {
    res.status(503).json({ error: 'Bilder aktuell nicht verfügbar.' });
  }
});

// GET /api/home-image/:id — öffentlich, liefert das BLOB aus
app.get('/api/home-image/:id', async (req, res) => {
  try {
    await ensureHomeImagesTable();
    const [[row]] = await pool.query('SELECT data, mime_type FROM home_images WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).end();
    res.set('Content-Type', row.mime_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(row.data);
  } catch (err) {
    res.status(503).end();
  }
});

// GET /api/admin/home-images — admin, Metadaten für die Admin-UI
app.get('/api/admin/home-images', adminMiddleware, async (req, res) => {
  try {
    await ensureHomeImagesTable();
    const [rows] = await pool.query(
      'SELECT id, slot, category, filename, mime_type, sort_order, created_at FROM home_images ORDER BY sort_order ASC, id ASC'
    );
    res.json({ images: rows.map(r => ({ ...r, url: homeImageUrl(r.id) })) });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// POST /api/admin/home-images/gallery — admin, Mehrfach-Upload für die Galerie
// (muss VOR /api/admin/home-images/:slot registriert sein, sonst fängt die :slot-Route "gallery" als Slot-Namen ab)
app.post('/api/admin/home-images/gallery', adminMiddleware, uploadMemory.array('photos', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Keine Dateien hochgeladen.' });
  const category = (req.body.category || 'Sonstiges').trim();
  try {
    await ensureHomeImagesTable();
    const [[{ maxOrder }]] = await pool.query(
      "SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM home_images WHERE slot = 'gallery'"
    );
    let nextOrder = maxOrder + 1;
    const uploaded = [];
    for (const file of req.files) {
      const [result] = await pool.query(
        "INSERT INTO home_images (slot, category, filename, mime_type, data, sort_order) VALUES ('gallery', ?, ?, ?, ?, ?)",
        [category, file.originalname, file.mimetype, file.buffer, nextOrder]
      );
      uploaded.push({ id: result.insertId, url: homeImageUrl(result.insertId), category });
      nextOrder++;
    }
    res.json({ uploaded });
  } catch (err) {
    res.status(503).json({ error: 'Bilder konnten nicht gespeichert werden.' });
  }
});

// POST /api/admin/home-images/:slot — admin, Upload für hero/about-main/about-accent
app.post('/api/admin/home-images/:slot', adminMiddleware, uploadMemory.single('image'), async (req, res) => {
  const { slot } = req.params;
  if (!['hero', 'about-main', 'about-accent'].includes(slot)) {
    return res.status(400).json({ error: 'Ungültiger Slot.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  try {
    await ensureHomeImagesTable();
    await pool.query('DELETE FROM home_images WHERE slot = ?', [slot]);
    const [result] = await pool.query(
      'INSERT INTO home_images (slot, filename, mime_type, data, sort_order) VALUES (?, ?, ?, ?, 0)',
      [slot, req.file.originalname, req.file.mimetype, req.file.buffer]
    );
    res.json({ id: result.insertId, url: homeImageUrl(result.insertId) });
  } catch (err) {
    res.status(503).json({ error: 'Bild konnte nicht gespeichert werden.' });
  }
});

// PATCH /api/admin/home-images/:id — admin, Kategorie eines Galerie-Bilds ändern
app.patch('/api/admin/home-images/:id', adminMiddleware, async (req, res) => {
  const { category } = req.body;
  if (!category?.trim()) return res.status(400).json({ error: 'Kategorie erforderlich.' });
  try {
    await ensureHomeImagesTable();
    const [result] = await pool.query(
      "UPDATE home_images SET category = ? WHERE id = ? AND slot = 'gallery'",
      [category.trim(), req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Galerie-Bild nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// PUT /api/admin/home-images/:id — admin, ersetzt die Bilddaten eines vorhandenen
// Einzel-Slot- oder Galerie-Bilds (z. B. nach Zuschneiden/Drehen im Bild-Editor),
// ohne id/slot/category/sort_order zu verändern
app.put('/api/admin/home-images/:id', adminMiddleware, uploadMemory.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  try {
    await ensureHomeImagesTable();
    const [result] = await pool.query(
      'UPDATE home_images SET filename = ?, mime_type = ?, data = ? WHERE id = ?',
      [req.file.originalname, req.file.mimetype, req.file.buffer, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Bild nicht gefunden.' });
    res.json({ id: Number(req.params.id), url: homeImageUrl(req.params.id) });
  } catch (err) {
    res.status(503).json({ error: 'Bild konnte nicht gespeichert werden.' });
  }
});

// POST /api/admin/home-images/:id/move — admin, Galerie-Bild rauf/runter sortieren
app.post('/api/admin/home-images/:id/move', adminMiddleware, async (req, res) => {
  const { direction } = req.body; // 'up' | 'down'
  if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Ungültige Richtung.' });
  try {
    await ensureHomeImagesTable();
    const [rows] = await pool.query(
      "SELECT id, sort_order FROM home_images WHERE slot = 'gallery' ORDER BY sort_order ASC, id ASC"
    );
    const index = rows.findIndex(r => r.id === Number(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Galerie-Bild nicht gefunden.' });
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (!rows[neighborIndex]) return res.json({ ok: true }); // schon am Rand, kein-op
    const a = rows[index], b = rows[neighborIndex];
    await pool.query('UPDATE home_images SET sort_order = ? WHERE id = ?', [b.sort_order, a.id]);
    await pool.query('UPDATE home_images SET sort_order = ? WHERE id = ?', [a.sort_order, b.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// DELETE /api/admin/home-images/:id — admin, löscht Einzel-Slot- oder Galerie-Bild
app.delete('/api/admin/home-images/:id', adminMiddleware, async (req, res) => {
  try {
    await ensureHomeImagesTable();
    const [result] = await pool.query('DELETE FROM home_images WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Bild nicht gefunden.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: 'Datenbank aktuell nicht erreichbar.' });
  }
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`mz media server läuft auf http://localhost:${PORT}`);
});
