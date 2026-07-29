#!/usr/bin/env bash
# ingest-demos.sh — turn client demos dropped in the SFTP quarantine into
# attributed records. For each *.wdz20 a trusted uploader put in
# server/sftp-uploads/<user>/incoming/ this:
#   1. ClamAV-scans it (same caps as scripts/scan-paks.sh; infected -> quarantine),
#   2. parses it with web/demo-meta.mjs in a node container to recover
#      {map, runner, finish time} and POSTs a `wr_demo` pointer to the stats
#      ingest API (INGEST_URL) with this box's INGEST_TOKEN — reusing the exact
#      player/map/time attribution path the game module uses for SERVER demos,
#   3. stages the file under a canonical "<map>/<map>_<clean>_<MM-SS-mmm>.wdz20"
#      name (server-demo shape, passes the web's validDemoPath) and, if
#      DEMO_DELIVER_DEST is set, rsyncs it into the served demos tree so the
#      site's download link resolves.
#
# Runs as root (it moves files owned by the SFTP jail user, uid 1500, and talks
# to Docker). Driven every couple of minutes by systemd/racesow-demo-ingest.timer,
# or run by hand. Idempotent + single-instance (flock).
#
# Attribution works as soon as INGEST_URL/INGEST_TOKEN are set. File DELIVERY to
# the served tree is a separate, optional step (DEMO_DELIVER_DEST) because the
# website serves demos from one host (DEMO_BASE_URL) — see server/sftp/README.md.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

UPLOAD_ROOT="${DEMO_UPLOAD_ROOT:-${REPO_ROOT}/server/sftp-uploads}"
PROMOTED="${DEMO_PROMOTED_DIR:-${UPLOAD_ROOT}/.promoted}"   # canonically-named, ready to serve
REJECTED="${DEMO_REJECTED_DIR:-${UPLOAD_ROOT}/.rejected}"   # unparseable uploads
QUARANTINE="${QUARANTINE:-${REPO_ROOT}/quarantine}"         # shared with scan-paks.sh
LOG="${DEMO_INGEST_LOG:-${REPO_ROOT}/demo-ingest.log}"
NODE_IMAGE="${DEMO_NODE_IMAGE:-node:20-alpine}"
MIN_AGE_SEC="${DEMO_MIN_AGE_SEC:-20}"                       # ignore files still uploading
DELIVER_DEST="${DEMO_DELIVER_DEST:-}"                       # e.g. ubuntu@eu...:racesow/server/demos/server
export DEMO_INGEST_VERSION="${DEMO_INGEST_VERSION:-client}"

# INGEST_URL / INGEST_TOKEN come from the env (systemd EnvironmentFile=.env) or,
# for a hand run, from the repo-root .env the agent compose already uses.
if [ -z "${INGEST_URL:-}" ] || [ -z "${INGEST_TOKEN:-}" ]; then
  [ -f "${REPO_ROOT}/.env" ] && { set -a; . "${REPO_ROOT}/.env"; set +a; }
fi

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG}"; }

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 3; }
if [ -z "${INGEST_URL:-}" ] || [ -z "${INGEST_TOKEN:-}" ]; then
  say "INGEST_URL/INGEST_TOKEN unset — cannot attribute demos; aborting"
  exit 3
fi

# Single instance: a slow node pull / big scan must not overlap the next tick.
exec 9>"${REPO_ROOT}/.demo-ingest.lock"
flock -n 9 || { echo "another ingest run is in progress"; exit 0; }

mkdir -p "${PROMOTED}" "${REJECTED}" "${QUARANTINE}"
have_clam=0; command -v clamscan >/dev/null 2>&1 && have_clam=1

shopt -s nullglob
for dir in "${UPLOAD_ROOT}"/*/incoming; do
  [ -d "${dir}" ] || continue
  # -not -newermt selects files last modified >= MIN_AGE_SEC ago (upload settled).
  while IFS= read -r -d '' f; do
    base="$(basename "${f}")"
    say "processing ${f} ($(stat -c %s "${f}" 2>/dev/null || echo '?') bytes)"

    # 1) Antivirus. --move sends an infected file to the quarantine dir itself.
    if [ "${have_clam}" = 1 ]; then
      set +e
      clamscan --no-summary --infected \
        --max-filesize=2000M --max-scansize=2000M --max-files=500000 \
        --max-recursion=32 --max-scantime=0 \
        --move="${QUARANTINE}" "${f}" >>"${LOG}" 2>&1
      crc=$?
      set -e
      [ "${crc}" = 1 ] && { say "!! INFECTED ${base} -> ${QUARANTINE}"; continue; }
      [ "${crc}" != 0 ] && { say "clamscan error rc=${crc} on ${base} — leaving for retry"; continue; }
    else
      say "note: clamscan not installed — AV skipped (apt install clamav)"
    fi

    # 2) Parse + attribute. The node container reads the demo (RO mount), recovers
    #    map/runner/time and POSTs the wr_demo pointer; it prints STATUS/RELPATH.
    set +e
    out="$(docker run --rm \
        -e INGEST_URL -e INGEST_TOKEN -e DEMO_INGEST_VERSION \
        -v "${REPO_ROOT}/web":/web:ro -v "${dir}":/data:ro \
        "${NODE_IMAGE}" node /web/demo-meta.mjs --ingest "/data/${base}" 2>>"${LOG}")"
    set -e
    status="$(printf '%s\n' "${out}" | sed -n 's/^STATUS=//p' | head -1)"
    relpath="$(printf '%s\n' "${out}" | sed -n 's/^RELPATH=//p' | head -1)"

    case "${status}" in
      ok)
        say "attributed ${base} -> ${relpath}"
        # 3) Stage under the canonical served name.
        map="${relpath%%/*}"; canon="${relpath##*/}"
        mkdir -p "${PROMOTED}/${map}"
        mv -f "${f}" "${PROMOTED}/${map}/${canon}"
        # 4) Optional delivery to the served demos tree (where DEMO_BASE_URL serves).
        if [ -n "${DELIVER_DEST}" ]; then
          if rsync -a --mkpath "${PROMOTED}/${map}/${canon}" "${DELIVER_DEST}/${map}/" >>"${LOG}" 2>&1; then
            say "delivered ${relpath} -> ${DELIVER_DEST}"
          else
            say "WARN delivery failed for ${relpath} (staged at ${PROMOTED}/${map}/${canon})"
          fi
        else
          say "note: DEMO_DELIVER_DEST unset — staged only (download link 404s until delivered)"
        fi
        ;;
      reject)
        reason="$(printf '%s\n' "${out}" | sed -n 's/^REASON=//p' | head -1)"
        mv -f "${f}" "${REJECTED}/${base}"
        say "rejected ${base}: ${reason:-invalid race demo}"
        ;;
      *)
        http="$(printf '%s\n' "${out}" | sed -n 's/^HTTP=//p' | head -1)"
        say "ingest error for ${base} (status=${status:-none} http=${http:-}) — leaving for retry"
        ;;
    esac
  done < <(find "${dir}" -maxdepth 1 -type f \( -iname '*.wdz20' -o -iname '*.wd' \) \
             -not -newermt "-${MIN_AGE_SEC} seconds" -print0)
done
shopt -u nullglob
exit 0
