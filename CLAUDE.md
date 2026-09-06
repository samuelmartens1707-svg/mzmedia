# mz media – Website Miguel Zimmermann

## Projekt-Überblick
Fotografen-Website für **Miguel Zimmermann** (mz media), Espelkamp. Öffentliche Website + privates Kunden-Fotoportal.
- Domain: `https://www.miguelzimmermann.de/`
- Sprache: Deutsch (gesamte Website und API-Fehlermeldungen auf Deutsch)

## Datei-Struktur
```
public/                 – EINZIGER Ordner, den express.static() öffentlich ausliefert (server.js)
  index.html            – Öffentliche Hauptseite (Hero, Portfolio-Ausschnitt, Services, Mediabox-Teaser, Kontakt)
  galerie.html          – Öffentliche Portfolio-Galerie (alle Bilder, Kategorie-Filter per Datalist, Lightbox)
  gallery.html          – Kunden-Galerie (Login erforderlich, JWT-Auth)
  mediabox.html         – Öffentliche Mediabox-Seite (Fotobox-Vermietung): Anlässe, Event-Galerie, Belegungskalender, Anfrageformular
  admin.html            – Admin-Panel (separates Passwort, noindex)
  impressum.html / datenschutz.html / agb.html – Rechtliche Pflichtseiten (noindex, follow)
  robots.txt / sitemap.xml
  favicon.svg / site.webmanifest / og-image.jpg
  fonts/                – Selbst gehostete Cormorant-Garamond-/DM-Sans-Dateien (.woff2)
server.js       – Express-Server (alle API-Routen)
db.js           – MySQL-Verbindungspool + Auto-Init für home_images, clients, invoices, mediabox_bookings
sevdesk.js      – Anbindung an die sevDesk-Rechnungs-API (Contact/Invoice/Send)
Dockerfile      – Node 20 Alpine, Port 3000
scripts/
  migrate-clients-to-db.js               – Einmalige Migration von data/clients.json in die DB (Legacy)
  add-billing-fields-to-clients.js       – Einmalige Migration: Rechnungsadresse + sevDesk-Kontakt-Cache an clients
  add-mediabox-slot-to-home-images.js    – Einmalige Migration: erweitert home_images.slot um mediabox-hero/mediabox-gallery
data/
  clients.json  – NUR NOCH Backup/Legacy, wird zur Laufzeit nicht mehr gelesen
uploads/
  <clientId>/   – Fotos je Kunde (bis 50 MB, JPEG/PNG/WebP/GIF) — NICHT öffentlich, nur über
                  authentifizierte Routen (/api/photo, /api/download, /api/admin/photo) erreichbar
templates/
  credentials-email.html – E-Mail-Template für Zugangsdaten
```

**Wichtig (Sicherheit):** `server.js` liefert ausschließlich `public/` über `express.static()` aus
(`app.use(express.static(path.join(__dirname, 'public')))`). Alles außerhalb von `public/`
(`server.js`, `db.js`, `package.json`, `scripts/`, `templates/`, `data/`, `uploads/` …) ist damit
nicht mehr per URL abrufbar. Neue öffentlich erreichbare Dateien (Bilder, Fonts, Icons) gehören
immer nach `public/`, alles andere niemals dorthin.

## Tech-Stack
- **Backend:** Node.js + Express 5, CommonJS
- **Auth:** JWT (7d Client, 1d Admin) + bcryptjs
- **Upload:** multer (50 MB Limit für Kundenfotos / 8 MB für Homepage-Bilder, nur Bilder)
- **Datenbank:** MySQL/MariaDB via `mysql2/promise` (`db.js`) — Kunden-Daten (`clients`) und Homepage-Bilder (`home_images`) liegen beide in der DB, analog zur JoTech-Website. Nur die Kundenfotos selbst liegen weiterhin als Dateien unter `uploads/<clientId>/`.
- **Mail:** nodemailer (SMTP via .env)
- **Frontend:** Vanilla HTML/CSS/JS – kein Framework
- **Deployment:** Docker

## Design-System ("Nature Distilled × boho editorial")

