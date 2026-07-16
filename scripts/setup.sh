#!/usr/bin/env bash
# setup.sh — guided installer for a Racesow deployment.
#
# Two install modes:
#
#   agent — game server ONLY, feeding records to someone else's central
#           stats site. Needs the ingest URL + the per-server token the
#           central admin gave you (see AGENT.md), then brings up
#           docker-compose.agent.yml. No database, no website.
#
#   full  — everything on this box: stats website + Discord announcer +
#           game server, wired to talk to each other over the compose
#           network. Enrolls the game server's per-server ingest token
#           against the local site automatically and seeds the in-game
#           `top` lists from the database.
#
# Usage:
#   scripts/setup.sh                     # interactive mode menu
#   scripts/setup.sh agent               # game server only
#   scripts/setup.sh full                # website + game server
#   scripts/setup.sh --non-interactive [agent|full]
#                                        # no prompts; read config from the
#                                        # environment / $RACESOW_CONFIG file
#                                        # (default /etc/racesow/deploy.env).
#                                        # This is the path scripts/cloud-init.sh
#                                        # drives on a fresh cloud VM.
#
# Non-interactive config keys (env or the deploy.env file): RACESOW_MODE,
# INGEST_URL, INGEST_TOKEN (required for agent), MIRROR_PEERS/MIRROR_SECRET/
# MIRROR_TAG (the cross-server mesh), SV_HOSTNAME, SV_MAXCLIENTS, SV_PUBLIC,
# RCON_PASSWORD, DISCORD_WEBHOOK_URL, DOWNLOAD_MAPS, SEED_DATABASE. Only the
# api token and (optionally) the mesh must be supplied — everything else
# defaults or is generated.
#
# Safe to re-run: it rewrites the .env files it owns and re-ups the same
# compose projects (a re-run in full mode enrolls a fresh token; old tokens
# stay valid until revoked with `node admin.js revoke`).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# say/die/have + all the shared install actions (rs_write_*_env, rs_resolve_docker,
# rs_enroll_token, rs_fix_host_dirs, rs_wait_web_healthy, rs_fetch_maps, ...).
# shellcheck source=scripts/lib/common.sh
. "${REPO_ROOT}/scripts/lib/common.sh"

# ask VAR "Prompt" "default" — reads into VAR, keeping the default on empty.
# In non-interactive mode it keeps an already-set (exported) value, else the
# default — so environment / deploy.env config flows through unchanged.
ask() {
    local __var="$1" __prompt="$2" __default="${3:-}" __answer
    if [ -n "${NONINTERACTIVE:-}" ]; then
        __answer="${!__var:-}"
        printf -v "${__var}" '%s' "${__answer:-${__default}}"
        return
    fi
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
    # Non-interactive: take the default without prompting.
    if [ -n "${NONINTERACTIVE:-}" ]; then
        case "${__default}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
    fi
    read -r -p "$1 [$([ "${__default}" = y ] && echo Y/n || echo y/N)]: " __answer
    __answer="${__answer:-${__default}}"
    case "${__answer}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# truthy VALUE — treat 1/yes/true/on (any case) as yes, everything else as no.
truthy() { case "${1:-}" in 1|y|Y|yes|YES|true|TRUE|on|ON) return 0 ;; *) return 1 ;; esac }

# --- Args: mode + non-interactive flag --------------------------------------
NONINTERACTIVE="${RACESOW_NONINTERACTIVE:-}"
MODE=""
for arg in "$@"; do
    case "${arg}" in
        -y|--yes|--non-interactive) NONINTERACTIVE=1 ;;
        agent|full)                 MODE="${arg}" ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument: ${arg} (agent|full, --non-interactive)" ;;
    esac
done

# Non-interactive: load the config file (KEY=VALUE) up front so RACESOW_MODE and
# the rest are in the environment before we resolve anything.
if [ -n "${NONINTERACTIVE:-}" ]; then
    CONFIG_FILE="${RACESOW_CONFIG:-/etc/racesow/deploy.env}"
    if [ -f "${CONFIG_FILE}" ]; then
        rs_load_env_file "${CONFIG_FILE}"   # docker-.env semantics: no shell eval
        say "loaded config from ${CONFIG_FILE}"
    fi
fi

