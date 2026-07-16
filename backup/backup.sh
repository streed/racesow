#!/bin/sh
# Racesow public database backup.
#
# Produces a sanitized, self-contained PostgreSQL dump of the RACE RECORDS and
# zips it for public download. Everything private is deliberately left out:
#
#   * admin_user / admin_session -> never selected (moderator logins + sessions)
#   * map_flag                   -> never selected (abuse reports, IP hashes)
#   * server.token_hash          -> ingest API tokens, stripped
#   * server.address             -> game-server IP addresses, stripped
#   * mesh keys / INGEST_TOKEN    -> live in env/config, never in the DB at all
#
# The dump is plain SQL (schema + data + sequences, via pg_dump) that restores
# into an empty PostgreSQL 16 database with psql. See README.txt in the archive.
#
# Env:
#   DATABASE_URL   required   libpq connection string to the source database
#   OUT_DIR        /backups   where the published zip + metadata are written
#   BACKUP_KEEP    8          dated archives to retain (older ones are pruned)
set -eu

: "${DATABASE_URL:?set DATABASE_URL}"
OUT_DIR="${OUT_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-8}"
BASENAME="racesow-db"
umask 022

TS="$(date -u +%Y%m%d)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SQL_NAME="${BASENAME}-${TS}.sql"
ZIP_NAME="${BASENAME}-${TS}.zip"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SQL="$WORK/$SQL_NAME"

# The tables that make up the public race record. This is an ALLOW-LIST: any
# table not named here is excluded from the dump entirely, so a future
# moderation/secret table can never silently leak. The intentionally-excluded
# tables today are admin_user, admin_session, map_flag, and map_block
# (moderator accounts/sessions + abuse reports + block decisions). pgmigrations
# is included so a restored DB boots without re-running the schema migrations.
# NOTE: when a NEW race-record table is added to the schema, add it here too.
TABLES="public.config public.version public.map public.player public.canonical public.race public.checkpoint public.run_tally public.player_demo public.player_ghost public.server public.pgmigrations"

echo "[backup] $NOW_ISO building $SQL_NAME"

# 1) Header + the pg_trgm extension the player/map trigram indexes depend on.
#    pg_dump -t does not emit CREATE EXTENSION, so a restore into an empty DB
#    would fail on the gin_trgm_ops indexes without this line up front.
cat > "$SQL" <<EOF
-- Racesow public database backup — RACE RECORDS ONLY.
-- Generated: $NOW_ISO
--
-- Included : races, checkpoints, run tallies, players, maps, versions,
--            per-player replay metadata (demo + ghost), game-server names.
-- EXCLUDED : admin accounts & sessions, ingest API tokens, game-server IP
--            addresses, moderation flags (map_flag). Mesh keys and INGEST_TOKEN
--            never live in the database, so they cannot appear here.
--
-- Restore into an EMPTY PostgreSQL 16 database:
--   createdb racesow
--   psql racesow < $SQL_NAME
-- (or point any fresh racesow instance at the restored database). See README.txt.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

EOF

# 2) Schema + data for the race tables. server DATA is excluded here and
#    re-added sanitized in step 3, but its CREATE TABLE is still emitted so the
#    restored column layout matches a real instance.
TBL_ARGS=""
for t in $TABLES; do TBL_ARGS="$TBL_ARGS -t $t"; done
# shellcheck disable=SC2086
pg_dump "$DATABASE_URL" \
  --no-owner --no-privileges --no-comments \
  $TBL_ARGS \
  --exclude-table-data=public.server \
  >> "$SQL"

# 3) Sanitized game-server rows: id + name + status + counts only. token_hash
#    and address are omitted (left NULL/default on restore). \copy gives native
#    COPY-format escaping so there is no hand-rolled quoting to get wrong. The
#    trailing setval keeps the identity sequence consistent so a restored
#    instance can still enroll new servers without a primary-key collision.
{
  printf '\n-- Sanitized game-server rows (token_hash + address stripped).\n'
  printf 'COPY public.server (id, name, status, created_at, last_seen_at, records) FROM stdin;\n'
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT id, name, status, created_at, last_seen_at, records FROM public.server ORDER BY id) TO STDOUT"
  printf '\\.\n'
  printf "SELECT pg_catalog.setval(pg_get_serial_sequence('public.server','id'), (SELECT COALESCE(MAX(id), 1) FROM public.server), (SELECT COUNT(*) > 0 FROM public.server));\n"
} >> "$SQL"

SQL_BYTES=$(wc -c < "$SQL" | tr -d ' ')

