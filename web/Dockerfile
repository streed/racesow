# Race stats web server — Node.js API + static frontend over the SQLite DB.
FROM node:20-bookworm-slim

# better-sqlite3 ships prebuilt binaries for this platform, but keep build
# tooling available as a fallback for architectures without a prebuild.
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

COPY server.js db.js live.js og-image.js admin.js seed-topscores.js ./
COPY og-assets ./og-assets
COPY public ./public

# The database is provided at runtime via a bind mount / volume (see
# docker-compose.yml). DB_PATH can override the default location.
ENV DB_PATH=/data/db.sqlite
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.js"]
