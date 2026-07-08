# Racesow stats collector — tails the game server's race event log and
# topscores files and pushes results to the web service's ingest API.
# Zero npm dependencies, so no install step.
FROM node:22-alpine

WORKDIR /app
COPY package.json collector.js ./

ENV NODE_ENV=production
CMD ["node", "collector.js"]
