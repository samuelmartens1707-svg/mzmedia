// Einmaliges Migrationsskript: überträgt data/clients.json in die MySQL-Tabelle `clients`.
// Aufruf: node scripts/migrate-clients-to-db.js
// Bereits vorhandene IDs werden übersprungen (idempotent, kann gefahrlos mehrfach laufen).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const { pool, ensureClientsTable } = require('../db');

const DATA_FILE = path.join(__dirname, '..', 'data', 'clients.json');

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('Keine data/clients.json gefunden — nichts zu migrieren.');
    process.exit(0);
  }

  const { clients } = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  await ensureClientsTable();

  let migrated = 0, skipped = 0;
  for (const c of clients) {
    const [result] = await pool.query(
      `INSERT INTO clients (id, name, email, password_hash, shooting_date, shooting_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [c.id, c.name, c.email, c.passwordHash, c.shootingDate || '', c.shootingType || '']
    );
    if (result.affectedRows > 0) migrated++; else skipped++;
  }

  console.log(`Migration abgeschlossen: ${migrated} übernommen, ${skipped} bereits vorhanden.`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});
