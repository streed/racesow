#!/usr/bin/env bash
# install.sh — install + enable the Racesow systemd units for this checkout.
#
# Substitutes the checkout path and the invoking user into the unit templates
# in this directory, installs them to /etc/systemd/system, reloads systemd
# and enables the set matching the deployment shape:
#
#   systemd/install.sh full    # racesow-web + racesow-server + nightly DB backup
#   systemd/install.sh agent   # racesow-agent only (game server, no website)
#
# Prerequisites: the compose stacks work when started by hand (images built,
# .env files in place) and the invoking user can talk to Docker (docker
# group). Re-run after moving the checkout or editing the units. Needs sudo.
set -euo pipefail

MODE="${1:-full}"
case "${MODE}" in
    full|agent) ;;
    *) echo "usage: $0 [full|agent]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RACESOW_USER="$(id -un)"
UNIT_DIR=/etc/systemd/system

say() { printf '>> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

docker info >/dev/null 2>&1 \
    || die "user ${RACESOW_USER} cannot talk to Docker — the units run as this user"

if [ "${MODE}" = "full" ]; then
    UNITS="racesow-web.service racesow-server.service racesow-db-backup.service racesow-db-backup.timer"
    ENABLE="racesow-web.service racesow-server.service racesow-db-backup.timer"
else
    UNITS="racesow-agent.service"
    ENABLE="racesow-agent.service"
fi

for u in ${UNITS}; do
    sed -e "s#__RACESOW_DIR__#${REPO_ROOT}#g" \
        -e "s#__RACESOW_USER__#${RACESOW_USER}#g" \
        "${REPO_ROOT}/systemd/${u}" | sudo tee "${UNIT_DIR}/${u}" >/dev/null
    say "installed ${UNIT_DIR}/${u}"
done

sudo systemctl daemon-reload

# Catch template/syntax mistakes before enabling anything.
# shellcheck disable=SC2086
sudo systemd-analyze verify ${ENABLE} 2>&1 | grep -v "Command .* is not executable" || true

# shellcheck disable=SC2086
sudo systemctl enable --now ${ENABLE}
say "enabled: ${ENABLE}"
say "check with: systemctl status ${ENABLE}"
