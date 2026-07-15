#!/usr/bin/env bash
# setup.sh — guided installer for a Racesow deployment.
#
# Two install modes:
#
#   agent — game server ONLY, feeding records to someone else's central
#           stats site. Asks for the ingest URL and the per-server token
#           the central admin gave you (see AGENT.md), then brings up
#           docker-compose.agent.yml. No database, no website.
#
#   full  — everything on this box: stats website + Discord announcer +
#           game server, wired to talk to each other over the compose
#           network. Enrolls the game server's per-server ingest token
#           against the local site automatically and seeds the in-game
#           `top` lists from the database.
#
# Usage:
#   scripts/setup.sh          # interactive mode menu
#   scripts/setup.sh agent    # game server only
#   scripts/setup.sh full     # website + game server
#
# Safe to re-run: it rewrites the .env files it owns and re-ups the same
# compose projects (a re-run in full mode enrolls a fresh token; old tokens
# stay valid until revoked with `node admin.js revoke`).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

say()  { printf '>> %s\n' "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# ask VAR "Prompt" "default" — reads into VAR, keeping the default on empty.
ask() {
    local __var="$1" __prompt="$2" __default="${3:-}" __answer
    if [ -n "${__default}" ]; then
        read -r -p "${__prompt} [${__default}]: " __answer
        printf -v "${__var}" '%s' "${__answer:-${__default}}"
    else
        read -r -p "${__prompt}: " __answer
        printf -v "${__var}" '%s' "${__answer}"
    fi
}

confirm() {  # confirm "Question" [y|n]  — default answer as 2nd arg
    local __default="${2:-y}" __answer
    read -r -p "$1 [$([ "${__default}" = y ] && echo Y/n || echo y/N)]: " __answer
    __answer="${__answer:-${__default}}"
    case "${__answer}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- Mode -------------------------------------------------------------------
MODE="${1:-}"
if [ -z "${MODE}" ]; then
    echo "Racesow setup — what should run on this machine?"
    echo "  1) agent — game server only, pushing records to a remote stats site"
    echo "  2) full  — stats website + Discord announcer + game server"
    ask MODE "Choose 1 or 2" ""
    case "${MODE}" in 1) MODE=agent ;; 2) MODE=full ;; esac
fi
case "${MODE}" in agent|full) ;; *) die "unknown mode '${MODE}' (agent|full)" ;; esac
say "install mode: ${MODE}"

# --- Docker -----------------------------------------------------------------
# Everything runs in containers; make sure docker + compose v2 exist and are
# usable by this user (falling back to sudo for this run right after a fresh
# install, before the docker group membership takes effect).
DOCKER="docker"
ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        command -v apt-get >/dev/null 2>&1 \
            || die "docker is not installed; install Docker + the compose v2 plugin, then re-run"
        confirm "Docker is not installed. Install it now via apt (needs sudo)?" \
            || die "docker is required"
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
            docker.io docker-compose-v2 docker-buildx curl unzip
        sudo usermod -aG docker "$(id -un)"
        say "docker installed; group membership applies on next login"
    fi
    if docker info >/dev/null 2>&1; then
        DOCKER="docker"
    elif sudo -n docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; then
        DOCKER="sudo docker"
        say "using 'sudo docker' for this run (log out/in to use docker directly)"
    else
        die "cannot talk to the docker daemon (try: newgrp docker, or re-login)"
    fi
    ${DOCKER} compose version >/dev/null 2>&1 || die "docker compose v2 is required"
}
ensure_docker

# --- Questions common to both modes -----------------------------------------
ask SV_HOSTNAME   "Server name (shown in the in-game server browser)" "Racesow Community Server"
ask SV_MAXCLIENTS "Max players" "16"
# sv_public 0 does more than skip the master list: the engine silently
# ignores queries from non-LAN addresses, so the server looks dead from the
# internet. Only choose 0 for a LAN/dev box.
if confirm "Internet-facing server (sv_public 1 — master list + answers remote queries)?" y; then
    SV_PUBLIC=1