# --- Mode -------------------------------------------------------------------
[ -n "${MODE}" ] || MODE="${RACESOW_MODE:-}"
if [ -z "${MODE}" ]; then
    if [ -n "${NONINTERACTIVE:-}" ]; then
        MODE=agent           # default shape for a fresh box: a game-server agent
    else
        echo "Racesow setup — what should run on this machine?"
        echo "  1) agent — game server only, pushing records to a remote stats site"
        echo "  2) full  — stats website + Discord announcer + game server"
        ask MODE "Choose 1 or 2" ""
        case "${MODE}" in 1) MODE=agent ;; 2) MODE=full ;; esac
    fi
fi
case "${MODE}" in agent|full) ;; *) die "unknown mode '${MODE}' (agent|full)" ;; esac
say "install mode: ${MODE}$([ -n "${NONINTERACTIVE:-}" ] && echo ' (non-interactive)')"

# --- Docker -----------------------------------------------------------------
# Everything runs in containers; make sure docker + compose v2 exist and are
# usable by this user (falling back to sudo for this run right after a fresh
# install, before the docker group membership takes effect).
ensure_docker() {
    if ! have docker; then
        confirm "Docker is not installed. Install it now via apt (needs sudo)?" \
            || die "docker is required"
        rs_apt_install docker.io docker-compose-v2 docker-buildx curl unzip
        sudo usermod -aG docker "$(id -un)" || true
        say "docker installed; group membership applies on next login"
    fi
    rs_resolve_docker
}
ensure_docker

# --- Gather configuration ----------------------------------------------------
if [ -n "${NONINTERACTIVE:-}" ]; then
    rs_config_defaults
    say "using configuration from environment / defaults (hostname: ${SV_HOSTNAME})"
else
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
    ask RCON_PASSWORD "rcon password (empty disables rcon)" "$(rs_gen_rcon)"

    # Cross-server player mesh (optional): peers exchange live positions + chat.
    # The shared secret must be IDENTICAL on every peer, so you supply it.
    echo
    say "Cross-server player mesh — link this server to others so players see"
    say "each other as ghosts and chat across servers (leave peers blank to skip)."
    ask MIRROR_PEERS "Mesh peers, space-separated host:44450 (blank = standalone)" ""
    if [ -n "${MIRROR_PEERS}" ]; then
        ask MIRROR_SECRET "Mesh shared secret (the SAME value on every peer)" ""
        [ -n "${MIRROR_SECRET}" ] || die "a mesh with peers needs MIRROR_SECRET (same on all peers)"
        ask MIRROR_TAG    "Mesh tag shown as [TAG] in cross-server chat" ""
    fi
    rs_config_defaults   # backfill SV_PORT / MIRROR_PORT / VERSION_NAME / etc.
fi

# A mesh with peers is useless (HMAC fails) without the shared secret.
if [ -n "${MIRROR_PEERS}" ] && [ -z "${MIRROR_SECRET}" ]; then
    die "MIRROR_PEERS is set but MIRROR_SECRET is empty — the mesh needs the shared secret"
fi

# --- Map packs ----------------------------------------------------------------
# Both modes mount server/maps into the game server. The full livesow mirror
# is ~12.5 GB; without it the server rotates only the handful of stock maps.
offer_maps() {
    local have_packs
    have_packs=$(find server/maps -maxdepth 1 -name '*.pk3' 2>/dev/null | wc -l)
    say "map packs present in server/maps: ${have_packs}"
    if [ -n "${NONINTERACTIVE:-}" ]; then
        if truthy "${DOWNLOAD_MAPS:-1}"; then
            rs_fetch_maps --jobs 8 --no-restart
        else
            say "skipping the map mirror (DOWNLOAD_MAPS is off)"
        fi
        return
    fi
    if confirm "Download the community race map mirror now (~12.5 GB from livesow.net)?" \
            "$([ "${have_packs}" -gt 100 ] && echo n || echo y)"; then
        rs_fetch_maps --jobs 8 --no-restart
    else
        say "skipped — run scripts/fetch-maps.sh anytime; new packs load on the next server restart"
    fi
}

