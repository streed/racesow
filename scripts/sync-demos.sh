#!/usr/bin/env bash
# sync-demos.sh — make every player_demo download pointer actually resolve.
#
# A demo the game records is only downloadable once the FILE reaches the pak
# mirror the website links to (DEMO_BASE_URL -> nginx /demos/ -> pakserver ->
# the `pakshare` volume). Three independent gaps used to leave ~half of the
# rows pointing at a 404; this job closes all three and is safe to run on a
# timer (every step is idempotent and additive — nothing is ever deleted):
#
#   1. MIRROR — copy the game container's live demos into the served tree.
#      entrypoint.sh's export_pakshare only runs at container (re)launch, so a
#      demo recorded since the last restart 404s until the next one.
#
#   2. ALIAS — hardlink a lowercase twin for every mixed-case demo path.
#      hrace/demos.as reports `mapname.tolower()` while the engine writes the
#      BSP's real case ("Daemond-marky/Daemond-marky_..."), so on case-sensitive
#      nginx the stored path 404s. The alias makes BOTH spellings resolve, which
#      fixes historical rows too (a racemod fix alone would only help new ones).
#
#   3. PULL — (central box only) fetch anything the DB knows about but this box
#      doesn't have from a peer's public pak mirror. US-captured demos are
#      written on us.east while every link points at the EU site, so without
#      this they can only ever 404.
#
# Optionally (--repair-stale, off by default) it also repoints a row whose file
# is gone but whose player has a FASTER demo for that map on disk — the engine
# keeps one demo per (player, map) and renames it on improvement, so a dropped
# report leaves the row pointing at the superseded time.
#
# Run on either box from the repo root; needs docker access (the deploy user is
# in the docker group), no sudo:
#   scripts/sync-demos.sh                  # mirror + alias (+ pull on the central box)
#   scripts/sync-demos.sh --dry-run        # report only, change nothing
#   scripts/sync-demos.sh --repair-stale   # also repoint superseded rows (writes to the DB)
#   scripts/sync-demos.sh --prune-missing  # DELETE rows whose file is gone for good
#
# --repair-stale and --prune-missing write to the stats DB and are NEVER run by
# the timer; --prune-missing is destructive, so pair it with --dry-run first.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# Containers to read from / write to. The game container holds BOTH the live
# demo dir and the pakshare mount, so the mirror is a copy inside one container.
GAME_CONTAINERS="${DEMO_GAME_CONTAINERS:-warsow-race}"
PAK_CONTAINER="${DEMO_PAK_CONTAINER:-racesow-pakserver}"
# Central stats DB. Absent (agent box) => the DB-driven pull step is skipped.
DB_CONTAINER="${DEMO_DB_CONTAINER:-racesow-postgres}"
SERVED_DIR="${DEMO_SERVED_DIR:-/usr/share/nginx/html/demos}"
GAME_DEMO_DIR="${DEMO_GAME_DIR:-/warsow/racemod/demos/server}"
# Peer pak mirrors to pull missing demos from (space separated, no trailing /).
PEERS="${DEMO_PEERS:-http://us.east.racesow.org:44445}"
CURL_MAX_TIME="${DEMO_CURL_MAX_TIME:-60}"

DRY_RUN=0
REPAIR_STALE=0
PRUNE_MISSING=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run)       DRY_RUN=1 ;;
    --repair-stale)  REPAIR_STALE=1 ;;
    --prune-missing) PRUNE_MISSING=1 ;;
    --no-pull)      PEERS="" ;;
    -h|--help)      sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown flag: ${arg}" >&2; exit 2 ;;
  esac
done

say() { printf '>> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 3; }

# Single instance: a slow cross-region pull must not overlap the next tick.
exec 9>"${REPO_ROOT}/.demo-sync.lock"
flock -n 9 || { echo "another sync-demos run is in progress"; exit 0; }

running() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -qx true; }

# --- 1. mirror the live demo dir into the served tree ------------------------
mirrored=0
for c in ${GAME_CONTAINERS}; do
  running "${c}" || { say "skip mirror: ${c} not running"; continue; }
  before="$(docker exec "${c}" sh -c "find /pakshare/demos -type f 2>/dev/null | wc -l" || echo 0)"
  if [ "${DRY_RUN}" = 1 ]; then
    pending="$(docker exec "${c}" sh -c "cd ${GAME_DEMO_DIR} 2>/dev/null && find . -type f | wc -l" || echo 0)"
    say "[dry-run] ${c}: ${pending} file(s) in the live demo dir, ${before} already served"
    continue
  fi
  # -u: only newer/missing, so this stays cheap on every tick. Dropping the
  # "server/" layer is what makes the served path the two-segment <map>/<file>
  # the web stores (hrace/demos.as RACE_DemoRelPath).
  docker exec "${c}" sh -c \
    "mkdir -p /pakshare/demos && cp -uLrf ${GAME_DEMO_DIR}/. /pakshare/demos/ 2>/dev/null" \
    || warn "mirror failed for ${c}"
  after="$(docker exec "${c}" sh -c "find /pakshare/demos -type f 2>/dev/null | wc -l" || echo 0)"
  n=$(( after - before )); [ "${n}" -lt 0 ] && n=0
  mirrored=$(( mirrored + n ))
  say "mirrored ${c}: +${n} file(s) into the served tree (${after} total)"
