// sevdesk.js — Anbindung an die sevDesk-Rechnungs-API (my.sevdesk.de/api/v1).
// Erste ausgehende Drittanbieter-API-Anbindung in diesem Projekt.
//
// WICHTIG: Die statischen Referenz-IDs unten (SEVDESK_COUNTRY_ID_DE, SEVDESK_UNITY_ID_PIECE,
// SEVDESK_CONTACT_CATEGORY_ID, invoiceType-Enum) stammen aus sevDesk-Blogposts/Drittanbieter-SDKs,
// NICHT aus der offiziellen API-Referenz (JS-SPA, ließ sich nicht direkt abrufen). Vor dem ersten
// echten Einsatz gegen den echten sevDesk-Account verifizieren:
//   GET /StaticCountry  → korrekte id für "Deutschland"
//   GET /Unity          → korrekte id für "Stück"
//   Kontakt-Kategorien im sevDesk-Account → korrekte category id für "Kunde"
// Werte unten anpassen, falls abweichend.

const BASE_URL = 'https://my.sevdesk.de/api/v1';

// TODO verifizieren, siehe Kommentar oben.
const SEVDESK_COUNTRY_ID_DE       = 1;
const SEVDESK_UNITY_ID_PIECE      = 1;
const SEVDESK_CONTACT_CATEGORY_ID = 3;

function getToken() {
  const token = process.env.SEVDESK_API_TOKEN;
  if (!token) {
    const err = new Error('SEVDESK_API_TOKEN ist nicht konfiguriert.');
    err.sevdeskConfigMissing = true;
    throw err;
  }
  return token;
}

