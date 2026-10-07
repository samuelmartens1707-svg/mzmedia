// ─── SEO: Bildvarianten, serverseitig eingesetzte Galerie, Sitemap, og-image ─────────
//
// /api/img/:id/:w/:name.webp  – verkleinerte WebP-Variante (w ∈ IMAGE_WIDTHS) eines home_images-Bilds.
//                               Sprechender Dateiname für die Bildersuche, ?v=<data_version> → 1 Jahr cachebar.
// GET / | /index.html | /galerie.html | /mediabox.html
//                             – liefert die HTML-Datei mit bereits eingesetzten Bildern aus (Google und
//                               Browser sehen die Bilder ohne JavaScript; die Seiten-Skripte übernehmen danach wie bisher).
//                               Fällt die DB aus, kommt die unveränderte Datei (express.static).
// /sitemap.xml                – dynamisch, mit lastmod aus der DB und Bilder-Einträgen.
// /og-image.jpg               – 1200×630-Vorschaubild für Social Media, aus dem aktuellen Titelbild erzeugt.

const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');

const SITE_URL     = (process.env.SITE_URL || 'https://miguelzimmermann.de').replace(/\/$/, '');
const IMAGE_WIDTHS = [480, 960, 1600, 2400];
const VARIANT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PUBLIC_DIR   = path.join(__dirname, 'public');