# Best-effort row counts for the public manifest.
count() { psql "$DATABASE_URL" -q -A -t -c "SELECT count(*) FROM $1" 2>/dev/null | tr -d ' '; }
RACES=$(count public.race); PLAYERS=$(count public.player); MAPS=$(count public.map)

# 4) Human README + machine manifest, packed inside the archive.
cat > "$WORK/README.txt" <<EOF
Racesow public database backup
==============================
Generated: $NOW_ISO
File:      $SQL_NAME  (plain PostgreSQL SQL: schema + data + sequences)

This archive contains the public RACE RECORDS from racesow.org so anyone can
run their own instance or analyse the data. It deliberately EXCLUDES:
  * admin/moderator accounts and login sessions
  * ingest API tokens (server.token_hash) and mesh keys
  * game-server IP addresses (server.address)
  * moderation flag reports (map_flag)

Restore into an EMPTY PostgreSQL 16 database:
  createdb racesow
  psql racesow < $SQL_NAME

The dump includes node-pg-migrate's pgmigrations bookkeeping, so a racesow web
instance pointed at the restored database boots without re-running (or
conflicting with) the schema migrations.
EOF

cat > "$WORK/manifest.json" <<EOF
{
  "filename": "$ZIP_NAME",
  "generated_at": "$NOW_ISO",
  "format": "postgresql-plain-sql",
  "sql_file": "$SQL_NAME",
  "sql_bytes": $SQL_BYTES,
  "row_counts": { "race": ${RACES:-0}, "player": ${PLAYERS:-0}, "map": ${MAPS:-0} },
  "included": ["races","checkpoints","run_tally","players","maps","versions","player_demo","player_ghost","server names"],
  "excluded": ["admin_user","admin_session","ingest API tokens","server IP addresses","map_flag","mesh keys"]
}
EOF

# Copy a file into place atomically: write a temp on the SAME filesystem, verify
# it is byte-complete (guards against a truncated copy from a full disk or an
# interrupted write publishing a corrupt zip), then rename — so a reader never
# sees a partial or half-written file.
publish() {
  _src="$1"; _dest="$2"; _tmp="$(dirname "$_dest")/.$(basename "$_dest").tmp"
  cp "$_src" "$_tmp"
  if [ "$(wc -c < "$_tmp" | tr -d ' ')" -ne "$(wc -c < "$_src" | tr -d ' ')" ]; then
    echo "[backup] ERROR: incomplete copy of $(basename "$_dest"), aborting" >&2
    rm -f "$_tmp"
    exit 1
  fi
  mv "$_tmp" "$_dest"
}

# 5) Zip the dated archive, then publish it (and the stable "latest" pointer)
#    into OUT_DIR so a reader (the web server) never sees a half-written file.
( cd "$WORK" && zip -q -9 "$WORK/$ZIP_NAME" "$SQL_NAME" README.txt manifest.json )
publish "$WORK/$ZIP_NAME" "$OUT_DIR/$ZIP_NAME"

ZIP_BYTES=$(wc -c < "$OUT_DIR/$ZIP_NAME" | tr -d ' ')
SHA=$(sha256sum "$OUT_DIR/$ZIP_NAME" | cut -d' ' -f1)

publish "$OUT_DIR/$ZIP_NAME" "$OUT_DIR/${BASENAME}-latest.zip"

cat > "$OUT_DIR/.${BASENAME}-latest.json.tmp" <<EOF
{
  "filename": "$ZIP_NAME",
  "generated_at": "$NOW_ISO",
  "bytes": $ZIP_BYTES,
  "sha256": "$SHA",
  "download_url": "/backup/${BASENAME}-latest.zip",
  "row_counts": { "race": ${RACES:-0}, "player": ${PLAYERS:-0}, "map": ${MAPS:-0} },
  "included": ["races","checkpoints","run_tally","players","maps","versions","player_demo","player_ghost","server names"],
  "excluded": ["admin accounts & sessions","ingest API tokens","game-server IP addresses","moderation flags (map_flag)","mesh keys"]
}
EOF
mv "$OUT_DIR/.${BASENAME}-latest.json.tmp" "$OUT_DIR/${BASENAME}-latest.json"

# 6) Prune old dated archives, keeping the newest $KEEP. The glob's [0-9] guard
#    matches only dated files, never the "latest" pointer.
ls -1t "$OUT_DIR"/${BASENAME}-[0-9]*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "[backup] pruning $(basename "$old")"
  rm -f "$old"
done

echo "[backup] published $ZIP_NAME ($ZIP_BYTES bytes, sha256 $SHA)"
