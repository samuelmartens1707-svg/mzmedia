// Migration: fügt Rechnungsadresse + sevDesk-Kontakt-Cache zur clients-Tabelle hinzu.
// Aufruf: node scripts/add-billing-fields-to-clients.js
// Idempotent — prüft vor jedem ALTER TABLE, ob die Spalte schon existiert.
// Hinweis: db.js (ensureClientsTable → ensureColumns) zieht dieselben Spalten inzwischen
// automatisch bei jedem Serverstart nach — dieses Skript ist nur noch für einen manuellen,
// sofortigen Lauf ohne Server-Neustart nötig.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { pool, ensureClientsTable } = require('../db');

const NEW_COLUMNS = [
  { name: 'company_name',       ddl: "ADD COLUMN company_name VARCHAR(160) NOT NULL DEFAULT ''" },
  { name: 'billing_street',     ddl: "ADD COLUMN billing_street VARCHAR(190) NOT NULL DEFAULT ''" },
  { name: 'billing_zip',        ddl: "ADD COLUMN billing_zip VARCHAR(20) NOT NULL DEFAULT ''" },
  { name: 'billing_city',       ddl: "ADD COLUMN billing_city VARCHAR(120) NOT NULL DEFAULT ''" },
  { name: 'billing_country',    ddl: "ADD COLUMN billing_country VARCHAR(2) NOT NULL DEFAULT 'DE'" },
  { name: 'sevdesk_contact_id', ddl: "ADD COLUMN sevdesk_contact_id VARCHAR(32) NOT NULL DEFAULT ''" },
];

async function columnExists(name) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'clients' AND column_name = ?`,
    [name]
  );
  return rows[0].cnt > 0;
}

async function main() {
  await ensureClientsTable();
  let added = 0, skipped = 0;
  for (const col of NEW_COLUMNS) {
    if (await columnExists(col.name)) { skipped++; continue; }
    await pool.query(`ALTER TABLE clients ${col.ddl}`);
    console.log(`Spalte hinzugefügt: ${col.name}`);
    added++;
  }
  console.log(`Migration abgeschlossen: ${added} Spalten hinzugefügt, ${skipped} bereits vorhanden.`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});
