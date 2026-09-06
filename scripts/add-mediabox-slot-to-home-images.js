// Einmalige Migration: erweitert die slot-ENUM der home_images-Tabelle um 'mediabox-hero'
// und 'mediabox-gallery' (Bilder für die Mediabox-Unterseite, wiederverwenden denselben
// Speicher-/Admin-Mechanismus wie die Homepage-Bilder).
// Aufruf: node scripts/add-mediabox-slot-to-home-images.js
// Idempotent — prüft vor dem ALTER TABLE, ob die Werte schon im Enum enthalten sind.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { pool, ensureHomeImagesTable } = require('../db');

async function getSlotColumnType() {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE AS colType FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'home_images' AND column_name = 'slot'`
  );
  return rows[0]?.colType || '';
}

async function main() {
  await ensureHomeImagesTable();
  const colType = await getSlotColumnType();
  if (colType.includes('mediabox-gallery') && colType.includes('mediabox-hero')) {
    console.log('Migration übersprungen: Enum enthält bereits mediabox-hero/mediabox-gallery.');
    await pool.end();
    return;
  }
  await pool.query(
    `ALTER TABLE home_images MODIFY COLUMN slot
     ENUM('hero','about-main','about-accent','gallery','mediabox-hero','mediabox-gallery') NOT NULL`
  );
  console.log('Migration abgeschlossen: slot-Enum um mediabox-hero/mediabox-gallery erweitert.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});
