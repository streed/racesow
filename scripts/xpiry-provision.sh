#!/usr/bin/env bash
# xpiry-provision.sh — stand up (idempotently) the xpiry.dev monitors + status
# page for Racesow, then emit the per-box heartbeat ping URLs.
#
# Run this ONCE from your workstation (not on the boxes) with a Pro/Agency
# XPIRY_API_KEY exported. It talks only to the xpiry REST API — it does not
# touch the game boxes. Re-running is safe: it finds existing objects by name
# and only fills in what's missing.
#
#   XPIRY_API_KEY=xxxxxxxx ./scripts/xpiry-provision.sh
#   XPIRY_DRY_RUN=1 ./scripts/xpiry-provision.sh      # print intended calls, no writes
#
# What it creates under the `racesow.org` domain:
#   * external checks (xpiry runs these itself — no code on our side):
#       - HTTP uptime      -> https://racesow.org  (path XPIRY_UPTIME_PATH, /api/health)
#       - SSL cert expiry, domain-registration expiry, DNS + redirect watch
#   * heartbeat monitors (WE push these from the boxes; see xpiry-heartbeat.sh):
#       rs-eu-warsow  rs-eu-warfork   (group "Game Servers")
#       rs-us-warsow  rs-us-warfork
#       rs-eu-tv      rs-us-tv        (group "Live Streams")
#   * the public status page for the domain (grouped by the above).
#
# OUTPUT: the ping URL for each heartbeat monitor, split per box, written to
# scripts/xpiry-monitors.local.env (gitignored). Drop the EU block into
# eu.frankfurt's repo-root .env and the US block into us.east's, then install
# the heartbeat timer on each box (systemd/install.sh). See docs/xpiry-monitoring.md.
#
# NOTE: xpiry's exact JSON field names for the ping URL / monitor token are not
# fully pinned down in the public docs, so this script is defensive (it tries a
# few shapes) and prints what it saw. Eyeball the first real run; if a ping URL
# comes out empty, set XPIRY_VERBOSE=1 to dump the raw responses and adjust the
# `ping_url_of` extraction below to match.
set -euo pipefail

BASE_URL="${XPIRY_BASE_URL:-https://xpiry.dev/api/v1}"
DOMAIN="${XPIRY_DOMAIN:-racesow.org}"
UPTIME_PATH="${XPIRY_UPTIME_PATH:-/api/health}"   # truer signal than the SPA root
DRY_RUN="${XPIRY_DRY_RUN:-0}"
VERBOSE="${XPIRY_VERBOSE:-0}"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ENV="${XPIRY_OUT_ENV:-${REPO_ROOT}/scripts/xpiry-monitors.local.env}"

# ping base = the API base with /api/v1 stripped (docs show root /ping/<token>).
PING_BASE="${XPIRY_PING_BASE:-${BASE_URL%/api/v1}}"

say()  { printf '>> %s\n' "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
vlog() { [ "${VERBOSE}" = 1 ] && printf '   %s\n' "$*" >&2 || true; }

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v jq   >/dev/null 2>&1 || die "jq not found (apt install jq / brew install jq)"
if [ "${DRY_RUN}" != 1 ] && [ -z "${XPIRY_API_KEY:-}" ]; then
    die "XPIRY_API_KEY unset. Generate a key in xpiry Account settings (needs Pro/Agency)."
fi

# xp METHOD PATH [json-body] -> prints response body; sets XP_CODE to the HTTP status.
# On DRY_RUN, mutating verbs are printed and skipped (GETs still run so lookups work
# only when a key is present; with no key under DRY_RUN they no-op to {}).
XP_CODE=""
xp() {
    local method="$1" path="$2" body="${3:-}"
    if [ "${DRY_RUN}" = 1 ] && [ "${method}" != "GET" ]; then
        printf '>> [dry-run] %s %s%s\n' "${method}" "${path}" "${body:+  ${body}}" >&2
        XP_CODE=200; echo '{}'; return 0
    fi
    if [ -z "${XPIRY_API_KEY:-}" ]; then XP_CODE=000; echo '{}'; return 0; fi
    local tmp rc; tmp="$(mktemp)"
    local -a args=(-sS -X "${method}" -H "Authorization: Bearer ${XPIRY_API_KEY}"
                   -H "Accept: application/json" -w '%{http_code}' -o "${tmp}"
                   --max-time 30)
    [ -n "${body}" ] && args+=(-H "Content-Type: application/json" -d "${body}")
    XP_CODE="$(curl "${args[@]}" "${BASE_URL}${path}")" || rc=$?
    vlog "${method} ${path} -> ${XP_CODE}"
    # Surface API errors instead of swallowing them (this loop never aborts, so a
    # 4xx/5xx would otherwise pass unnoticed). 403 on a monitor create = plan cap.
    case "${XP_CODE}" in
        2*) ;;
        *) printf '>> WARN %s %s -> HTTP %s: %s\n' "${method}" "${path}" "${XP_CODE}" \
               "$(head -c 300 "${tmp}" | tr '\n' ' ')" >&2 ;;
    esac
    cat "${tmp}"; rm -f "${tmp}"
    return 0
}