### Farb-Tokens (überall identisch in allen 3 HTML-Dateien)
"Waldrand" — Terra bleibt fixer Markenanker, Sage wurde zu einem eigenständigen, satteren Waldgrün
vertieft statt im selben matten Taupe wie Terra mitzuschwimmen (vorher lagen Terra/Clay/Sage/Light-Mid
alle zu nah beieinander). `--light-mid` heißt in gallery.html/admin.html `--light`.
```css
--cream:      #F6F1E4   /* Hintergrund (Warmpapier) */
--sand:       #DCD2B8   /* Borders, dezente Elemente */
--terra:      #B8AEA6   /* Primary-Akzent: Buttons, Hover, Labels — unverändert, Marken-Fixpunkt */
--clay:       #938B85   /* Dunklerer Akzent (Button:hover), an Terra gekoppelt */
--sage:       #46603F   /* Sekundär-Akzent (Waldgrün, eigenständiger Charakter) */
--dark:       #23271F   /* Haupttext (Tannenschwarz) */
--mid:        #6E7A63   /* Sekundärtext, Nav-Links (Moos) */
--light-mid:  #A3AE97   /* Helle Variante (frisches Moos) */
--white:      #FDFAF4   /* Fast-Weiß */
```
Admin-Login-Box (`admin.html`, `.login-box`, liegt auf `--dark`): `#323C2B`.

### Typografie
- **Display/Headlines:** Cormorant Garamond (serif) – Gewichte 300, 400, 600, inkl. kursiv
- **Body/UI:** DM Sans (sans-serif) – Gewichte 300, 400, 500
- Labels: immer `text-transform: uppercase` + breites `letter-spacing` (.14em–.24em)
- Hero-Titel: `clamp(3.8rem, 6.5vw, 6.5rem)`, font-weight 300

### Visuelle Effekte
- **Grain overlay:** SVG-Filter (`body::before`), Opacity ~0.3 – gibt Foto-Film-Feeling
- **Light leak:** Radial-Gradient oben rechts (`body::after`) – Vintage-Effekt
- **Custom Cursor:** Terra-farbener Punkt + Ring (versteckt auf Touch-Geräten)
- **Animationen:** fadeUp + fadeIn beim Page-Load (hero elements)
- **Buttons:** `.btn-primary` (terra bg) / `.btn-ghost` (border-bottom only)
- **Section-Labels:** kleiner terra-farbener Strich vor dem Label-Text

### Admin-Panel (admin.html)
- Dunkles Login-Screen (Hintergrund `--dark`, Box `#3A2A1A`)
- Sidebar-Layout mit `--sidebar-w: 260px`
- Gleiche Token, aber kein Grain/Light-Leak-Effekt

