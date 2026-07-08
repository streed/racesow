# Racesow Discord announcer — posts new race records to a Discord webhook.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY announcer.js ./

ENV DB_PATH=/data/db.sqlite
ENV STATE_PATH=/state/announcer.json

CMD ["node", "announcer.js"]