else
    SV_PUBLIC=0
    say "LAN/dev mode: the server will NOT answer queries from the internet"
fi
DEFAULT_RCON="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24)"
ask RCON_PASSWORD "rcon password (empty disables rcon)" "${DEFAULT_RCON}"

# --- Map packs ----------------------------------------------------------------
# Both modes mount server/maps into the game server. The full livesow mirror
# is ~12.5 GB; without it the server rotates only the handful of stock maps.
offer_maps() {
    local have
    have=$(find server/maps -maxdepth 1 -name '*.pk3' 2>/dev/null | wc -l)
    say "map packs present in server/maps: ${have}"
    if confirm "Download the community race map mirror now (~12.5 GB from livesow.net)?" \
            "$([ "${have}" -gt 100 ] && echo n || echo y)"; then
        scripts/fetch-maps.sh --jobs 8 --no-restart || say "WARNING: some packs failed; re-run scripts/fetch-maps.sh later to retry"
    else
        say "skipped — run scripts/fetch-maps.sh anytime; new packs load on the next server restart"
    fi
}

# ============================================================================
# agent mode
# ============================================================================
if [ "${MODE}" = "agent" ]; then
    echo
    say "The central stats site admin must enroll your server and give you a"
    say "token + ingest URL (see AGENT.md). Records you push are attributed"
    say "to that token."
    ask INGEST_URL   "Ingest URL (https://<stats-site>/api/ingest)" ""
    case "${INGEST_URL}" in http://*|https://*) ;; *) die "INGEST_URL must start with http:// or https://" ;; esac
    ask INGEST_TOKEN "Per-server ingest token" ""
    [ -n "${INGEST_TOKEN}" ] || die "the ingest token is required (ask the central site admin)"

    cat > .env <<EOF
# Generated by scripts/setup.sh (agent mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Game-server agent: pushes race finishes to the central stats site.
INGEST_URL=${INGEST_URL}
INGEST_TOKEN=${INGEST_TOKEN}
SV_HOSTNAME=${SV_HOSTNAME}
SV_MAXCLIENTS=${SV_MAXCLIENTS}
SV_PUBLIC=${SV_PUBLIC}
RCON_PASSWORD=${RCON_PASSWORD}
EOF
    chmod 600 .env
    say "wrote .env"

    offer_maps

    say "building + starting the game server (first build downloads Warsow ~465 MB)"
    ${DOCKER} compose -f docker-compose.agent.yml up -d --build
    sleep 5
    ${DOCKER} logs warsow-race 2>&1 | grep -E "hostname|first map|map pool" | head -3 || true
    echo
    say "agent install done — game server on UDP ${SV_PORT:-44400}"
    say "open UDP 44400 in your firewall; check logs with: docker logs -f warsow-race"
    say "optional: systemd/install.sh agent  (explicit boot-time bring-up unit)"
    exit 0
fi

# ============================================================================
# full mode
# ============================================================================

# --- The race database -------------------------------------------------------
# data/db.sqlite is stored in Git LFS; without git-lfs a clone only has a tiny
# pointer file and the website cannot open it.
if [ "$(head -c 15 data/db.sqlite 2>/dev/null)" != "SQLite format 3" ]; then
    say "data/db.sqlite is missing or still a Git-LFS pointer file"
    command -v git-lfs >/dev/null 2>&1 || command -v git >/dev/null 2>&1 \
        || die "install git-lfs, then run: git lfs install && git lfs pull"
    confirm "Fetch it now with git lfs pull?" || die "the website needs data/db.sqlite"
    git lfs install --skip-repo >/dev/null 2>&1 || true
    git lfs pull
    [ "$(head -c 15 data/db.sqlite)" = "SQLite format 3" ] || die "git lfs pull did not produce a usable data/db.sqlite"
fi

ask DISCORD_WEBHOOK_URL "Discord webhook URL for record announcements (empty = dry-run)" ""