// ── Hilfen ──
function slugify(text) {
  return String(text || 'bild')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'bild';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Standard-Beschreibung, wenn kein Alt-Text gepflegt ist
function defaultAlt(row) {
  if (row.alt_text) return row.alt_text;
  if (row.slot === 'mediabox-gallery') return `${row.category || 'Event'} mit der Mediabox – Fotobox mieten in Espelkamp`;
  return `${row.category || 'Fotografie'} – Miguel Zimmermann, Fotograf in Espelkamp`;
}

// Sprechende Dateinamen für die Bildersuche, wenn kein Alt-Text gepflegt ist
const SLOT_FILE_NAMES = {
  'hero':          'fotograf-espelkamp-miguel-zimmermann',
  'about-main':    'miguel-zimmermann-fotograf-espelkamp',
  'about-accent':  'miguel-zimmermann-fotograf',
  'mediabox-hero': 'fotobox-mieten-espelkamp-mediabox',
};

function variantUrl(row, width) {
  const fallback = SLOT_FILE_NAMES[row.slot] ||
    `${row.category || 'fotografie'} ${row.slot === 'mediabox-gallery' ? 'fotobox' : 'fotograf'} espelkamp`;
  const name = slugify(row.alt_text || fallback);
  return `/api/img/${row.id}/${width}/${name}.webp?v=${row.data_version || 1}`;
}

// Öffentliche Bild-Metadaten für API und eingesetztes HTML
function publicImage(row) {
  return {
    id: row.id,
    category: row.category,
    altText: row.alt_text,
    alt: defaultAlt(row),
    url: `/api/home-image/${row.id}?v=${row.data_version || 1}`, // Original
    src: variantUrl(row, 960),
    full: variantUrl(row, 2400),                                  // Lightbox
    srcset: IMAGE_WIDTHS.map(w => `${variantUrl(row, w)} ${w}w`).join(', '),
  };
}

function setupSeo({ app, pool, ensureHomeImagesTable }) {
  async function loadPublicRows(slots) {
    await ensureHomeImagesTable();
    const [rows] = await pool.query(
      `SELECT id, slot, category, alt_text, sort_order, data_version, updated_at
         FROM home_images WHERE slot IN (?) ORDER BY sort_order ASC, id ASC`,
      [slots]
    );
    return rows;
  }

  // ── Bildvarianten mit kleinem LRU-Cache im Speicher ──
  const cache = new Map(); // key → Buffer (Einfüge-Reihenfolge = LRU)
  let cacheBytes = 0;
  const inflight = new Map();

  function cacheGet(key) {
    const buf = cache.get(key);
    if (buf) { cache.delete(key); cache.set(key, buf); }
    return buf;
  }
  function cacheSet(key, buf) {
    cache.set(key, buf);
    cacheBytes += buf.length;
    for (const [k, b] of cache) {
      if (cacheBytes <= VARIANT_CACHE_MAX_BYTES) break;
      cache.delete(k); cacheBytes -= b.length;
    }
  }

  async function renderVariant(id, width) {
    await ensureHomeImagesTable();
    const [[row]] = await pool.query('SELECT data, data_version FROM home_images WHERE id = ?', [id]);
    if (!row) return null;
    const key = `${id}:${width}:${row.data_version || 1}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const job = sharp(row.data, { failOn: 'none' })
      .rotate() // EXIF-Ausrichtung übernehmen
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: width <= 960 ? 76 : 80 })
      .toBuffer()
      .then(buf => { cacheSet(key, buf); return buf; })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  app.get('/api/img/:id/:w/:name', async (req, res) => {
    const id = Number(req.params.id);
    const width = Number(req.params.w);
    if (!Number.isInteger(id) || !IMAGE_WIDTHS.includes(width)) return res.status(404).end();
    try {
      const buf = await renderVariant(id, width);
      if (!buf) return res.status(404).end();
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      res.end(buf);
    } catch (err) {
      console.error('[img] Variante fehlgeschlagen:', err.message);
      res.status(503).end();
    }
  });

  // ── Bilder serverseitig in die öffentlichen Seiten einsetzen ──
  // Markierungen im HTML: <!--ssr:NAME-->…<!--/ssr:NAME--> (Inhalt wird ersetzt)
  function fillBlock(html, name, inner) {
    const re = new RegExp(`(<!--ssr:${name}-->)[\\s\\S]*?(<!--\\/ssr:${name}-->)`);
    return html.replace(re, `$1${inner}$2`);
  }
  // Ergänzt Attribute am <img id="…"> (Titelbilder etc.) und blendet den Platzhalter aus
  function fillImg(html, imgId, image, { sizes, eager, placeholderId } = {}) {
    if (!image) return html;
    const attrs = ` src="${image.src}" srcset="${image.srcset}" sizes="${sizes}" style="display:block"` +
      (eager ? ' fetchpriority="high"' : '');
    html = html.replace(new RegExp(`(<img\\b[^>]*\\bid="${imgId}")`), `$1${attrs}`);
    if (placeholderId) html = html.replace(new RegExp(`(<div\\b[^>]*\\bid="${placeholderId}")`), '$1 style="display:none"');
    return html;
  }

  // Gleiches Muster wie GALLERY_PATTERN in index.html
  const HOME_PATTERN = [
    { span: 5, ar: '4/5' }, { span: 4, ar: '3/4' }, { span: 3, ar: '2/3' },
    { span: 3, ar: '1' },   { span: 5, ar: '5/4' }, { span: 4, ar: '3/2' },
  ];
  const HOME_GALLERY_SIZES = '(max-width: 960px) 50vw, 40vw';
  const GRID_SIZES = '(max-width: 600px) 50vw, (max-width: 1200px) 33vw, 25vw';

  function homeGalleryHtml(items) {
    return items.map((item, i) => {
      const p = HOME_PATTERN[i % HOME_PATTERN.length];
      const label = item.category || 'Sonstiges';
      return `<article class="gal-item" role="listitem" data-label="${escapeHtml(label)}"
            style="grid-column:span ${p.span};aspect-ratio:${p.ar}"
            aria-label="Fotoprojekt: ${escapeHtml(label)}">
          <div class="gal-inner" role="img" aria-label="${escapeHtml(item.alt)}">
            <img src="${item.src}" srcset="${item.srcset}" sizes="${HOME_GALLERY_SIZES}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async">
          </div>
        </article>`;
    }).join('');
  }

  function gridHtml(items, fallbackLabel) {
    return items.map((item, i) => {
      const label = item.category || fallbackLabel;
      return `<article class="galerie-item" role="listitem" data-index="${i}" data-label="${escapeHtml(label)}" tabindex="0" aria-label="Bild ansehen: ${escapeHtml(item.alt)}">
          <img src="${item.src}" srcset="${item.srcset}" sizes="${GRID_SIZES}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async">
        </article>`;
    }).join('');
  }

  // Liest die Seite frisch von der Platte (klein, OS-Cache) — Änderungen wirken ohne Neustart
  function readPage(file) {
    return fs.promises.readFile(path.join(PUBLIC_DIR, file), 'utf8');
  }

  const PAGES = {
    '/':              'index.html',
    '/index.html':    'index.html',
    '/galerie.html':  'galerie.html',
    '/mediabox.html': 'mediabox.html',
  };

  async function renderPage(file) {
    let html = await readPage(file);
    if (file === 'index.html') {
      const rows = await loadPublicRows(['hero', 'about-main', 'about-accent', 'gallery', 'mediabox-hero']);
      const one = slot => { const r = rows.find(x => x.slot === slot); return r ? publicImage(r) : null; };
      const gallery = rows.filter(r => r.slot === 'gallery').map(publicImage);
      html = fillImg(html, 'heroImgReal', one('hero'), { sizes: '(max-width: 960px) 100vw, 50vw', eager: true, placeholderId: 'heroPlaceholder' });
      html = fillImg(html, 'aboutMainImgReal', one('about-main'), { sizes: '(max-width: 960px) 80vw, 420px' });
      html = fillImg(html, 'aboutAccentImgReal', one('about-accent'), { sizes: '220px' });
      html = fillImg(html, 'mediaboxTeaserImgReal', one('mediabox-hero'), { sizes: '260px', placeholderId: 'mediaboxTeaserPlaceholder' });
      if (gallery.length) html = fillBlock(html, 'gallery', homeGalleryHtml(gallery));
    } else if (file === 'galerie.html') {
      const gallery = (await loadPublicRows(['gallery'])).map(publicImage);
      if (gallery.length) html = fillBlock(html, 'gallery', gridHtml(gallery, 'Sonstiges'));
    } else if (file === 'mediabox.html') {
      const rows = await loadPublicRows(['mediabox-hero', 'mediabox-gallery']);
      const hero = rows.find(r => r.slot === 'mediabox-hero');
      html = fillImg(html, 'mbHeroImgReal', hero && publicImage(hero), { sizes: '(max-width: 960px) 100vw, 50vw', eager: true, placeholderId: 'mbHeroPlaceholder' });
      const gallery = rows.filter(r => r.slot === 'mediabox-gallery').map(publicImage);
      if (gallery.length) html = fillBlock(html, 'gallery', gridHtml(gallery, 'Event'));
    }
    return html;
  }

  app.get(Object.keys(PAGES), async (req, res, next) => {
    try {
      const html = await renderPage(PAGES[req.path]);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.send(html);
    } catch (err) {
      console.warn('[seo] Seite ohne eingesetzte Bilder ausgeliefert:', err.message);
      next(); // express.static liefert die unveränderte Datei
    }
  });

  // ── Sitemap mit Bildern ──
  function isoDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
  }
  function fileDate(file) {
    try { return fs.statSync(path.join(PUBLIC_DIR, file)).mtime; } catch { return new Date(); }
  }

  app.get('/sitemap.xml', async (req, res) => {
    let rows = [];
    try {
      rows = await loadPublicRows(['hero', 'about-main', 'about-accent', 'gallery', 'mediabox-hero', 'mediabox-gallery']);
    } catch (err) {
      console.warn('[seo] Sitemap ohne Bilder:', err.message);
    }
    const latest = (file, slots) => {
      const dates = rows.filter(r => slots.includes(r.slot)).map(r => new Date(r.updated_at));
      return isoDate(new Date(Math.max(fileDate(file), ...dates)));
    };
    const imagesXml = slots => rows.filter(r => slots.includes(r.slot))
      .map(r => `\n    <image:image><image:loc>${SITE_URL}${escapeHtml(variantUrl(r, 1600))}</image:loc></image:image>`).join('');
    const entries = [
      { loc: '/',              file: 'index.html',    slots: ['hero', 'about-main', 'about-accent', 'gallery', 'mediabox-hero'], priority: '1.0', imgs: ['hero', 'about-main', 'about-accent'] },
      { loc: '/galerie.html',  file: 'galerie.html',  slots: ['gallery'],                          priority: '0.9', imgs: ['gallery'] },
      { loc: '/mediabox.html', file: 'mediabox.html', slots: ['mediabox-hero', 'mediabox-gallery'], priority: '0.9', imgs: ['mediabox-hero', 'mediabox-gallery'] },
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.map(e => `  <url>
    <loc>${SITE_URL}${e.loc}</loc>
    <lastmod>${latest(e.file, e.slots)}</lastmod>
    <priority>${e.priority}</priority>${imagesXml(e.imgs)}
  </url>`).join('\n')}
</urlset>
`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  });

  // ── Social-Media-Vorschaubild ──
  let ogCache = { key: null, buf: null };
  app.get('/og-image.jpg', async (req, res) => {
    try {
      const rows = await loadPublicRows(['hero', 'gallery']);
      const row = rows.find(r => r.slot === 'hero') || rows.find(r => r.slot === 'gallery');
      if (!row) return res.status(404).end();
      const key = `${row.id}:${row.data_version || 1}`;
      if (ogCache.key !== key) {
        const [[data]] = await pool.query('SELECT data FROM home_images WHERE id = ?', [row.id]);
        const buf = await sharp(data.data, { failOn: 'none' }).rotate()
          .resize(1200, 630, { fit: 'cover', position: 'attention' })
          .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
        ogCache = { key, buf };
      }
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.end(ogCache.buf);
    } catch (err) {
      console.error('[seo] og-image fehlgeschlagen:', err.message);
      res.status(503).end();
    }
  });

  return { publicImage };
}

module.exports = { setupSeo, publicImage, slugify };
