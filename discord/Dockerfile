# Racesow Discord announcer — posts new race records to a Discord webhook.
# Zero npm dependencies: the announcer polls the stats API (GET /api/records)
# over fetch(), so there is no native addon to compile.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY announcer.js ./

ENV STATE_PATH=/state/announcer.json

CMD ["node", "announcer.js"]