# COMPOSE_PROJECT_NAME pins the compose network to racesow_default no matter
# what the checkout directory is called — server/docker-compose.yml joins that
# network by name so the game server can reach the web container directly.
cat > .env <<EOF
# Generated by scripts/setup.sh (full mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ).
COMPOSE_PROJECT_NAME=racesow
# Ingest auth uses per-server tokens (enrolled below, stored in server/.env);
# the shared-secret fallback stays disabled.
INGEST_TOKEN=
SERVER_NAME=${SV_HOSTNAME}
DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}
EOF
chmod 600 .env
say "wrote .env"

say "building + starting the stats website and Discord announcer"
${DOCKER} compose up -d --build

say "waiting for the website to come up"
for i in $(seq 1 30); do
    if curl -fsS http://localhost:8080/api/health 2>/dev/null | grep -q '"ok":true'; then
        break
    fi
    [ "$i" = 30 ] && die "web did not become healthy; check: docker logs racesow-web"
    sleep 2
done
say "website is healthy at http://localhost:8080"

# --- Enroll the co-located game server against the local site ----------------
say "enrolling the game server for direct-to-API race reporting"
ENROLL_OUT="$(${DOCKER} compose exec -T web node admin.js enroll "${SV_HOSTNAME}")"
INGEST_TOKEN="$(printf '%s\n' "${ENROLL_OUT}" | sed -n 's/^[[:space:]]*INGEST_TOKEN=//p' | head -1)"
printf '%s\n' "${INGEST_TOKEN}" | grep -qE '^[0-9a-f]{64}$' \
    || die "could not parse the enrolled token from admin.js output:
${ENROLL_OUT}"

cat > server/.env <<EOF
# Generated by scripts/setup.sh (full mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ).
SV_HOSTNAME=${SV_HOSTNAME}
SV_MAXCLIENTS=${SV_MAXCLIENTS}
SV_PUBLIC=${SV_PUBLIC}
RCON_PASSWORD=${RCON_PASSWORD}
# Direct-to-API race reporting over the compose network (racesow_default).
INGEST_URL=http://web:8080/api/ingest
INGEST_TOKEN=${INGEST_TOKEN}
EOF
chmod 600 server/.env
say "wrote server/.env (token shown once above is stored there)"

# --- Host dirs the game server writes as uid 999 -----------------------------
# The container's warsow user must be able to write records + the race event
# audit log; a fresh clone leaves these owned by the current user.
for d in server/topscores server/racelog; do
    mkdir -p "$d"
    if sudo -n true 2>/dev/null || sudo -v 2>/dev/null; then
        sudo chown -R 999:999 "$d"
    else
        chmod -R a+rwX "$d"
        say "WARNING: no sudo — made $d world-writable instead of chowning to uid 999"
    fi
done

offer_maps

# --- Seed the in-game top lists from the database ----------------------------
if confirm "Seed the in-game 'top' record lists from data/db.sqlite (recommended)?"; then
    scripts/seed-server.sh --no-restart || say "WARNING: seeding failed; run scripts/seed-server.sh later"
fi

say "building + starting the game server (first build downloads Warsow ~465 MB)"
( cd server && ${DOCKER} compose up -d --build )
sleep 5
${DOCKER} logs warsow-race 2>&1 | grep -E "hostname|first map|map pool" | head -3 || true

echo
say "full install done:"
say "  stats site : http://localhost:8080  (put a TLS reverse proxy in front for production)"
say "  game server: UDP 44400 — open it (plus 80/443 for the site) in your firewall"
say "  discord    : $( [ -n "${DISCORD_WEBHOOK_URL}" ] && echo announcing new records || echo dry-run mode — set DISCORD_WEBHOOK_URL in .env to enable )"
say "  logs       : docker logs -f warsow-race | racesow-web | racesow-discord"
say "  optional   : systemd/install.sh full — boot ordering + nightly DB backups"
