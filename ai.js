// ai.js — Anbindung an die Anthropic-API (Claude) für den KI-Vorschlag im Admin-Panel
// (Bilder-Reihenfolge/Kategorie-Vorschlag, siehe POST /api/admin/home-images/:slot/ai-suggest
// in server.js). Zweite ausgehende Drittanbieter-API-Anbindung in diesem Projekt, nach demselben
// Muster wie sevdesk.js: natives fetch, kein SDK/HTTP-Client-Paket, zentraler Fetch-Helper,
// typisierte Fehler.
//
// WICHTIG: ANTHROPIC_API_KEY ist ein API-Key von console.anthropic.com (separates, nutzungsbasiert
// abgerechnetes Konto) — NICHT dasselbe wie ein claude.ai-Abo (Pro/Team/Enterprise). Ohne diesen Key
// bleibt der "KI-Vorschlag"-Button im Admin-Panel sichtbar, liefert aber eine klare Fehlermeldung
// statt eines Vorschlags (siehe getApiKey()).
//
// Die KI bekommt hier NIE Schreibzugriff — proposeGalleryArrangement() liefert nur einen Vorschlag
// zurück, den der Admin im Panel erst explizit übernehmen muss (server.js ändert dabei nichts an
// der Datenbank).

const BASE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

const ARRANGEMENT_TOOL = {
  name: 'propose_gallery_arrangement',
  description: 'Schlägt eine visuell stimmige Reihenfolge für die gezeigten Bilder vor und markiert Bilder, deren aktuelle Kategorie nicht zum Bildinhalt passt.',
  input_schema: {
    type: 'object',
    properties: {
      order: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Alle übergebenen Bild-IDs, in der vorgeschlagenen neuen Reihenfolge (jede ID genau einmal).',
      },
      categoryChanges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            newCategory: { type: 'string' },
          },
          required: ['id', 'newCategory'],
        },
        description: 'Nur Bilder, deren Kategorie geändert werden sollte. Leeres Array, wenn keine Änderung nötig ist.',
      },
      note: {
        type: 'string',
        description: 'Kurze, für den Admin verständliche Begründung auf Deutsch (1-2 Sätze).',
      },
    },
    required: ['order', 'categoryChanges', 'note'],
  },
};

function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY ist nicht konfiguriert.');
    err.aiConfigMissing = true;
    throw err;
  }
  return key;
}

// images: [{ id, category, mimeType, base64 }] — base64 sollte bereits verkleinert sein
// (siehe resizeForAi() in server.js), damit Anfragegröße/Kosten niedrig bleiben.
async function proposeGalleryArrangement(images) {
  const apiKey = getApiKey();

  const content = [
    {
      type: 'text',
      text:
        'Hier sind alle Bilder einer Fotogalerie mit ihrer aktuellen Kategorie. ' +
        'Schlage eine visuell stimmige Reihenfolge vor (z. B. Abwechslung zwischen Hoch- und ' +
        'Querformat, ein starkes Bild am Anfang) und markiere nur die Bilder, deren Kategorie ' +
        'klar nicht zum Bildinhalt passt.',
    },
  ];
  for (const img of images) {
    content.push({
      type: 'text',
      text: `Bild-ID ${img.id} (aktuelle Kategorie: "${img.category || 'Sonstiges'}"):`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
    });
  }

  let res;
  try {
    res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        tools: [ARRANGEMENT_TOOL],
        tool_choice: { type: 'tool', name: 'propose_gallery_arrangement' },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (networkErr) {
    const err = new Error('Claude-API ist aktuell nicht erreichbar: ' + networkErr.message);
    err.aiUnavailable = true;
    throw err;
  }

  let body = null;
  try { body = await res.json(); } catch { /* leerer Body möglich */ }

  if (!res.ok) {
    const message = body?.error?.message || `Claude-API-Fehler (HTTP ${res.status})`;
    const err = new Error(message);
    err.aiApiError = true;
    err.status = res.status;
    throw err;
  }

  const toolUse = (body?.content || []).find(
    b => b.type === 'tool_use' && b.name === 'propose_gallery_arrangement'
  );
  if (!toolUse) {
    const err = new Error('Claude hat keinen verwertbaren Vorschlag zurückgegeben.');
    err.aiApiError = true;
    throw err;
  }

  return {
    order: toolUse.input.order || [],
    categoryChanges: toolUse.input.categoryChanges || [],
    note: toolUse.input.note || '',
    usage: body.usage,
  };
}

module.exports = { proposeGalleryArrangement };
