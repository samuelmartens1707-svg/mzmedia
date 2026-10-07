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

const ALT_TEXT_TOOL = {
  name: 'propose_alt_texts',
  description: 'Gibt für jedes gezeigte Bild eine kurze deutsche Bildbeschreibung (Alt-Text) für Website und Google-Bildersuche zurück.',
  input_schema: {
    type: 'object',
    properties: {
      altTexts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            altText: { type: 'string', description: 'Max. 120 Zeichen, sachlich, beschreibt was zu sehen ist.' },
          },
          required: ['id', 'altText'],
        },
        description: 'Genau ein Eintrag pro übergebenem Bild.',
      },
    },
    required: ['altTexts'],
  },
};

// Gemeinsamer Aufruf: Bilder + Text an Claude, erzwungenes Tool → strukturierte Antwort (tool_use.input)
async function callImageTool({ tool, intro, images, imageLabel, maxTokens }) {
  const apiKey = getApiKey();

  const content = [{ type: 'text', text: intro }];
  for (const img of images) {
    content.push({ type: 'text', text: imageLabel(img) });
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
        max_tokens: maxTokens,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
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

  // Sicherheitsfilter können eine Anfrage ablehnen (HTTP 200, stop_reason "refusal")
  if (body?.stop_reason === 'refusal') {
    const err = new Error('Claude hat die Anfrage abgelehnt.');
    err.aiApiError = true;
    throw err;
  }

  const toolUse = (body?.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) {
    const err = new Error('Claude hat keinen verwertbaren Vorschlag zurückgegeben.');
    err.aiApiError = true;
    throw err;
  }
  return { input: toolUse.input || {}, usage: body.usage };
}

// images: [{ id, category, mimeType, base64 }] — base64 sollte bereits verkleinert sein
// (siehe resizeForAi() in server.js), damit Anfragegröße/Kosten niedrig bleiben.
async function proposeGalleryArrangement(images) {
  const { input, usage } = await callImageTool({
    tool: ARRANGEMENT_TOOL,
    intro:
      'Hier sind alle Bilder einer Fotogalerie mit ihrer aktuellen Kategorie. ' +
      'Schlage eine visuell stimmige Reihenfolge vor (z. B. Abwechslung zwischen Hoch- und ' +
      'Querformat, ein starkes Bild am Anfang) und markiere nur die Bilder, deren Kategorie ' +
      'klar nicht zum Bildinhalt passt.',
    images,
    imageLabel: img => `Bild-ID ${img.id} (aktuelle Kategorie: "${img.category || 'Sonstiges'}"):`,
    maxTokens: 2048,
  });
  return {
    order: input.order || [],
    categoryChanges: input.categoryChanges || [],
    note: input.note || '',
    usage,
  };
}

// Alt-Texte für Bilder ohne Beschreibung. context: 'portfolio' | 'mediabox'.
// Liefert nur Vorschläge — gespeichert wird erst, wenn der Admin sie im Panel übernimmt.
async function proposeAltTexts(images, context) {
  const where = context === 'mediabox'
    ? 'Bilder vergangener Events, bei denen die Fotobox „Mediabox“ von mz media (Espelkamp) im Einsatz war'
    : 'Portfolio-Bilder des Fotografen Miguel Zimmermann (mz media) aus Espelkamp, Kreis Minden-Lübbecke';
  const { input, usage } = await callImageTool({
    tool: ALT_TEXT_TOOL,
    intro:
      `Das sind ${where}. Schreibe für jedes Bild einen deutschen Alt-Text (max. 120 Zeichen): ` +
      'sachlich beschreiben, was zu sehen ist (Personen, Situation, Ort/Stimmung), so dass jemand ohne ' +
      'das Bild es sich vorstellen kann und Google es versteht. Nutze die Kategorie als Hinweis auf den Anlass. ' +
      'Keine Namen erfinden, keine Vermutungen über Identitäten, kein „Bild von“/„Foto von“ am Anfang, ' +
      'keine Keyword-Listen. Den Ort nur nennen, wenn er natürlich passt.',
    images,
    imageLabel: img => `Bild-ID ${img.id} (Kategorie: "${img.category || 'Sonstiges'}"):`,
    maxTokens: 4096,
  });
  return {
    altTexts: (input.altTexts || []).map(a => ({ id: a.id, altText: String(a.altText || '').trim().slice(0, 160) })),
    usage,
  };
}

module.exports = { proposeGalleryArrangement, proposeAltTexts };