// Zentraler Fetch-Helper: Basis-URL, Auth-Header, JSON-Handling, deutschsprachige Fehler.
async function sevdeskFetch(path, opts = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      ...opts,
      headers: {
        'Authorization': token, // sevDesk erwartet den rohen Token, KEIN "Bearer "-Präfix
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  } catch (networkErr) {
    const err = new Error('sevDesk ist aktuell nicht erreichbar: ' + networkErr.message);
    err.sevdeskUnavailable = true;
    throw err;
  }

  let body = null;
  try { body = await res.json(); } catch { /* leerer Body möglich, z.B. bei manchen 204ern */ }

  if (!res.ok) {
    const message = body?.message || body?.error?.message || `sevDesk-Fehler (HTTP ${res.status})`;
    const err = new Error(message);
    err.sevdeskApiError = true;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// sevDesk verpackt Listen-Antworten in { objects: [...] }, Einzel-Objekt-POSTs in { objects: {...} }.
function unwrap(body) { return body?.objects; }

// ── Contact / Address / Communication-Way ──────────────────────────────

async function createContact(client) {
  const isCompany = !!(client.company_name && client.company_name.trim());
  const payload = {
    category: { id: SEVDESK_CONTACT_CATEGORY_ID, objectName: 'Category' },
    type: isCompany ? 'COMPANY' : 'PERSON',
  };
  if (isCompany) {
    payload.name = client.company_name.trim();
  } else {
    const parts = (client.name || '').trim().split(/\s+/);
    payload.surname    = parts.slice(0, -1).join(' ') || parts[0] || client.name;
    payload.familyname = parts.length > 1 ? parts[parts.length - 1] : client.name;
  }
  return unwrap(await sevdeskFetch('/Contact', { method: 'POST', body: JSON.stringify(payload) }));
}

async function createContactAddress(contactId, client) {
  const payload = {
    contact:  { id: contactId, objectName: 'Contact' },
    street:   client.billing_street || '',
    zip:      client.billing_zip || '',
    city:     client.billing_city || '',
    country:  { id: SEVDESK_COUNTRY_ID_DE, objectName: 'StaticCountry' }, // TODO: nur DE unterstützt, siehe Header-Kommentar
    category: { id: SEVDESK_CONTACT_CATEGORY_ID, objectName: 'Category' },
  };
  return unwrap(await sevdeskFetch('/ContactAddress', { method: 'POST', body: JSON.stringify(payload) }));
}

async function createCommunicationWay(contactId, email) {
  const payload = {
    contact: { id: contactId, objectName: 'Contact' },
    type:    'EMAIL',
    value:   email,
    main:    true,
    key:     { id: 1, objectName: 'CommunicationWayKey' }, // TODO verifizieren (E-Mail-Key-ID)
  };
  return unwrap(await sevdeskFetch('/CommunicationWay', { method: 'POST', body: JSON.stringify(payload) }));
}

// Legt einen sevDesk-Kontakt nur an, wenn der Kunde noch keinen hat (client.sevdesk_contact_id).
// Gibt { contactId, isNew } zurück; der Aufrufer (server.js) ist dafür zuständig, isNew=true
// zurück in die clients-Zeile zu schreiben (sevdesk.js kennt db.js absichtlich nicht, um die
// Verantwortlichkeiten sauber zu trennen — reines HTTP-Modul, keine eigene DB-Logik).
async function findOrCreateContact(client) {
  if (client.sevdesk_contact_id) {
    return { contactId: client.sevdesk_contact_id, isNew: false };
  }
  const contact = await createContact(client);
  await createContactAddress(contact.id, client);
  if (client.email) await createCommunicationWay(contact.id, client.email);
  return { contactId: contact.id, isNew: true };
}

// ── Invoice / InvoicePos / Render / Send ────────────────────────────────

async function createInvoice({ contactId, header, invoiceDate, footerText }) {
  const payload = {
    contact:      { id: contactId, objectName: 'Contact' },
    invoiceDate:  invoiceDate || new Date().toISOString().slice(0, 10),
    header:       header || 'Rechnung',
    footerText:   footerText || '',
    status:       100, // Entwurf — wird nach dem Rendern/Senden von sevDesk automatisch aktualisiert
    taxType:      'default', // jede Position trägt ihren eigenen taxRate
    currency:     'EUR',
    invoiceType:  'RE', // TODO verifizieren: normale Rechnung, siehe Header-Kommentar
  };
  return unwrap(await sevdeskFetch('/Invoice', { method: 'POST', body: JSON.stringify(payload) }));
}

async function createInvoicePos(invoiceId, item, position) {
  const payload = {
    invoice:  { id: invoiceId, objectName: 'Invoice' },
    name:     item.description,
    quantity: item.quantity,
    price:    item.unitPrice,
    unity:    { id: SEVDESK_UNITY_ID_PIECE, objectName: 'Unity' }, // TODO verifizieren, siehe Header-Kommentar
    taxRate:  item.vatRate, // vom Admin pro Zeile gesetzt (0 / 7 / 19) — bewusst nicht angenommen
    positionNumber: position,
  };
  return unwrap(await sevdeskFetch('/InvoicePos', { method: 'POST', body: JSON.stringify(payload) }));
}

async function renderInvoice(invoiceId) {
  return unwrap(await sevdeskFetch(`/Invoice/${invoiceId}/render`, { method: 'POST', body: '{}' }));
}

async function sendInvoiceViaEmail(invoiceId, { email } = {}) {
  const payload = {};
  if (email) payload.email = email;
  return unwrap(await sevdeskFetch(`/Invoice/${invoiceId}/sendViaEmail`, {
    method: 'POST', body: JSON.stringify(payload),
  }));
}

// Orchestriert: Rechnung anlegen → Positionen anlegen → PDF rendern → per E-Mail senden.
// Gibt { sevdeskInvoiceId, invoiceNumber } zurück.
async function createAndSendInvoice({ contactId, items, invoiceDate, header, footerText, sendToEmail }) {
  const invoice = await createInvoice({ contactId, header, invoiceDate, footerText });
  let position = 100;
  for (const item of items) {
    await createInvoicePos(invoice.id, item, position);
    position += 100;
  }
  await renderInvoice(invoice.id);
  await sendInvoiceViaEmail(invoice.id, { email: sendToEmail });

  return {
    sevdeskInvoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber || '',
  };
}

module.exports = {
  sevdeskFetch,
  findOrCreateContact,
  createAndSendInvoice,
};
