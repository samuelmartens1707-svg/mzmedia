const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST || '127.0.0.1',
  port:               Number(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    5,
  charset:            'utf8mb4',
  enableKeepAlive:    true,
});

// Der MySQL-Server (wait_timeout) kann eine im Pool ruhende Verbindung serverseitig
// schließen, ohne dass mysql2 das bemerkt — der nächste Query darüber schlägt dann mit
// PROTOCOL_CONNECTION_LOST/ECONNRESET/EPIPE fehl, obwohl die DB längst wieder erreichbar
// ist. mysql2 wirft die kaputte Verbindung danach selbst aus dem Pool, ein zweiter Versuch
// bekommt also automatisch eine frische Verbindung. Deshalb hier einmalig automatisch
// wiederholen, statt den Fehler ungefiltert an die Route durchzureichen.
const TRANSIENT_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);
const rawQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  try {
    return await rawQuery(...args);
  } catch (err) {
    if (TRANSIENT_ERROR_CODES.has(err.code)) {
      return await rawQuery(...args);
    }
    throw err;
  }
};

// Ergänzt fehlende Spalten einer bereits bestehenden Tabelle automatisch (ADD COLUMN),
// statt sich darauf zu verlassen, dass nach jedem Deploy manuell ein Migrationsskript
// ausgeführt wird — genau das wurde in der Vergangenheit vergessen und hat Routen, die
// die neuen Spalten abfragen, mit einem SQL-Fehler (→ 503) stillschweigend lahmgelegt.
async function ensureColumns(table, columns) {
  const [rows] = await pool.query(
    'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  );
  const existing = new Set(rows.map(r => r.name));
  for (const col of columns) {
    if (!existing.has(col.name)) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col.ddl}`);
      console.log(`[DB] Spalte ergänzt: ${table}.${col.name}`);
    }
  }
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS home_images (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slot        ENUM('hero','about-main','about-accent','gallery','mediabox-hero','mediabox-gallery') NOT NULL,
    category    VARCHAR(40) NULL,
    alt_text    VARCHAR(160) NULL,
    filename    VARCHAR(255) NOT NULL,
    mime_type   VARCHAR(64) NOT NULL,
    data        MEDIUMBLOB NOT NULL,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_home_images_slot (slot, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Erweitert die slot-ENUM einer bereits bestehenden home_images-Tabelle automatisch um
// mediabox-hero/mediabox-gallery, falls sie (z. B. aus einem älteren Deployment) noch
// fehlen — ersetzt scripts/add-mediabox-slot-to-home-images.js als manuellen Schritt.
async function ensureHomeImagesMediaboxSlots() {
  const [[row]] = await pool.query(
    "SELECT column_type AS colType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'home_images' AND column_name = 'slot'"
  );
  const colType = row?.colType || '';
  if (colType.includes('mediabox-gallery') && colType.includes('mediabox-hero')) return;
  await pool.query(
    "ALTER TABLE home_images MODIFY COLUMN slot ENUM('hero','about-main','about-accent','gallery','mediabox-hero','mediabox-gallery') NOT NULL"
  );
  console.log('[DB] home_images.slot-Enum um mediabox-hero/mediabox-gallery erweitert.');
}

// Cached promise so every home-images route can safely call this first —
// cheap after the first success, and self-heals if the DB was down at boot.
let ensured = null;
function ensureHomeImagesTable() {
  if (!ensured) {
    ensured = pool.query(CREATE_TABLE_SQL)
      .then(() => ensureHomeImagesMediaboxSlots())
      .catch(err => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

const CREATE_CLIENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS clients (
    id             VARCHAR(32) PRIMARY KEY,
    name           VARCHAR(160) NOT NULL,
    email          VARCHAR(190) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    shooting_date  VARCHAR(20) NOT NULL DEFAULT '',
    shooting_type  VARCHAR(120) NOT NULL DEFAULT '',
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Rechnungsadresse + sevDesk-Kontakt-Cache — ursprünglich per scripts/add-billing-fields-to-clients.js
// nachgezogen; jetzt zusätzlich hier, damit sie garantiert existieren, unabhängig davon, ob
// das Skript nach einem Deploy manuell ausgeführt wurde (das genau hier zu fehlenden Kunden
// in der Admin-Übersicht geführt hat, da GET /api/admin/clients sonst mit SQL-Fehler → 503 endet).
const CLIENTS_OPTIONAL_COLUMNS = [
  { name: 'company_name',       ddl: "company_name VARCHAR(160) NOT NULL DEFAULT ''" },
  { name: 'billing_street',     ddl: "billing_street VARCHAR(190) NOT NULL DEFAULT ''" },
  { name: 'billing_zip',        ddl: "billing_zip VARCHAR(20) NOT NULL DEFAULT ''" },
  { name: 'billing_city',       ddl: "billing_city VARCHAR(120) NOT NULL DEFAULT ''" },
  { name: 'billing_country',    ddl: "billing_country VARCHAR(2) NOT NULL DEFAULT 'DE'" },
  { name: 'sevdesk_contact_id', ddl: "sevdesk_contact_id VARCHAR(32) NOT NULL DEFAULT ''" },
];

// id bleibt VARCHAR (nicht AUTO_INCREMENT), weil bestehende IDs wie "c1777494715939"
// direkt den Ordnernamen unter uploads/<id>/ entsprechen — das darf sich nicht ändern.
let ensuredClients = null;
function ensureClientsTable() {
  if (!ensuredClients) {
    ensuredClients = pool.query(CREATE_CLIENTS_TABLE_SQL)
      .then(() => ensureColumns('clients', CLIENTS_OPTIONAL_COLUMNS))
      .catch(err => {
        ensuredClients = null;
        throw err;
      });
  }
  return ensuredClients;
}

const CREATE_PASSWORD_RESETS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS password_resets (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id   VARCHAR(32) NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    INDEX idx_password_resets_token_hash (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Braucht die clients-Tabelle als Fremdschlüssel-Ziel, deshalb erst ensureClientsTable().
let ensuredPasswordResets = null;
function ensurePasswordResetsTable() {
  if (!ensuredPasswordResets) {
    ensuredPasswordResets = ensureClientsTable()
      .then(() => pool.query(CREATE_PASSWORD_RESETS_TABLE_SQL))
      .catch(err => {
        ensuredPasswordResets = null;
        throw err;
      });
  }
  return ensuredPasswordResets;
}

const CREATE_ADMIN_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_settings (
    id             TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
    password_hash  VARCHAR(255) NOT NULL,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Einzige Zeile (id=1) mit dem aktuellen Admin-Passwort-Hash. Solange sie fehlt,
// fällt der Login weiterhin auf process.env.ADMIN_PASSWORD zurück (siehe server.js) —
// erst ein "Passwort ändern"/"zurücksetzen" legt diese Zeile an.
let ensuredAdminSettings = null;
function ensureAdminSettingsTable() {
  if (!ensuredAdminSettings) {
    ensuredAdminSettings = pool.query(CREATE_ADMIN_SETTINGS_TABLE_SQL).catch(err => {
      ensuredAdminSettings = null;
      throw err;
    });
  }
  return ensuredAdminSettings;
}

const CREATE_ADMIN_PASSWORD_RESETS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_password_resets (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_hash  CHAR(64) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_password_resets_token_hash (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

let ensuredAdminPasswordResets = null;
function ensureAdminPasswordResetsTable() {
  if (!ensuredAdminPasswordResets) {
    ensuredAdminPasswordResets = pool.query(CREATE_ADMIN_PASSWORD_RESETS_TABLE_SQL).catch(err => {
      ensuredAdminPasswordResets = null;
      throw err;
    });
  }
  return ensuredAdminPasswordResets;
}

const CREATE_INVOICES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS invoices (
    id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id          VARCHAR(32) NOT NULL,
    sevdesk_invoice_id VARCHAR(32) NOT NULL,
    invoice_number     VARCHAR(60) NOT NULL DEFAULT '',
    total_amount       DECIMAL(10,2) NOT NULL,
    currency           VARCHAR(3) NOT NULL DEFAULT 'EUR',
    header             VARCHAR(255) NOT NULL DEFAULT '',
    sent_to_email      VARCHAR(190) NOT NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    INDEX idx_invoices_client_id (client_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Lokales Audit-Log gesendeter Rechnungen — sevDesk selbst ist die "Quelle der Wahrheit"
// für Rechnungsinhalt/PDF, diese Tabelle ist nur für die "Rechnungen"-Übersicht im Admin-Panel.
// Braucht clients als Fremdschlüssel-Ziel, deshalb erst ensureClientsTable().
let ensuredInvoices = null;
function ensureInvoicesTable() {
  if (!ensuredInvoices) {
    ensuredInvoices = ensureClientsTable()
      .then(() => pool.query(CREATE_INVOICES_TABLE_SQL))
      .catch(err => {
        ensuredInvoices = null;
        throw err;
      });
  }
  return ensuredInvoices;
}

const CREATE_MEDIABOX_BOOKINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mediabox_bookings (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booked_date DATE NOT NULL UNIQUE,
    note        VARCHAR(160) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mediabox_bookings_date (booked_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Belegte Termine der Mediabox (Fotobox-Vermietung) — ein Datum ist entweder frei oder
// belegt, keine Uhrzeiten/Slots. Eigene, schlanke Tabelle statt externem Kalenderdienst
// (Exchange ist bei Mittwald-Mailhosting nicht verfügbar).
let ensuredMediaboxBookings = null;
function ensureMediaboxBookingsTable() {
  if (!ensuredMediaboxBookings) {
    ensuredMediaboxBookings = pool.query(CREATE_MEDIABOX_BOOKINGS_TABLE_SQL).catch(err => {
      ensuredMediaboxBookings = null;
      throw err;
    });
  }
  return ensuredMediaboxBookings;
}

module.exports = {
  pool,
  ensureHomeImagesTable,
  ensureClientsTable,
  ensurePasswordResetsTable,
  ensureAdminSettingsTable,
  ensureAdminPasswordResetsTable,
  ensureInvoicesTable,
  ensureMediaboxBookingsTable,
};
