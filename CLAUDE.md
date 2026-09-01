# mz media – Website Miguel Zimmermann

## Projekt-Überblick
Fotografen-Website für **Miguel Zimmermann** (mz media), Espelkamp. Öffentliche Website + privates Kunden-Fotoportal.
- Domain: `https://www.mzmedia.de/`
- Sprache: Deutsch (gesamte Website und API-Fehlermeldungen auf Deutsch)

## Datei-Struktur
```
index.html      – Öffentliche Hauptseite (Hero, Portfolio, Services, Kontakt)
gallery.html    – Kunden-Galerie (Login erforderlich, JWT-Auth)
admin.html      – Admin-Panel (separates Passwort, noindex)
server.js       – Express-Server (alle API-Routen)
db.js           – MySQL-Verbindungspool + Auto-Init für home_images und clients
Dockerfile      – Node 20 Alpine, Port 3000
scripts/
  migrate-clients-to-db.js – Einmalige Migration von data/clients.json in die DB (Legacy)
data/
  clients.json  – NUR NOCH Backup/Legacy, wird zur Laufzeit nicht mehr gelesen
uploads/
  <clientId>/   – Fotos je Kunde (bis 50 MB, JPEG/PNG/WebP/GIF)
templates/
  credentials-email.html – E-Mail-Template für Zugangsdaten
```

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
```css
--cream:      #F5F0E1   /* Hintergrund */
--sand:       #D4C4A8   /* Borders, dezente Elemente */
--terra:      #B8AEA6   /* Primary-Akzent: Buttons, Hover, Labels */
--clay:       #938B85   /* Dunklerer Akzent (Button:hover) */
--sage:       #8A9A86   /* Sekundär-Akzent (Grün-Ton) */
--dark:       #2A1F14   /* Haupttext */
--mid:        #8A7055   /* Sekundärtext, Nav-Links */
--light-mid:  #B5A08A   /* Helle Variante */
--white:      #FDFAF4   /* Fast-Weiß */
```

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

GET  /api/home-images                    – Homepage-Bilder (hero/about/galerie), öffentlich
GET  /api/home-image/:id                 – einzelnes Homepage-Bild ausliefern (BLOB), öffentlich
GET  /api/admin/home-images              – Homepage-Bilder-Metadaten (admin)
POST /api/admin/home-images/:slot        – Einzel-Slot hochladen (hero|about-main|about-accent, ersetzt vorhandenes)
POST /api/admin/home-images/gallery      – Galerie-Bilder hochladen (beliebig viele, mit Kategorie)
PATCH /api/admin/home-images/:id         – Kategorie eines Galerie-Bilds ändern
POST /api/admin/home-images/:id/move     – Galerie-Bild rauf/runter sortieren
DELETE /api/admin/home-images/:id        – Bild löschen (Einzel-Slot oder Galerie)
```

### Homepage-Bilder (DB-Speicherung)
- Hero-, About- und Portfolio-Galerie-Bilder werden als `MEDIUMBLOB` in der Tabelle `home_images` (MySQL) gespeichert, nicht als Dateien — analog zur JoTech-Website, damit Bilder auch bei Neuaufbau des Containers/Dateisystems erhalten bleiben.
- `hero`, `about-main`, `about-accent` sind feste Einzel-Slots (max. 1 Zeile je Slot, Ersetzen = Löschen + neu Einfügen). `gallery` ist eine beliebig große, sortierbare Liste mit Kategorie (Portrait/Events/Kreativ/Natur).
- `uploads/` (Kundenfotos) sind von dieser Änderung nicht betroffen — die bleiben Dateien.

### Kundendaten (DB-Speicherung, seit dieser Umstellung)
- Kunden (Name, E-Mail, Passwort-Hash, Shooting-Datum/-Art) liegen in der Tabelle `clients` (MySQL), nicht mehr in `data/clients.json`.
- `id` ist `VARCHAR`, kein `AUTO_INCREMENT` — bestehende IDs wie `c1777494715939` entsprechen 1:1 den Ordnernamen unter `uploads/<id>/` und dürfen sich nicht ändern.
- Beide Tabellen (`home_images`, `clients`) werden von `db.js` beim Serverstart automatisch angelegt (`CREATE TABLE IF NOT EXISTS`). Künftige Spalten-Änderungen brauchen ein manuelles `ALTER TABLE`.
- Ist die DB nicht erreichbar, liefern die betroffenen Routen `503` (Homepage-Bilder UND jetzt auch Login/Kunden-Fotoportal/Admin-Kundenverwaltung, da Kundendaten nicht mehr im Dateisystem liegen).
- Migration von der alten `data/clients.json`: `node scripts/migrate-clients-to-db.js` (idempotent, überspringt bereits vorhandene IDs).

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
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS – MySQL-Zugang (home_images + clients + admin_settings)
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
- Deutsche Fehlermeldungen und UI-Texte beibehalten
- `cursor: none` auf body (Custom Cursor) – nicht entfernen