# ============================================================================
# agent mode
# ============================================================================
if [ "${MODE}" = "agent" ]; then
    if [ -n "${NONINTERACTIVE:-}" ]; then
        [ -n "${INGEST_URL:-}" ]   || die "INGEST_URL is required (set it in ${CONFIG_FILE:-the environment})"
        [ -n "${INGEST_TOKEN:-}" ] || die "INGEST_TOKEN is required — the api token from the central site admin"
    else
        echo
        say "The central stats site admin must enroll your server and give you a"
        say "token + ingest URL (see AGENT.md). Records you push are attributed"
        say "to that token."
        ask INGEST_URL   "Ingest URL (https://<stats-site>/api/ingest)" ""
        ask INGEST_TOKEN "Per-server ingest token" ""
    fi
    case "${INGEST_URL}" in http://*|https://*) ;; *) die "INGEST_URL must start with http:// or https://" ;; esac
    [ -n "${INGEST_TOKEN}" ] || die "the ingest token is required (ask the central site admin)"
    case "${INGEST_TOKEN}" in
        REPLACE_WITH_*|*your*token*|*YOUR*TOKEN*) die "INGEST_TOKEN is still the placeholder — paste the real token from the central admin" ;;
    esac

    rs_write_agent_env .env
    say "wrote .env"

    offer_maps

    say "building + starting the game server (first build downloads Warsow ~465 MB)"
    ${DOCKER} compose -f docker-compose.agent.yml up -d --build
    sleep 5
    ${DOCKER} logs warsow-race 2>&1 | grep -E "hostname|first map|map pool" | head -3 || true
    echo
    say "agent install done — game server on UDP ${SV_PORT}"
    say "open UDP ${SV_PORT}$([ -n "${MIRROR_PEERS}" ] && echo " + ${MIRROR_PORT} (mesh)") in your firewall; logs: docker logs -f warsow-race"
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

rs_write_full_root_env .env
say "wrote .env"

# Full mode uses per-server tokens (enrolled below into server/.env); the shared
# INGEST_TOKEN must stay empty for the web service. deploy.env may have EXPORTED
# an INGEST_TOKEN, and docker compose prefers a shell var over the empty one in
# .env — so drop it from the environment before bringing the site up.
unset INGEST_TOKEN

say "building + starting the stats website and Discord announcer"
${DOCKER} compose up -d --build

say "waiting for the website to come up"
rs_wait_web_healthy 30

# --- Enroll the co-located game server against the local site ----------------
say "enrolling the game server for direct-to-API race reporting"
INGEST_TOKEN="$(rs_enroll_token "${SV_HOSTNAME}")"
rs_write_full_server_env server/.env "${INGEST_TOKEN}"
say "wrote server/.env (token stored there)"

# --- Host dirs the game server writes as uid 999 -----------------------------
rs_fix_host_dirs

offer_maps

# --- Seed the in-game top lists from the database ----------------------------
# Needs a populated Postgres; on a fresh box migrate the bundled snapshot first.
seed_database() {
    local races
    races=$(${DOCKER} compose exec -T postgres psql -U racesow -d racesow -qtA \
        -c "SELECT COUNT(*) FROM race" 2>/dev/null | tr -d '[:space:]' || true)
    case "${races}" in
        ''|*[!0-9]*) say "WARNING: cannot reach Postgres to seed records — skipping"; return ;;
        0) say "migrating the bundled livesow snapshot into Postgres (one-time)"
           ${DOCKER} compose run --rm web node migrate-sqlite-to-pg.js /data/db.sqlite \
               || { say "WARNING: migration failed; run it manually later"; return; } ;;
    esac
    scripts/seed-server.sh --no-restart || say "WARNING: seeding failed; run scripts/seed-server.sh later"
}
if [ -n "${NONINTERACTIVE:-}" ]; then
    if truthy "${SEED_DATABASE:-1}"; then seed_database; else say "skipping database seed (SEED_DATABASE is off)"; fi
elif confirm "Seed the in-game 'top' record lists from data/db.sqlite (recommended)?"; then
    seed_database
fi

say "building + starting the game server (first build downloads Warsow ~465 MB)"
( cd server && ${DOCKER} compose up -d --build )
sleep 5
${DOCKER} logs warsow-race 2>&1 | grep -E "hostname|first map|map pool" | head -3 || true

echo
say "full install done:"
say "  stats site : http://localhost:8080  (put a TLS reverse proxy in front for production)"
say "  game server: UDP ${SV_PORT} — open it (plus 80/443 for the site) in your firewall"
say "  discord    : $( [ -n "${DISCORD_WEBHOOK_URL}" ] && echo announcing new records || echo dry-run mode — set DISCORD_WEBHOOK_URL in .env to enable )"
say "  logs       : docker logs -f warsow-race | racesow-web | racesow-discord"
say "  optional   : systemd/install.sh full — boot ordering + nightly DB backups"