done

# --- 2. lowercase aliases for mixed-case demo paths --------------------------
running "${PAK_CONTAINER}" || { warn "${PAK_CONTAINER} is not running — cannot alias or pull"; exit 4; }

# Reproduce EXACTLY what the old RACE_ReportWrDemo stored: it lowercased only
# `mapname`, so the reported path is <lower(map)>/<lower(map)>_<player>_<time>
# with the PLAYER fragment left in its original case. Lowercasing the whole path
# would miss every demo by a player with a capital in their name.
# $1 = "list" (print the aliases that are missing) or "create".
alias_prog='
cd '"${SERVED_DIR}"' 2>/dev/null || exit 0
find . -type f -name "*.wdz20" | while IFS= read -r f; do
  rel=${f#./}
  case "${rel}" in */*) ;; *) continue ;; esac       # auto-recorded files sit at the root
  d=${rel%%/*}; b=${rel##*/}
  case "${b}" in "${d}_"*) ;; *) continue ;; esac    # only the canonical <map>_<player>_<time>
  ld=$(printf "%s" "${d}" | tr "[:upper:]" "[:lower:]")
  [ "${ld}" = "${d}" ] && continue                   # already lowercase: nothing to alias
  l="${ld}/${ld}_${b#"${d}_"}"
  [ -e "${l}" ] && continue
  if [ "$1" = list ]; then
    echo "${l}"
  else
    mkdir -p "${ld}" 2>/dev/null || continue
    ln "${rel}" "${l}" 2>/dev/null || cp -p "${rel}" "${l}" 2>/dev/null || true
  fi
done'
pending_aliases="$(docker exec "${PAK_CONTAINER}" sh -c "${alias_prog}" _ list | wc -l | tr -d ' ')"
if [ "${DRY_RUN}" = 1 ]; then
  say "[dry-run] ${pending_aliases} map-case alias(es) would be created, e.g.:"
  docker exec "${PAK_CONTAINER}" sh -c "${alias_prog}" _ list | head -3 | sed 's/^/     /'
elif [ "${pending_aliases}" != "0" ]; then
  # Hardlink (same filesystem, no extra bytes); fall back to a copy if the FS
  # refuses. Both spellings then resolve on case-sensitive nginx.
  docker exec "${PAK_CONTAINER}" sh -c "${alias_prog}" _ create || warn "alias pass failed"
  say "aliased ${pending_aliases} mixed-case demo path(s)"
else
  say "aliases: nothing to do"
fi

# --- 3. pull demos this box is missing from a peer mirror (central box only) --
# Only the box with the stats DB knows which paths are supposed to exist.
if ! running "${DB_CONTAINER}"; then
  say "no local stats DB — skipping the DB-driven pull (agent box)"
  say "done: mirrored=${mirrored} aliased=${pending_aliases}"
  exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
# Paths are [A-Za-z0-9_-]/. by construction (hrace/demos.as RACE_DemoCleanName +
# the web's validDemoPath), but this script interpolates them into shell and SQL
# — drop anything exotic rather than trust the constraint holds forever.
docker exec -i "${DB_CONTAINER}" psql -U racesow -d racesow -tA -c \
  "SELECT demo_path FROM player_demo ORDER BY 1" </dev/null \
  | grep -E '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' > "${tmp}/want.txt" || true
docker exec "${PAK_CONTAINER}" find "${SERVED_DIR}" -type f 2>/dev/null \
  | sed "s|^${SERVED_DIR}/||" > "${tmp}/have.txt"
sort -u "${tmp}/have.txt" > "${tmp}/have.sorted"
# Missing = a wanted path with no exact file (aliases already cover case).
grep -vxF -f "${tmp}/have.sorted" "${tmp}/want.txt" > "${tmp}/missing.txt" || true
want_n=$(wc -l < "${tmp}/want.txt" | tr -d ' ')
miss_n=$(wc -l < "${tmp}/missing.txt" | tr -d ' ')
say "DB knows ${want_n} demo(s); ${miss_n} not servable here"
[ "${miss_n}" = "0" ] && { say "done: everything the DB advertises is servable"; exit 0; }

pulled=0; still=0
while IFS= read -r path; do
  [ -n "${path}" ] || continue
  got=""
  for peer in ${PEERS}; do
    if [ "${DRY_RUN}" = 1 ]; then
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${CURL_MAX_TIME}" "${peer}/demos/${path}" || echo 000)"
      [ "${code}" = "200" ] && { got="${peer}"; break; }
      continue
    fi
    if curl -fsS --max-time "${CURL_MAX_TIME}" -o "${tmp}/blob" "${peer}/demos/${path}" 2>/dev/null \
       && [ -s "${tmp}/blob" ]; then
      docker exec "${PAK_CONTAINER}" mkdir -p "${SERVED_DIR}/$(dirname "${path}")" 2>/dev/null || true
      if docker cp "${tmp}/blob" "${PAK_CONTAINER}:${SERVED_DIR}/${path}" 2>/dev/null; then
        got="${peer}"; break
      fi
    fi
  done
  if [ -n "${got}" ]; then
    pulled=$(( pulled + 1 ))
    [ "${DRY_RUN}" = 1 ] && say "[dry-run] would pull ${path} from ${got}" || say "pulled ${path}"
  else
    still=$(( still + 1 ))
    printf '%s\n' "${path}" >> "${tmp}/unrecoverable.txt"
  fi
