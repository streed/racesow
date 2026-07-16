#!/usr/bin/env bash
# cloud-init.sh — one-shot, root, non-interactive Racesow bootstrap for a fresh
# cloud VM. Designed to be driven from cloud-init user-data (see
# systemd/cloud-config.yaml), but works by hand too:
#
#   sudo RACESOW_MODE=agent \
#        INGEST_URL=https://stats.example.com/api/ingest \
#        INGEST_TOKEN=<token> \
#        bash scripts/cloud-init.sh
#
# It provisions the whole box from bare metal:
#   1. installs Docker + git + git-lfs + clamav + curl/unzip
#   2. creates the unprivileged `racesow` service user (in the docker group)
#   3. clones (or reuses) this repo under /opt/racesow, owned by that user
#   4. provisions the deployment via scripts/setup.sh --non-interactive
#   5. installs + enables the systemd units via systemd/install.sh
#
# The ONLY settings an operator must supply are the API token (INGEST_URL +
# INGEST_TOKEN, from the central stats-site admin) and — if this box joins a
# server network — the mesh (MIRROR_PEERS / MIRROR_SECRET / MIRROR_TAG).
# Everything else is generated or defaulted. Supply them as environment
# variables or, preferably, in a KEY=VALUE file at /etc/racesow/deploy.env
# (override with RACESOW_CONFIG); this script reads it (docker-.env style — no
# quoting needed for values with spaces, and nothing in it is run as code).
#
# Idempotent: re-running reuses the user, updates the clone, and re-provisions
# in place.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the shared config loader (rs_load_env_file) so deploy.env is parsed with
# the same safe docker-.env semantics setup.sh uses. cloud-init.sh ships next to
# its lib (it lives in the repo it bootstraps); tolerate its absence just in case.
# shellcheck source=scripts/lib/common.sh
[ -f "${SCRIPT_DIR}/lib/common.sh" ] && . "${SCRIPT_DIR}/lib/common.sh"

# Phase-tagged log/die (defined AFTER the source so they win over common.sh's).
log() { printf '\n>> [cloud-init] %s\n' "$*"; }
die() { echo "ERROR: [cloud-init] $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (cloud-init runs as root; use sudo by hand)"

# --- Config file -------------------------------------------------------------
CONFIG_FILE="${RACESOW_CONFIG:-/etc/racesow/deploy.env}"
if [ -f "${CONFIG_FILE}" ]; then
    command -v rs_load_env_file >/dev/null 2>&1 \
        || die "shared lib ${SCRIPT_DIR}/lib/common.sh not found — cannot safely parse ${CONFIG_FILE}"
    rs_load_env_file "${CONFIG_FILE}"   # docker-.env semantics: never eval'd as code
    log "loaded config from ${CONFIG_FILE}"
else
    log "no ${CONFIG_FILE} — relying on the environment for config"
fi

RACESOW_MODE="${RACESOW_MODE:-agent}"
RACESOW_USER="${RACESOW_USER:-racesow}"
# Default the target dir to the checkout we're already running from (by-hand use
# from a clone), else /opt/racesow (fresh VM, nothing cloned yet).
_self_root="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
if [ -z "${RACESOW_DIR:-}" ]; then
    if [ -f "${_self_root}/scripts/setup.sh" ]; then RACESOW_DIR="${_self_root}"; else RACESOW_DIR="/opt/racesow"; fi
fi
RACESOW_REPO="${RACESOW_REPO:-https://github.com/streed/racesow.git}"
RACESOW_REF="${RACESOW_REF:-main}"
case "${RACESOW_MODE}" in agent|full) ;; *) die "RACESOW_MODE must be agent or full (got '${RACESOW_MODE}')" ;; esac
[ "${RACESOW_USER}" != "root" ] || die "RACESOW_USER must be an unprivileged account, not root"

log "mode=${RACESOW_MODE} user=${RACESOW_USER} dir=${RACESOW_DIR}"

# Fail fast on the one thing the operator must provide for an agent, before we
# spend minutes installing Docker and cloning. Reject the shipped placeholder so
# a forgotten edit fails loudly here rather than 401ing every race report later.
if [ "${RACESOW_MODE}" = "agent" ]; then
    [ -n "${INGEST_URL:-}" ]   || die "INGEST_URL is required in agent mode (set it in ${CONFIG_FILE})"
    [ -n "${INGEST_TOKEN:-}" ] || die "INGEST_TOKEN is required in agent mode — the api token from the central admin"
    case "${INGEST_TOKEN}" in
        REPLACE_WITH_*|*your*token*|*YOUR*TOKEN*) die "INGEST_TOKEN is still the placeholder — paste the real token from the central admin" ;;
    esac
fi

# --- 1. Packages -------------------------------------------------------------
# clamav* powers the weekly pak antivirus scan the systemd units enable; git-lfs
# is needed for full mode's bundled data/db.sqlite snapshot.
log "installing base packages (git, git-lfs, clamav, curl, unzip)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq sudo ca-certificates curl unzip git git-lfs clamav clamav-freshclam
# Docker via the official convenience script: the docker-compose-v2 / docker-buildx
# apt packages only exist on newer releases (Ubuntu 24.04+/Debian 12+), whereas
# get.docker.com installs docker-ce + the compose & buildx plugins across every
# supported Ubuntu/Debian version.
if ! command -v docker >/dev/null 2>&1; then
    log "installing Docker (get.docker.com — portable across Ubuntu/Debian releases)"
    curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing after install"

# --- 2. Service user ---------------------------------------------------------
if ! id -u "${RACESOW_USER}" >/dev/null 2>&1; then
    log "creating service user ${RACESOW_USER}"
    useradd --create-home --shell /bin/bash "${RACESOW_USER}"