## Server / API
```
POST /api/contact               – Kontaktformular (Rate-Limit 3/min, Honeypot)
POST /api/login                 – Kunden-Login → JWT
GET  /api/my-photos             – Fotos des eingeloggten Kunden (auth)
GET  /api/photo/:id/:file       – Foto abrufen (auth, nur eigene)
GET  /api/download/:id/:file    – Foto-Download (auth, nur eigene)
POST /api/admin/login            – Admin-Login → JWT
POST /api/admin/change-password  – Admin-Passwort ändern (auth, Body: currentPassword/newPassword)
POST /api/admin/forgot-password  – Reset-Link an ADMIN_EMAIL schicken
POST /api/admin/reset-password   – neues Passwort per Reset-Token setzen
GET  /api/admin/clients         – Alle Kunden (ohne passwordHash)
POST /api/admin/clients         – Neuen Kunden anlegen
POST /api/admin/clients/:id/photos       – Fotos hochladen
DELETE /api/admin/clients/:id/photos/:f  – Foto löschen
POST /api/admin/clients/:id/send-email  – Zugangsdaten-Mail senden
POST /api/admin/clients/:id/invoice     – Rechnungsadresse speichern + Rechnung über sevDesk erstellen und versenden
GET  /api/admin/invoices                – Alle bisher versendeten Rechnungen (admin)

GET  /api/home-images                    – Homepage-Bilder (hero/about/galerie), öffentlich
GET  /api/home-image/:id                 – einzelnes Homepage-Bild ausliefern (BLOB), öffentlich
GET  /api/admin/home-images              – Homepage-Bilder-Metadaten (admin, alle Slots inkl. Mediabox)
POST /api/admin/home-images/:slot        – Einzel-Slot hochladen (hero|about-main|about-accent|mediabox-hero, ersetzt vorhandenes)
POST /api/admin/home-images/gallery      – Galerie-Bilder hochladen (beliebig viele, mit Kategorie; Body-Feld "slot" wählt gallery|mediabox-gallery, Default gallery)
PATCH /api/admin/home-images/:id         – Kategorie und/oder Alt-Text (altText) eines Galerie-Bilds ändern (gallery oder mediabox-gallery)
PUT  /api/admin/home-images/:id          – Bilddaten eines vorhandenen Bilds ersetzen (Crop/Rotate-Editor)
POST /api/admin/home-images/:id/move     – Bild rauf/runter sortieren (innerhalb des eigenen Slots)
DELETE /api/admin/home-images/:id        – Bild löschen (Einzel-Slot oder Galerie)

GET  /api/mediabox-images                       – Mediabox-Titelbild + Event-Galerie, öffentlich
GET  /api/mediabox-availability?year=&month=     – belegte Termine eines Monats (nur Datum), öffentlich
GET  /api/admin/mediabox-availability            – volle Belegungsliste inkl. Notiz (admin)
POST /api/admin/mediabox-availability            – Termin als belegt markieren, Body { date, note? } (admin)
DELETE /api/admin/mediabox-availability/:id      – Termin wieder freigeben (admin)
POST /api/mediabox-anfrage                       – Buchungsanfrage der Mediabox-Seite (Rate-Limit 3/min, Honeypot, wie /api/contact)
```

### Homepage-Bilder (DB-Speicherung)
- Hero-, About- und Portfolio-Galerie-Bilder werden als `MEDIUMBLOB` in der Tabelle `home_images` (MySQL) gespeichert, nicht als Dateien — analog zur JoTech-Website, damit Bilder auch bei Neuaufbau des Containers/Dateisystems erhalten bleiben.
- `hero`, `about-main`, `about-accent`, `mediabox-hero` sind feste Einzel-Slots (max. 1 Zeile je Slot, Ersetzen = Löschen + neu Einfügen). `gallery` und `mediabox-gallery` sind unabhängig voneinander sortierbare Listen mit frei vergebbarer Kategorie (Freitext, `VARCHAR(40)`, im Admin-Panel per `<datalist>` als Autocomplete-Vorschläge aus bestehenden Kategorien angeboten — keine feste Werteliste mehr; bei `mediabox-gallery` dient das Feld als "Anlass/Event"-Bezeichnung). `mediabox-hero`/`mediabox-gallery` wurden per `scripts/add-mediabox-slot-to-home-images.js` zum `slot`-Enum hinzugefügt.
- `gallery`-Bilder haben zusätzlich ein optionales `alt_text` (`VARCHAR(160)`, Spalte per `scripts/add-alt-text-to-home-images.js` nachgezogen) — eine echte Bildbeschreibung fürs `alt`-Attribut/die Bildersuche, im Admin-Panel als eigenes Feld neben der Kategorie editierbar. `index.html`/`galerie.html` nutzen `altText || category` als Fallback, falls kein Alt-Text gesetzt ist. Gilt nur für `gallery`-Bilder, nicht für die drei Einzel-Slots (deren `alt` ist fest im Markup von `index.html` verankert).
- `galerie.html` zeigt öffentlich alle `gallery`-Bilder aus `GET /api/home-images`, mit clientseitigem Kategorie-Filter (inkl. `?kategorie=`-Deep-Link) und Lightbox. Nutzt dieselben Daten wie der Portfolio-Ausschnitt auf `index.html` — keine eigene Tabelle/Route.
- `uploads/` (Kundenfotos) sind von dieser Änderung nicht betroffen — die bleiben Dateien.