# Pull a usable ping URL out of a monitor object, trying the shapes xpiry might use.
ping_url_of() {
    jq -r --arg base "${PING_BASE}" '
        .ping_url
        // .ping.url
        // (.ping_token   // empty | select(.!="") | $base + "/ping/" + .)
        // (.token        // empty | select(.!="") | $base + "/ping/" + .)
        // (.monitor.ping_url // empty)
        // empty
    ' 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1) Domain: find or create, then enable the external checks xpiry runs itself.
# ---------------------------------------------------------------------------
say "domain ${DOMAIN}: looking up…"
domains_json="$(xp GET /domains)"
DOMAIN_ID="$(printf '%s' "${domains_json}" | jq -r --arg d "${DOMAIN}" \
    '(.domains // .data // .) | if type=="array" then . else [] end
     | map(select(.domain==$d or .name==$d)) | .[0].id // empty')"

if [ -z "${DOMAIN_ID}" ]; then
    say "domain ${DOMAIN}: not found — creating"
    created="$(xp POST /domains "$(jq -nc --arg d "${DOMAIN}" '{domain:$d}')")"
    DOMAIN_ID="$(printf '%s' "${created}" | jq -r \
        '(.domain.id // .id // (.domains[0].id) // (.results[0].id)) // empty')"
    [ "${DRY_RUN}" = 1 ] && DOMAIN_ID="${DOMAIN_ID:-DRYRUN}"
    [ -n "${DOMAIN_ID}" ] || die "could not determine domain id from create response: ${created}"
    say "domain ${DOMAIN}: created id=${DOMAIN_ID}"
    printf '%s' "${created}" | jq -r '.txt_record // .verification.txt // empty' \
        | grep -q . && say "NOTE: add the TXT record above to verify ownership (see the dashboard)."
else
    say "domain ${DOMAIN}: found id=${DOMAIN_ID}"
fi

say "domain ${DOMAIN}: enabling uptime + ssl + expiry + dns + redirect checks"
xp PATCH "/domains/${DOMAIN_ID}" "$(jq -nc --arg p "${UPTIME_PATH}" '{
    domain: {
        paused: false,
        ssl_enabled: true,
        expiry_monitoring: true,
        uptime_enabled: true,
        uptime_path: $p,
        dns_enabled: true,
        redirect_enabled: true
    }
}')" >/dev/null

# ---------------------------------------------------------------------------
# 2) Heartbeat monitors. name|group|expected_interval|grace_period
#    grace rides over the nightly 5am restart so a normal bounce never pages.
# ---------------------------------------------------------------------------
MONITORS="
rs-eu-warsow|Game Servers|60|600
rs-eu-warfork|Game Servers|60|600
rs-us-warsow|Game Servers|60|600
rs-us-warfork|Game Servers|60|600
rs-eu-tv|Live Streams|60|300
rs-us-tv|Live Streams|60|300
"

existing="$(xp GET "/domains/${DOMAIN_ID}/monitors")"
declare -A PING   # name -> ping url

while IFS='|' read -r name group interval grace; do
    [ -n "${name}" ] || continue
    obj="$(printf '%s' "${existing}" | jq -c --arg n "${name}" \
        '((.monitors // .data // .) | if type=="array" then . else [] end)
         | map(select(.name==$n)) | .[0] // empty')"
    if [ -z "${obj}" ] || [ "${obj}" = "null" ]; then
        say "monitor ${name}: creating (${group}, grace ${grace}s)"
        body="$(jq -nc --arg n "${name}" --arg g "${group}" \
                     --argjson i "${interval}" --argjson gr "${grace}" '{
            monitor: {
                name: $n, kind: "heartbeat",
                expected_interval_seconds: $i, grace_period_seconds: $gr,
                component_group: $g, show_on_status_page: true, enabled: true
            }
        }')"
        obj="$(xp POST "/domains/${DOMAIN_ID}/monitors" "${body}")"
        obj="$(printf '%s' "${obj}" | jq -c '.monitor // .')"
    else
        say "monitor ${name}: exists"
    fi
    url="$(printf '%s' "${obj}" | ping_url_of)"
    [ "${DRY_RUN}" = 1 ] && url="${url:-${PING_BASE}/ping/DRYRUN-${name}}"
    PING["${name}"]="${url}"
    [ -n "${url}" ] || say "WARN monitor ${name}: no ping URL in response (set XPIRY_VERBOSE=1 and inspect)"