fi
getent group docker >/dev/null 2>&1 || groupadd docker
usermod -aG docker "${RACESOW_USER}"
# A fresh `sudo -u` session picks up the group from /etc/group immediately, so
# the user can talk to Docker without a re-login. Retry briefly in case the
# freshly-installed daemon is still coming up.
for _i in 1 2 3 4 5; do
    sudo -u "${RACESOW_USER}" docker info >/dev/null 2>&1 && break
    [ "${_i}" = 5 ] && die "${RACESOW_USER} cannot talk to Docker (daemon down, or group not applied)"
    sleep 2
done

# --- 3. Repo -----------------------------------------------------------------
# Clone the whole repo (not --branch), then check out RACESOW_REF, so the ref may
# be a branch, tag, OR a pinned commit SHA. A failed checkout is surfaced, never
# swallowed into a stale-code deploy.
if [ -d "${RACESOW_DIR}/.git" ]; then
    log "updating existing checkout at ${RACESOW_DIR}"
    git -C "${RACESOW_DIR}" fetch --quiet origin || log "WARNING: git fetch failed (no network?) — using the current checkout"
    git -C "${RACESOW_DIR}" checkout --quiet "${RACESOW_REF}" 2>/dev/null \
        || log "WARNING: could not check out '${RACESOW_REF}' — using the current checkout"
    git -C "${RACESOW_DIR}" merge --quiet --ff-only "origin/${RACESOW_REF}" 2>/dev/null || true  # fast-forward a branch; no-op for tag/SHA
else
    log "cloning ${RACESOW_REPO} into ${RACESOW_DIR} (ref ${RACESOW_REF})"
    mkdir -p "$(dirname -- "${RACESOW_DIR}")"
    git clone --quiet "${RACESOW_REPO}" "${RACESOW_DIR}"
    git -C "${RACESOW_DIR}" checkout --quiet "${RACESOW_REF}" || die "could not check out ref '${RACESOW_REF}' from ${RACESOW_REPO}"
fi
chown -R "${RACESOW_USER}:${RACESOW_USER}" "${RACESOW_DIR}"
[ -f "${RACESOW_DIR}/scripts/setup.sh" ] || die "${RACESOW_DIR} is not a Racesow checkout (no scripts/setup.sh)"

# --- 4. Provision (as the service user) --------------------------------------
# setup.sh --non-interactive re-reads ${CONFIG_FILE}; make it readable by the
# service user (it holds the ingest + mesh secrets). We ALSO forward the config
# via the environment (--preserve-env) so the documented env-only, file-less
# invocation (sudo INGEST_TOKEN=... bash cloud-init.sh) survives the sudo -u hop.
if [ -f "${CONFIG_FILE}" ]; then
    chown "root:${RACESOW_USER}" "${CONFIG_FILE}" 2>/dev/null || true
    chmod 640 "${CONFIG_FILE}" 2>/dev/null || true
fi
FORWARD="RACESOW_MODE INGEST_URL INGEST_TOKEN SV_HOSTNAME SV_MAXCLIENTS SV_PUBLIC \
RCON_PASSWORD MIRROR_PEERS MIRROR_SECRET MIRROR_TAG MIRROR_PORT SV_PORT SV_UPLOADS_BASEURL \
PAK_HTTP_PORT VERSION_NAME DISCORD_WEBHOOK_URL DOWNLOAD_MAPS SEED_DATABASE"
preserve="RACESOW_NONINTERACTIVE,RACESOW_CONFIG"
for k in ${FORWARD}; do preserve="${preserve},${k}"; done
log "provisioning the ${RACESOW_MODE} deployment via setup.sh (this builds images; first run is slow)"
sudo --preserve-env="${preserve}" -u "${RACESOW_USER}" \
    env RACESOW_NONINTERACTIVE=1 RACESOW_CONFIG="${CONFIG_FILE}" RACESOW_MODE="${RACESOW_MODE}" \
    bash "${RACESOW_DIR}/scripts/setup.sh" --non-interactive "${RACESOW_MODE}"

# --- 5. systemd units --------------------------------------------------------
# Run as root (writes /etc/systemd/system, enables units) but tell install.sh
# the units must run as the unprivileged service user.
log "installing systemd units (boot ordering + weekly pak scan$([ "${RACESOW_MODE}" = full ] && echo ' + nightly DB backup'))"
RACESOW_USER="${RACESOW_USER}" bash "${RACESOW_DIR}/systemd/install.sh" "${RACESOW_MODE}"

# --- 6. Firewall (best-effort, opt-in) --------------------------------------
# Only touch ufw if it is already active — i.e. the operator opted into a host
# firewall. Most cloud VMs gate traffic at the provider's security group
# instead, so we never enable ufw ourselves (that risks locking out SSH).
open_firewall_ports() {
    if ! { command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; }; then
        log "note: open UDP ${SV_PORT:-44400} (game)$([ "${RACESOW_MODE}" = full ] && echo ', TCP 80/443 (site)') and, if meshing, UDP ${MIRROR_PORT:-44450} in your cloud firewall / security group"
        return 0
    fi
    log "ufw is active — adding allow rules"
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow "${SV_PORT:-44400}/udp" >/dev/null 2>&1 || true
    [ -n "${MIRROR_PEERS:-}" ] && ufw allow "${MIRROR_PORT:-44450}/udp" >/dev/null 2>&1 || true
    if [ "${RACESOW_MODE}" = "full" ]; then
        ufw allow 80/tcp  >/dev/null 2>&1 || true
        ufw allow 443/tcp >/dev/null 2>&1 || true
    fi
    return 0
}
open_firewall_ports

log "done — Racesow ${RACESOW_MODE} is up. Check: systemctl status 'racesow-*'  |  docker logs -f warsow-race"
