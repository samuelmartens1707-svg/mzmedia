FROM node:20-alpine

WORKDIR /app

# Dependencies zuerst (besseres Layer-Caching)
COPY package*.json ./
RUN npm ci --omit=dev

# App-Dateien kopieren
COPY . .

# Ordner für persistente Daten anlegen
RUN mkdir -p data uploads

EXPOSE 3000

CMD ["node", "server.js"]