done <<< "${MONITORS}"

# ---------------------------------------------------------------------------
# 3) Status page for the domain.
# ---------------------------------------------------------------------------
# Enable the status page. We deliberately do NOT set a theme here — xpiry
# validates it against a fixed list (e.g. "ocean"; "auto" is rejected 422) and
# we don't want to clobber a theme picked in the dashboard. Set it there.
say "status page: enabling for ${DOMAIN}"
sp_body='{ "status_page": { "enabled": true } }'
[ -n "${XPIRY_STATUS_CUSTOM_DOMAIN:-}" ] && sp_body="$(jq -nc --arg cd "${XPIRY_STATUS_CUSTOM_DOMAIN}" \
    '{status_page:{enabled:true, custom_domain:$cd}}')"
xp PATCH "/domains/${DOMAIN_ID}/status_page" "${sp_body}" >/dev/null

# ---------------------------------------------------------------------------
# 4) Optional alert channel (only if you pass one).
# ---------------------------------------------------------------------------
if [ -n "${XPIRY_ALERT_DISCORD_WEBHOOK:-}" ]; then
    say "alert rule: creating Discord channel"
    xp POST /alert_rules "$(jq -nc --arg u "${XPIRY_ALERT_DISCORD_WEBHOOK}" \
        '{alert_rule:{name:"racesow-discord", kind:"discord", enabled:true, config:{webhook_url:$u}}}')" >/dev/null
fi
if [ -n "${XPIRY_ALERT_EMAIL:-}" ]; then
    say "alert rule: creating email channel -> ${XPIRY_ALERT_EMAIL}"
    xp POST /alert_rules "$(jq -nc --arg e "${XPIRY_ALERT_EMAIL}" \
        '{alert_rule:{name:"racesow-email", kind:"email", enabled:true, config:{email:$e}}}')" >/dev/null
fi

# ---------------------------------------------------------------------------
# 5) Emit the per-box heartbeat env.
# ---------------------------------------------------------------------------
{
    echo "# Generated by scripts/xpiry-provision.sh — DO NOT COMMIT (gitignored)."
    echo "# Heartbeat ping URLs for scripts/xpiry-heartbeat.sh. Append the block for"
    echo "# each box to that box's repo-root .env, then install the timer:"
    echo "#   systemd/install.sh full   # on eu.frankfurt"
    echo "#   systemd/install.sh agent  # on us.east"
    echo "#"
    echo "# NOTE: xpiry's ping endpoint requires auth on this account, so each box's"
    echo "# .env must ALSO contain the API key (not repeated here — it's a secret):"
    echo "#   XPIRY_API_KEY=<the key from .env.production>"
    echo
    echo "# ===== eu.frankfurt.racesow.org  (append to .env) ====="
    echo "XPIRY_PING_WARSOW=${PING[rs-eu-warsow]:-}"
    echo "XPIRY_PING_WARFORK=${PING[rs-eu-warfork]:-}"
    echo "XPIRY_PING_TV=${PING[rs-eu-tv]:-}"
    echo
    echo "# ===== us.east.racesow.org  (append to .env) ====="
    echo "# (these lines use the same var NAMES — put them in the US box's .env, not EU's)"
    echo "XPIRY_PING_WARSOW=${PING[rs-us-warsow]:-}"
    echo "XPIRY_PING_WARFORK=${PING[rs-us-warfork]:-}"
    echo "XPIRY_PING_TV=${PING[rs-us-tv]:-}"
} > "${OUT_ENV}"

say "wrote per-box ping URLs -> ${OUT_ENV}"
say "done. Next:"
say "  1. Split ${OUT_ENV} into each box's .env (EU block -> eu, US block -> us)."
say "  2. On each box: git pull, then systemd/install.sh {full|agent} to start the heartbeat timer."
say "  3. Status page: dashboard -> domain ${DOMAIN} -> Status Page. For a custom URL,"
say "     CNAME status.racesow.org -> xpiry (see docs/xpiry-monitoring.md) and re-run with"
say "     XPIRY_STATUS_CUSTOM_DOMAIN=status.racesow.org."
