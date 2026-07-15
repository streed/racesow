#!/usr/bin/env bash
# seed-server.sh — seed the game server's per-map topscores from data/db.sqlite.
#
# Exports each map's top-50 (best time per canonical player) from the central
# race database into server/topscores/race/<map>.txt in the exact format the
# hrace racemod reads, so a freshly deployed game server knows every existing
# record: the in-game `top` list is populated, the HUD shows the real #1, and
# "server record" announcements only fire for genuine improvements.
#
# Safe by design:
#   - merge-only: an on-disk record that beats the DB time for the same nick
#     is kept (the seeder never destroys a record; see web/seed-topscores.js)
#   - idempotent: rerunning writes nothing when the files are already current
#   - the current topscores dir is archived into backups/ before any change
#
# Usage:
#   scripts/seed-server.sh            # merge DB records into the topscores dir
#   scripts/seed-server.sh --wipe     # clear topscores first (true initial seed)
#   scripts/seed-server.sh --no-restart   # don't restart the game server after
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TOPSCORES_DIR="${REPO_ROOT}/server/topscores/race"
BACKUP_DIR="${REPO_ROOT}/backups"

WIPE=0
RESTART=1
for arg in "$@"; do
    case "${arg}" in
        --wipe)       WIPE=1 ;;
        --no-restart) RESTART=0 ;;
        -h|--help)    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: ${arg} (try --help)" >&2; exit 2 ;;
    esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
say() { printf '>> %s\n' "$*"; }

# --- Preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed / not in PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
[ -d "${REPO_ROOT}/server" ] || die "server/ directory missing — run from a full clone"

cd "${REPO_ROOT}"

# The seeder runs on the racesow-web image; build it if it doesn't exist yet.
if ! docker image inspect racesow-web:latest >/dev/null 2>&1; then
    say "racesow-web image not built yet — building"
    docker compose build web
fi

# The data source is the central Postgres, not a file. Require it to be up and
# populated, or the seeder would produce empty topscores and abort at line ~75.
races=$(docker compose exec -T postgres psql -U racesow -d racesow -qtA -c "SELECT COUNT(*) FROM race" 2>/dev/null | tr -d '[:space:]' || true)
case "${races}" in
    ''|*[!0-9]*) die "cannot reach Postgres (is 'docker compose up -d' running?)" ;;
    0)           die "Postgres has no races — run the migration first: docker compose run --rm web node migrate-sqlite-to-pg.js /data/db.sqlite" ;;
esac
say "central database has ${races} races"

mkdir -p "${TOPSCORES_DIR}" "${BACKUP_DIR}"

# --- Archive the current topscores before touching anything -------------------
existing=$(find "${TOPSCORES_DIR}" -name '*.txt' 2>/dev/null | wc -l)
if [ "${existing}" -gt 0 ]; then
    archive="${BACKUP_DIR}/topscores-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "${archive}" -C "${TOPSCORES_DIR}" .
    say "archived ${existing} existing topscores file(s) to ${archive}"
fi

if [ "${WIPE}" = "1" ] && [ "${existing}" -gt 0 ]; then
    say "wiping ${existing} existing topscores file(s) (--wipe)"
    find "${TOPSCORES_DIR}" -name '*.txt' -delete
fi

# --- Seed ---------------------------------------------------------------------
say "seeding topscores from the central Postgres database (merge-only, idempotent)"
docker compose --profile seed run --rm seed-topscores

seeded=$(find "${TOPSCORES_DIR}" -name '*.txt' | wc -l)
[ "${seeded}" -gt 0 ] || die "no topscores files were produced — is the database empty?"

# Spot-check one file for the expected format ("finishMs" "name" "N" ...).
# (-print -quit instead of "| head -1": under pipefail, head closing the pipe
# early makes find exit 141 and set -e would abort the script here.)
sample=$(find "${TOPSCORES_DIR}" -name '*.txt' -size +100c -print -quit)
if [ -n "${sample}" ] && ! grep -qE '^"[0-9]+" ".+" "[0-9]+"' "${sample}"; then
    die "seeded file ${sample} does not look like a valid topscores file"
fi
say "seeded/verified: ${seeded} map file(s) in server/topscores/race/"

# --- Reload the game server so already-loaded maps re-read their files --------
if [ "${RESTART}" = "1" ]; then
    if docker compose -f server/docker-compose.yml ps --status running 2>/dev/null | grep -q warsow-race; then
        say "restarting the game server to load the seeded records"
        docker compose -f server/docker-compose.yml restart warsow-race
    else
        say "game server not running — records load when it starts"
    fi
else
    say "skipping game-server restart (--no-restart)"
fi

say "done"