### Kundendaten (DB-Speicherung, seit dieser Umstellung)
- Kunden (Name, E-Mail, Passwort-Hash, Shooting-Datum/-Art) liegen in der Tabelle `clients` (MySQL), nicht mehr in `data/clients.json`.
- `id` ist `VARCHAR`, kein `AUTO_INCREMENT` — bestehende IDs wie `c1777494715939` entsprechen 1:1 den Ordnernamen unter `uploads/<id>/` und dürfen sich nicht ändern.
- Beide Tabellen (`home_images`, `clients`) werden von `db.js` beim Serverstart automatisch angelegt (`CREATE TABLE IF NOT EXISTS`). Künftige Spalten-Änderungen brauchen ein manuelles `ALTER TABLE`.
- Ist die DB nicht erreichbar, liefern die betroffenen Routen `503` (Homepage-Bilder UND jetzt auch Login/Kunden-Fotoportal/Admin-Kundenverwaltung, da Kundendaten nicht mehr im Dateisystem liegen).
- Migration von der alten `data/clients.json`: `node scripts/migrate-clients-to-db.js` (idempotent, überspringt bereits vorhandene IDs).

### Rechnungen (sevDesk-Integration)
- Rechnungen werden nicht lokal erstellt, sondern über die sevDesk-API (`https://my.sevdesk.de/api/v1`, Anbindung in `sevdesk.js`) angelegt und direkt per E-Mail versendet. Erste ausgehende Drittanbieter-API-Anbindung in diesem Projekt.
- Rechnungsadresse (Straße/PLZ/Ort/Firma, optional) liegt auf `clients` (`company_name`, `billing_street`, `billing_zip`, `billing_city`, `billing_country`), einmalig ergänzt über `node scripts/add-billing-fields-to-clients.js` (manuell auszuführen, idempotent).
- `clients.sevdesk_contact_id` cached die sevDesk-Kontakt-ID, damit derselbe Kunde nicht bei jeder Rechnung einen neuen sevDesk-Kontakt bekommt.
- `invoices` ist ein rein lokales Audit-Log (welche Rechnung, an wen, wann, sevDesk-Rechnungsnummer) für die "Rechnungen"-Übersicht im Admin-Panel — sevDesk selbst bleibt Quelle der Wahrheit für Rechnungsinhalt/PDF.
- Schlägt der sevDesk-API-Call fehl (falscher Token, sevDesk nicht erreichbar, Validierungsfehler), liefert die Route `502` mit deutscher Fehlermeldung — bewusst unterschieden von `503` (eigene Datenbank nicht erreichbar).
- `SEVDESK_API_TOKEN` (.env) wird ausschließlich serverseitig gelesen und nie an das Admin-Frontend zurückgegeben.
- **Wichtig:** Einige statische Referenz-IDs in `sevdesk.js` (Land „Deutschland", Einheit „Stück") sind Platzhalter (`SEVDESK_COUNTRY_ID_DE`, `SEVDESK_UNITY_ID_PIECE`) und müssen vor dem ersten produktiven Einsatz gegen den echten sevDesk-Account verifiziert werden (`GET /StaticCountry`, `GET /Unity`) — siehe Kommentar am Dateianfang von `sevdesk.js`.

### Mediabox (Fotobox-Vermietung)
- Öffentliche Seite `mediabox.html`: erklärt, für welche Anlässe die Mediabox geeignet ist (Hochzeiten, Geburtstage/Jubiläen, Firmenfeiern, Vereinsfeste/Abibälle), zeigt eine Bildergalerie vergangener Events sowie einen Belegungskalender und ein Anfrageformular. Von `index.html` und `galerie.html` verlinkt (Nav + Teaser-Abschnitt auf der Startseite).
- **Bilder:** wiederverwenden `home_images` (Slots `mediabox-hero`, `mediabox-gallery`) — im Admin-Panel unter "Mediabox → Bilder" verwaltet, exakt derselbe Upload-/Editier-/Sortier-Mechanismus wie bei den Homepage-Bildern.
- **Belegungskalender:** eigene Tabelle `mediabox_bookings` (`booked_date` DATE, `note` optional) statt externem Kalenderdienst — bei Mittwald-Mailhosting ist keine Exchange-Kalenderanbindung möglich. Ein Datum ist ganztägig frei oder belegt, keine Uhrzeiten/Zeitslots. Admin trägt belegte Termine unter "Mediabox → Kalender" manuell ein/aus (`/api/admin/mediabox-availability`); die öffentliche Seite fragt pro angezeigtem Monat `GET /api/mediabox-availability?year=&month=` ab und zeigt nur die Daten, keine Notizen.
- **Anfrage:** `POST /api/mediabox-anfrage` spiegelt `/api/contact` (Rate-Limit, Honeypot, `nodemailer`-Versand an `CONTACT_EMAIL`), inkl. optionalem Wunschtermin-Feld. Klick auf einen freien Kalendertag befüllt das Datumsfeld im Formular vor.

