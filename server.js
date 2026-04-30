require('dotenv').config();

const express    = require('express');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cors       = require('cors');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'mzmedia-dev-secret-change-in-production';

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
      shootingInfo ? `vom Shooting <strong style="color:#2A1F14;">${shootingInfo}</strong>` : '');

  return html;
}

const DATA_FILE    = path.join(__dirname, 'data', 'clients.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');

// ─── Helpers ───────────────────────────────────────────────
function readClients() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeClients(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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
app.use(express.static(__dirname));   // serves index.html, gallery.html, etc.

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

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich.' });

  const db = readClients();
  const client = db.clients.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (!client) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

  const ok = await bcrypt.compare(password, client.passwordHash);
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

  const token = jwt.sign({ id: client.id, email: client.email, name: client.name }, SECRET, { expiresIn: '7d' });
  res.json({ token, name: client.name, shootingDate: client.shootingDate, shootingType: client.shootingType });
});

// GET /api/my-photos  — returns list of photo filenames for logged-in client
app.get('/api/my-photos', authMiddleware, (req, res) => {
  const db = readClients();
  const client = db.clients.find(c => c.id === req.client.id);
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

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort.' });
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

// GET /api/admin/clients
app.get('/api/admin/clients', adminMiddleware, (req, res) => {
  const db = readClients();
  const safe = db.clients.map(({ passwordHash, ...rest }) => rest);
  res.json({ clients: safe });
});

// POST /api/admin/clients  — create new client
app.post('/api/admin/clients', adminMiddleware, async (req, res) => {
  const { name, email, password, shootingDate, shootingType } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, Email und Passwort erforderlich.' });

  const db = readClients();
  if (db.clients.find(c => c.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Email bereits vorhanden.' });
  }

  const id = 'c' + Date.now();
  const passwordHash = await bcrypt.hash(password, 10);
  db.clients.push({ id, name, email, passwordHash, shootingDate: shootingDate || '', shootingType: shootingType || '', photos: [] });
  writeClients(db);
  res.status(201).json({ id, name, email });
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

  const db = readClients();
  const client = db.clients.find(c => c.id === req.params.clientId);
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

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`mz media server läuft auf http://localhost:${PORT}`);
});
