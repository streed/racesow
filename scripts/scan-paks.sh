#!/usr/bin/env bash
# scan-paks.sh — ClamAV virus scan of the game pk3 map packs.
#
# pk3 packs are community content (fetched from livesow via fetch-maps.sh) that
# the pakserver hands to every connecting client, so they are exactly the kind
# of untrusted, redistributed files worth scanning. A .pk3 is a ZIP archive;
# clamscan unpacks it and scans the contents (textures, shaders, sounds, .bsp).
#
# An infected pack is MOVED to a quarantine dir (out of the served set) and the
# run exits non-zero, so the systemd timer / operator is alerted. Clean packs
# are untouched.
#
# Usage:
#   scripts/scan-paks.sh [dir ...]      # default: server/maps (the fetched packs)
#   QUARANTINE=/path scripts/scan-paks.sh /a /b
#
# Requires clamav (apt install clamav clamav-freshclam). The freshclam service
# keeps the signature DB current; this script does not update it inline (that
# would fight freshclam's lock).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Dirs to scan. Default = the fetched community map packs. The pakserver volume
# is a derived copy of these, so scanning the source covers what is served; pass
# extra dirs (e.g. a sudo-readable pakshare path) to scan them too.
DIRS=("${REPO_ROOT}/server/maps")
[ "$#" -gt 0 ] && DIRS=("$@")

QUARANTINE="${QUARANTINE:-${REPO_ROOT}/quarantine}"
LOG="${SCAN_LOG:-${REPO_ROOT}/pak-scan.log}"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG}"; }

command -v clamscan >/dev/null 2>&1 || { echo "clamscan not found — apt install clamav clamav-freshclam" >&2; exit 3; }
# Bail early with a clear message if the signature DB isn't populated yet.
clamscan --version >/dev/null 2>&1 || { echo "clamav present but not functional" >&2; exit 3; }

mkdir -p "${QUARANTINE}"
say "pak scan start: ${DIRS[*]} (quarantine: ${QUARANTINE})"

# Raise the size/file caps well above the biggest pack (~140MB) and its contents
# so large packs are scanned in FULL, not silently skipped (clamscan defaults:
# 25M file / 100M scan). --max-scantime=0 = no per-file time cap for big zips.
# --move sends only INFECTED files to the quarantine dir; clean files stay put.
# --exclude-dir keeps the quarantine out of the scan on repeat runs.
set +e
clamscan --recursive --infected --no-summary=no \
  --max-filesize=2000M --max-scansize=2000M --max-files=500000 \
  --max-recursion=32 --max-scantime=0 \
  --exclude-dir="^${QUARANTINE}$" \
  --move="${QUARANTINE}" \
  "${DIRS[@]}" 2>&1 | tee -a "${LOG}"
rc=${PIPESTATUS[0]}
set -e

# clamscan exit codes: 0 = no virus, 1 = virus found, 2 = error.
case "${rc}" in
  0) say "pak scan clean (rc=0)";;
  1) say "!! INFECTED PACK(S) FOUND — moved to ${QUARANTINE}. Purge the same file from the pakserver volume and restart the game server. (rc=1)";;
  *) say "pak scan ERROR (rc=${rc}) — check clamav / signature DB";;
esac
exit "${rc}"
