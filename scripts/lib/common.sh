#!/usr/bin/env bash
# common.sh — shared building blocks for the Racesow installers.
#
# Sourced (never executed) by:
#   - scripts/setup.sh      the guided/interactive installer
#   - scripts/cloud-init.sh the root, non-interactive cloud-init bootstrap
#
# It holds the logic both need — Docker resolution, .env writers, host-dir
# ownership, map fetch, token enrollment, web health wait — so there is exactly
# one copy. Every function here is NON-interactive and idempotent; gathering the
# configuration (interactive prompts vs. /etc/racesow/deploy.env) is the
# caller's job. Functions read settings from the environment (SV_HOSTNAME,
# INGEST_URL, MIRROR_*, ...) and assume the current directory is the repo root.

# Guard against double-sourcing (setup.sh sources this; so might a helper).
[ -n "${_RACESOW_COMMON_SH:-}" ] && return 0
_RACESOW_COMMON_SH=1

# --- Tiny output + probe helpers --------------------------------------------
say()  { printf '>> %s\n' "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
rs_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 24 hex chars for an rcon password; 48 hex (openssl rand -hex 24) for secrets.
rs_gen_rcon()   { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24; }
rs_gen_secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# rs_load_env_file FILE — export KEY=VALUE lines from a config file using
# docker-compose .env semantics, NOT shell sourcing: values are taken literally
# (so `SV_HOSTNAME=US West Race` works unquoted), surrounding quotes are
# stripped, a whitespace-preceded inline `# comment` is dropped from an unquoted
# value, whole-line `#` comments and blanks are ignored, CRLF is tolerated, and
# nothing in the file is ever evaluated as code. Missing file is a no-op.
rs_load_env_file() {
    local file="$1" line key val
    [ -f "${file}" ] || return 0
    while IFS= read -r line || [ -n "${line}" ]; do
        line="${line%$'\r'}"                             # tolerate CRLF (Windows / web-console paste)
        line="${line#"${line%%[![:space:]]*}"}"          # ltrim
        case "${line}" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
        key="${line%%=*}"; val="${line#*=}"
        key="${key%"${key##*[![:space:]]}"}"             # rtrim key
        case "${key}" in export\ *) key="${key#export }" ;; esac
        case "${key}" in [A-Za-z_]*) ;; *) continue ;; esac  # valid identifier only
        case "${val}" in
            \"*) val="${val#\"}"; val="${val%%\"*}" ;;   # "quoted" — inner text (a # inside stays)
            \'*) val="${val#\'}"; val="${val%%\'*}" ;;   # 'quoted'
            *)   # unquoted: drop a ` #...` inline comment, then rtrim
                 case "${val}" in *[[:space:]]#*) val="${val%%[[:space:]]#*}" ;; esac
                 val="${val%"${val##*[![:space:]]}"}" ;;
        esac
        export "${key}=${val}"
    done < "${file}"
}

# rs_apt_install PKG... — install packages if any are missing (idempotent).
# No-op when everything is already present. Uses sudo only when not root.
rs_apt_install() {
    have apt-get || die "no apt-get on this system — install manually: $*"
    local sudo="" p missing=0
    [ "$(id -u)" -eq 0 ] || sudo="sudo"
    for p in "$@"; do
        dpkg -s "$p" >/dev/null 2>&1 || missing=1
    done
    [ "${missing}" -eq 0 ] && return 0
    ${sudo} DEBIAN_FRONTEND=noninteractive apt-get update -qq
    ${sudo} DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

# rs_resolve_docker — set the global DOCKER to "docker" or "sudo docker" and
# confirm compose v2 is usable. Assumes Docker is already installed; falls back
# to sudo right after a fresh install (before the docker group takes effect).
rs_resolve_docker() {
    have docker || die "docker is not installed; install it, then re-run"
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

# rs_config_defaults — backfill every OPTIONAL setting the .env writers use,
# from the environment or a default. Idempotent, so it is safe to call after an
# interactive gather (it only fills what is still unset). Required values
# (INGEST_URL/INGEST_TOKEN in agent mode) are the caller's to validate; the mesh
# shared secret is deliberately NOT generated (it must be identical on every
# peer, so the operator supplies it).
rs_config_defaults() {
    : "${SV_HOSTNAME:=Racesow Community Server}"
    : "${SV_MAXCLIENTS:=16}"
    : "${SV_PUBLIC:=1}"
    : "${SV_PORT:=44400}"
    : "${VERSION_NAME:=wsw 2.1}"
    # '=' (not ':=') so an explicit empty RCON_PASSWORD stays empty (disables
    # rcon); an unset one gets a fresh random password.
    : "${RCON_PASSWORD=$(rs_gen_rcon)}"
    : "${MIRROR_PEERS:=}"
    : "${MIRROR_SECRET:=}"
    : "${MIRROR_PORT:=44450}"
    : "${MIRROR_TAG:=}"
    : "${SV_UPLOADS_BASEURL:=}"
    : "${PAK_HTTP_PORT:=44445}"
    : "${DISCORD_WEBHOOK_URL:=}"
}

# rs_write_agent_env FILE — the agent-mode .env (game server -> remote site).
# Reads INGEST_URL/INGEST_TOKEN + the SV_*/MIRROR_* settings from the env.
rs_write_agent_env() {
    local file="$1"
    rs_config_defaults
    ( umask 077; cat > "${file}" <<EOF
# Generated by the Racesow installer (agent mode) on $(rs_now).
# Game-server agent: pushes race finishes to the central stats site.
INGEST_URL=${INGEST_URL}
INGEST_TOKEN=${INGEST_TOKEN}
SV_HOSTNAME=${SV_HOSTNAME}
SV_MAXCLIENTS=${SV_MAXCLIENTS}
SV_PUBLIC=${SV_PUBLIC}
SV_PORT=${SV_PORT}
RCON_PASSWORD=${RCON_PASSWORD}
VERSION_NAME=${VERSION_NAME}
# Cross-server player mesh (empty MIRROR_PEERS = single server, mesh off).
MIRROR_PEERS=${MIRROR_PEERS}
MIRROR_SECRET=${MIRROR_SECRET}
MIRROR_PORT=${MIRROR_PORT}
MIRROR_TAG=${MIRROR_TAG}
# Optional client-facing HTTP pak mirror (see docker-compose.agent.yml httpdl).
SV_UPLOADS_BASEURL=${SV_UPLOADS_BASEURL}
PAK_HTTP_PORT=${PAK_HTTP_PORT}
EOF
    )
}

# rs_write_full_root_env FILE — repo-root .env for the central stats stack.
# Preserves an existing POSTGRES_PASSWORD (never rotate a live DB's password)
# and generates one on a fresh deploy — compose requires it (${POSTGRES_PASSWORD:?}).
rs_write_full_root_env() {
    local file="$1"
    rs_config_defaults
    if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -f "${file}" ]; then
        POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "${file}" | head -1)"
    fi
    : "${POSTGRES_PASSWORD:=$(rs_gen_secret)}"
    ( umask 077; cat > "${file}" <<EOF
# Generated by the Racesow installer (full mode) on $(rs_now).
# COMPOSE_PROJECT_NAME pins the compose network to racesow_default regardless of
# the checkout directory name; the game server (server/docker-compose.yml) joins
# it by name to reach http://web:8080/api/ingest.
COMPOSE_PROJECT_NAME=racesow
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
# Ingest auth uses per-server tokens (enrolled below, stored in server/.env);
# the shared-secret fallback stays disabled.
INGEST_TOKEN=
SERVER_NAME=${SV_HOSTNAME}
DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}
EOF
    )
}

