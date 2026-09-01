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
});

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS home_images (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slot        ENUM('hero','about-main','about-accent','gallery') NOT NULL,
    category    VARCHAR(40) NULL,
    filename    VARCHAR(255) NOT NULL,
    mime_type   VARCHAR(64) NOT NULL,
    data        MEDIUMBLOB NOT NULL,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_home_images_slot (slot, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Cached promise so every home-images route can safely call this first —
// cheap after the first success, and self-heals if the DB was down at boot.
let ensured = null;
function ensureHomeImagesTable() {
  if (!ensured) {
    ensured = pool.query(CREATE_TABLE_SQL).catch(err => {
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

// id bleibt VARCHAR (nicht AUTO_INCREMENT), weil bestehende IDs wie "c1777494715939"
// direkt den Ordnernamen unter uploads/<id>/ entsprechen — das darf sich nicht ändern.
let ensuredClients = null;
function ensureClientsTable() {
  if (!ensuredClients) {
    ensuredClients = pool.query(CREATE_CLIENTS_TABLE_SQL).catch(err => {
      ensuredClients = null;
      throw err;
    });
  }
  return ensuredClients;
}

module.exports = { pool, ensureHomeImagesTable, ensureClientsTable };