### Admin-Passwort (änderbar, mit "Passwort vergessen")
- Bleibt bewusst ein einziges geteiltes Passwort (kein Admin-User-System wie bei JoTech) — nur der Speicherort ist jetzt änderbar statt fest in `.env`.
- Liegt in der Tabelle `admin_settings` (einzige Zeile, `id=1`, `password_hash`). Solange dort keine Zeile existiert, vergleicht der Login weiterhin direkt gegen `process.env.ADMIN_PASSWORD` — Admin-Login funktioniert also auch ohne DB-Verbindung.
- "Passwort ändern" (im Panel unten in der Sidebar) verlangt das aktuelle Passwort und schreibt den neuen Hash in `admin_settings`.
- "Passwort vergessen" (Link auf dem Login-Screen) schickt einen 1h gültigen Reset-Link an `ADMIN_EMAIL` (Fallback: `CONTACT_EMAIL`, dann `SMTP_USER`) — Tokens liegen in `admin_password_resets`. Der Link öffnet `admin.html?reset=TOKEN` mit einem Passwort-Setzen-Formular.
- Da es nur einen Admin-Zugang gibt (keine E-Mail-Eingabe nötig), zeigt `/api/admin/forgot-password` anders als beim Kunden-Flow konkrete Fehler (z. B. „SMTP nicht konfiguriert") statt sich generisch zu geben — es gibt hier nichts zu verheimlichen.

### Wichtige ENV-Variablen (.env)
```
PORT            – Standard 3000
JWT_SECRET      – JWT-Signatur
ADMIN_PASSWORD  – Admin-Panel-Passwort
BASE_PATH       – /website (Reverse-Proxy-Präfix, wird intern gestripped)
SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
MAIL_FROM       – Absender-Adresse
CONTACT_EMAIL   – Empfänger für Kontaktformulare
ADMIN_EMAIL     – Empfänger für Admin-Passwort-Reset-Links (optional, Fallback: CONTACT_EMAIL → SMTP_USER)
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS – MySQL-Zugang (home_images + clients + admin_settings + invoices + mediabox_bookings)
SEVDESK_API_TOKEN – sevDesk → Einstellungen → Benutzer → API-Token (32-stelliger Hex-String, ohne "Bearer"-Präfix)
```

## Deployment
- Docker-Container, Node 20 Alpine
- `BASE_PATH=/website` – alle Routen funktionieren mit diesem Präfix (wird im Server gestripped)
- `uploads/` (Kundenfotos) muss als Volume gemountet sein (Persistenz!) — `data/` wird zur Laufzeit nicht mehr benötigt
- Reverse-Proxy leitet `/website` an Container-Port 3000 weiter

## Stil-Regeln (beim Coden einhalten)
- Alle 3 HTML-Dateien teilen dieselben CSS-Tokens – Änderungen an Farben/Fonts in **allen** Dateien synchron halten
- Kein JS-Framework einführen – bleibt Vanilla
- Keine neuen npm-Pakete ohne Rückfrage (Ausnahme bereits bestätigt: `mysql2` für die Homepage-Bilder-DB)
- Ausgehende Drittanbieter-API-Calls: natives `fetch` (Node 18+) verwenden, kein HTTP-Client-Paket hinzufügen — `sevdesk.js` ist die Referenz-Implementierung für künftige Integrationen (zentraler Fetch-Helper, typisierte Fehler, Basis-URL/Auth an einer Stelle)
- Deutsche Fehlermeldungen und UI-Texte beibehalten
- `cursor: none` auf body (Custom Cursor) – nicht entfernen
