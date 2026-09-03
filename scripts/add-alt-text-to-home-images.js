// Einmalige Migration: fügt ein Alt-Text-Feld pro Bild zur home_images-Tabelle hinzu.
// Aufruf: node scripts/add-alt-text-to-home-images.js
// Idempotent — prüft vor dem ALTER TABLE, ob die Spalte schon existiert.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { pool, ensureHomeImagesTable } = require('../db');

async function columnExists(name) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'home_images' AND column_name = ?`,
    [name]
  );
  return rows[0].cnt > 0;
}

async function main() {
  await ensureHomeImagesTable();
  if (await columnExists('alt_text')) {
    console.log('Spalte alt_text existiert bereits — nichts zu tun.');
  } else {
    await pool.query('ALTER TABLE home_images ADD COLUMN alt_text VARCHAR(160) NULL');
    console.log('Spalte hinzugefügt: alt_text');
  }
  await pool.end();
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});