done < "${tmp}/missing.txt"

say "pulled ${pulled}; ${still} still unservable"

# --- 4. optional: repoint rows superseded by a faster demo on disk -----------
# The engine keeps ONE demo per (player, map) and renames it when the player
# improves, so a report that never landed leaves the row pointing at the older
# time. If exactly one file matches this row's <map>/<map>_<player>_*.wdz20 AND
# it is faster, the row is stale rather than lost — repoint it.
if [ "${REPAIR_STALE}" = 1 ] && [ -s "${tmp}/unrecoverable.txt" ]; then
  repaired=0
  while IFS= read -r path; do
    map="${path%%/*}"; file="${path##*/}"
    stem="${file%_*}"                      # "<map>_<player>" (drops _MM-SS-mmm.wdz20)
    # -F: a map name may contain regex metacharacters; the "<map>/" prefix only
    # ever occurs at position 0, so a fixed-string match is effectively anchored.
    cands="$(grep -cF "${map}/${stem}_" "${tmp}/have.sorted" || true)"
    [ "${cands}" = "1" ] || continue
    repl="$(grep -m1 -F "${map}/${stem}_" "${tmp}/have.sorted")"
    # Parse MM-SS-mmm out of the replacement and only accept a FASTER demo.
    t="${repl##*_}"; t="${t%.wdz20}"
    ms=$(( 10#${t%%-*} * 60000 + 10#$(echo "${t}" | cut -d- -f2) * 1000 + 10#${t##*-} ))
    o="${file##*_}"; o="${o%.wdz20}"
    oms=$(( 10#${o%%-*} * 60000 + 10#$(echo "${o}" | cut -d- -f2) * 1000 + 10#${o##*-} ))
    [ "${ms}" -lt "${oms}" ] || continue
    case "${repl}" in *[!A-Za-z0-9./_-]*) continue ;; esac   # never interpolate exotic paths
    if [ "${DRY_RUN}" = 1 ]; then
      say "[dry-run] would repoint ${path} -> ${repl} (${oms}ms -> ${ms}ms)"
    else
      docker exec -i "${DB_CONTAINER}" psql -U racesow -d racesow -q -c \
        "UPDATE player_demo SET demo_path = '${repl}', time = ${ms}
          WHERE demo_path = '${path}' AND time >= ${ms}" </dev/null \
        && say "repointed ${path} -> ${repl}"
    fi
    repaired=$(( repaired + 1 ))
    printf '%s\n' "${path}" >> "${tmp}/repaired.txt"
  done < "${tmp}/unrecoverable.txt"
  say "stale rows repointed: ${repaired}"
  # A repointed row is servable now — keep --prune-missing from deleting it.
  if [ -s "${tmp}/repaired.txt" ] && [ "${DRY_RUN}" != 1 ]; then
    grep -vxF -f "${tmp}/repaired.txt" "${tmp}/unrecoverable.txt" > "${tmp}/u2.txt" || true
    mv "${tmp}/u2.txt" "${tmp}/unrecoverable.txt"
  fi
fi

# --- 5. optional: prune rows whose demo is gone for good --------------------
# NEVER run from the timer. A row that survives every step above points at a
# file no box has: the run pre-dates demo persistence, or the capturing server
# could not record one. It can only 404, so deleting the row is what stops the
# site advertising a dead download — but it IS destructive and a peer being
# briefly unreachable would look identical, so it stays a deliberate flag.
if [ "${PRUNE_MISSING}" = 1 ] && [ -s "${tmp}/unrecoverable.txt" ]; then
  pruned=0
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    case "${path}" in *[!A-Za-z0-9./_-]*) continue ;; esac
    if [ "${DRY_RUN}" = 1 ]; then
      say "[dry-run] would DELETE row ${path}"
    else
      docker exec -i "${DB_CONTAINER}" psql -U racesow -d racesow -q -c \
        "DELETE FROM player_demo WHERE demo_path = '${path}'" </dev/null \
        && say "pruned ${path}"
    fi
    pruned=$(( pruned + 1 ))
  done < "${tmp}/unrecoverable.txt"
  say "rows pruned: ${pruned}"
  exit 0
fi

if [ -s "${tmp}/unrecoverable.txt" ]; then
  say "no file anywhere for these (the run pre-dates demo persistence, or the"
  say "capturing server never wrote one) — they will keep 404ing until pruned:"
  sed 's/^/     /' "${tmp}/unrecoverable.txt"
fi
say "done: mirrored=${mirrored} aliased=${pending_aliases} pulled=${pulled} unservable=${still}"
