#!/usr/bin/env bash
# rolling-deploy.sh — zero-downtime deploy of the web / API layer.
#
# The site runs TWO web replicas (web on :8080, web2 on :8081 — see
# docker-compose.override.yml) behind an nginx upstream (deploy/nginx). This
# script rebuilds the web image, then recreates the replicas ONE AT A TIME,
# waiting for each to pass /api/health before touching the next. nginx keeps
# routing to the healthy replica throughout, so there is no 502 window.
#
# The replicas are stateless (all state is in Postgres); the aggregate-table
# rebuild is guarded by a Postgres advisory lock, so the brief mixed-version
# overlap during a roll is safe (see web/db.js refreshAggregates).
#
# Run on the central stats box from the repo root:
#   scripts/rolling-deploy.sh
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# service name -> host health port (must match docker-compose.override.yml).
REPLICAS=("web:8080" "web2:8081")
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
# nginx marks a replica failed for fail_timeout=5s (deploy/nginx/racesow.conf)
# after it goes down. Wait longer than that after the fresh replica passes
# /api/health so nginx has returned it to rotation before the peer is killed.
DRAIN_SECONDS="${DRAIN_SECONDS:-6}"

say() { printf '>> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose config --services 2>/dev/null | grep -qx web2 \
    || die "the web2 replica is not defined — is docker-compose.override.yml in place with two web replicas?"

# Preflight: the hand-copied web2 block MUST mirror web (env + volumes), or
# nginx's round-robin serves broken responses for half of all requests. Drift
# here once shipped a web2 with no GHOST_DIR/DEMO_BASE_URL/maps mount —
# ghosts, demo links and replay meshes failed intermittently for weeks.
# Compares the RENDERED config (after .env interpolation), so a var missing
# from web2's environment: block is caught even when .env defines it.
say "preflight: checking web2 config parity with web"
if compose_json="$(docker compose config --format json 2>/dev/null)"; then
    printf '%s' "${compose_json}" | python3 -c '
import json, sys
svcs = json.load(sys.stdin)["services"]
web, web2 = svcs["web"], svcs["web2"]
env_w = web.get("environment") or {}
env_2 = web2.get("environment") or {}
problems = []
missing = sorted(k for k in env_w if k not in env_2)
differ = sorted(k for k in env_w if k in env_2 and env_w[k] != env_2[k])
if missing:
    problems.append("web2 missing env: " + ", ".join(missing))
if differ:
    problems.append("web2 env differs: " + ", ".join(differ))
def mounts(svc):
    out = set()
    for v in svc.get("volumes") or []:
        out.add(v.get("target") if isinstance(v, dict) else str(v).split(":")[1])
    return out
vmissing = sorted(mounts(web) - mounts(web2))
if vmissing:
    problems.append("web2 missing volumes: " + ", ".join(vmissing))
if problems:
    sys.exit("REPLICA DRIFT — " + "; ".join(problems)
             + "\nSync web2 in docker-compose.override.yml with web before deploying.")
' || die "web/web2 config drift detected (see above)"
else
    say "WARNING: 'docker compose config --format json' unsupported — skipping parity check"
fi

wait_health() {
    local port="$1" name="$2"
    for _ in $(seq 1 "${HEALTH_TIMEOUT}"); do
        if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
            say "${name} healthy on :${port}"
            return 0
        fi
        sleep 1
    done
    die "${name} did not become healthy on :${port} within ~${HEALTH_TIMEOUT}s — ABORTING (the peer replica is still serving; investigate before re-running)"
}

# Preflight: both replicas MUST be healthy before we start rolling, or the
# "peer keeps serving" guarantee doesn't hold — recreating the only serving
# replica is a guaranteed full outage. FORCE=1 rolls anyway (accepting
# downtime), e.g. to recover after an aborted roll left one replica down.
say "preflight: checking both replicas are up"
for entry in "${REPLICAS[@]}"; do
    svc="${entry%%:*}"; port="${entry##*:}"
    if ! curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
        if [ "${FORCE:-0}" = "1" ]; then
            say "WARNING: ${svc} (:${port}) is not healthy — rolling anyway because FORCE=1"
        else
            die "${svc} (:${port}) is not healthy — rolling now would take the site down. Bring the stack up first (docker compose up -d), or re-run with FORCE=1 to accept the outage."
        fi
    fi
done

say "building the web image"
docker compose build web

first=1
for entry in "${REPLICAS[@]}"; do
    svc="${entry%%:*}"; port="${entry##*:}"
    if [ "${first}" -eq 0 ]; then
        say "waiting ${DRAIN_SECONDS}s for nginx to return the fresh replica to rotation"
        sleep "${DRAIN_SECONDS}"
    fi
    first=0
    say "recreating ${svc} on the new image (the peer keeps serving traffic)"
    docker compose up -d --no-deps --force-recreate "${svc}"
    wait_health "${port}" "${svc}"
done

say "rolling deploy complete — both replicas on the new image, no downtime"
