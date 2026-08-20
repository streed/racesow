# Race stats web server — Node.js API + static frontend over PostgreSQL.
FROM node:20-bookworm-slim

# The runtime driver is pg (pure JS). better-sqlite3 is a dependency only for
# the one-time migrate-sqlite-to-pg.js tool, and it needs a build toolchain on
# platforms without a prebuilt binary — installed then purged in one layer.
ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# instrument.mjs is the Sentry bootstrap loaded via `--import` in the CMD below
# (must run before server.js under ESM) — keep it first in this explicit list.
COPY instrument.mjs server.js db.js mapname.js blog.js seed-map-catalog.js achievements.js tournaments.js censor.js live.js streams.js og-image.js cache.js admin.js rcon.js seed-topscores.js heatmap.js bsp.js mapindex.js mappack.js weapons.js scan-map-weapons.js migrate-sqlite-to-pg.js ./
# One-off demo import (web/import-demo.mjs + its replayer). Baked in rather than
# bind-mounted like demo-meta.mjs because it needs `pg` from this image's
# node_modules: `docker compose run --rm web node import-demo.mjs <file>`.
COPY demo-replay.mjs import-demo.mjs ./
COPY migrations ./migrations
COPY og-assets ./og-assets
COPY public ./public

# Runtime store is Postgres via DATABASE_URL (see docker-compose.yml). The
# legacy /data/db.sqlite path is read ONLY by the one-time migration tool
# (docker compose run --rm web node migrate-sqlite-to-pg.js /data/db.sqlite).
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
# --import loads the Sentry SDK (instrument.mjs) before server.js so it can wrap
# http/express/pg under ESM. Harmless no-op when SENTRY_DSN is unset.
CMD ["node", "--import", "./instrument.mjs", "server.js"]