# rs_write_full_server_env FILE TOKEN — server/.env for the co-located game
# server, wired to report over the compose network with its enrolled token.
rs_write_full_server_env() {
    local file="$1" token="$2"
    rs_config_defaults
    ( umask 077; cat > "${file}" <<EOF
# Generated by the Racesow installer (full mode) on $(rs_now).
SV_HOSTNAME=${SV_HOSTNAME}
SV_MAXCLIENTS=${SV_MAXCLIENTS}
SV_PUBLIC=${SV_PUBLIC}
SV_PORT=${SV_PORT}
RCON_PASSWORD=${RCON_PASSWORD}
VERSION_NAME=${VERSION_NAME}
# Direct-to-API race reporting over the compose network (racesow_default).
INGEST_URL=http://web:8080/api/ingest
INGEST_TOKEN=${token}
# Cross-server player mesh (empty MIRROR_PEERS = single server, mesh off).
MIRROR_PEERS=${MIRROR_PEERS}
MIRROR_SECRET=${MIRROR_SECRET}
MIRROR_PORT=${MIRROR_PORT}
MIRROR_TAG=${MIRROR_TAG}
EOF
    )
}

# rs_fix_host_dirs — the game container writes records + the race audit log +
# WR replay demos as uid 999; a fresh clone leaves the bind-mounted host dirs
# owned by the invoker. (Full mode only — agent mode uses named volumes.)
rs_fix_host_dirs() {
    local d
    for d in server/topscores server/racelog server/demos; do
        mkdir -p "$d"
        if [ "$(id -u)" -eq 0 ]; then
            chown -R 999:999 "$d"
        elif sudo -n true 2>/dev/null || sudo -v 2>/dev/null; then
            sudo chown -R 999:999 "$d"
        else
            chmod -R a+rwX "$d"
            say "WARNING: no sudo — made $d world-writable instead of chowning to uid 999"
        fi
    done
}

# rs_enroll_token NAME — enroll a game server against the LOCAL site and echo its
# 64-hex INGEST_TOKEN on stdout. Requires the web stack to be up. Uses $DOCKER.
rs_enroll_token() {
    local name="$1" out token
    out="$(${DOCKER} compose exec -T web node admin.js enroll "${name}")" \
        || die "admin.js enroll failed:
${out}"
    token="$(printf '%s\n' "${out}" | sed -n 's/^[[:space:]]*INGEST_TOKEN=//p' | head -1)"
    printf '%s\n' "${token}" | grep -qE '^[0-9a-f]{64}$' \
        || die "could not parse the enrolled token from admin.js output:
${out}"
    printf '%s\n' "${token}"
}

# rs_wait_web_healthy [tries] — block until the local web API reports healthy.
rs_wait_web_healthy() {
    local tries="${1:-30}"
    for _ in $(seq 1 "${tries}"); do
        if curl -fsS http://localhost:8080/api/health 2>/dev/null | grep -q '"ok":true'; then
            say "website is healthy at http://localhost:8080"
            return 0
        fi
        sleep 2
    done
    die "web did not become healthy; check: docker logs racesow-web"
}

# rs_fetch_maps ARGS... — mirror the community map pool (idempotent, resumable);
# a partial failure is a warning, not fatal (re-run scripts/fetch-maps.sh later).
rs_fetch_maps() {
    scripts/fetch-maps.sh "$@" \
        || say "WARNING: some packs failed; re-run scripts/fetch-maps.sh later to retry"
}
