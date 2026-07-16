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
# .env files in place) and the unit user can talk to Docker (docker group).
# Re-run after moving the checkout or editing the units. Needs sudo.
#
# The units run as $RACESOW_USER, which defaults to the invoking user. Override
# it to install units that run as a different account — e.g. scripts/cloud-init.sh
# runs this as root with RACESOW_USER=racesow to wire up a freshly provisioned box.
set -euo pipefail

MODE="${1:-full}"
case "${MODE}" in
    full|agent) ;;
    *) echo "usage: $0 [full|agent]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RACESOW_USER="${RACESOW_USER:-$(id -un)}"
UNIT_DIR=/etc/systemd/system

say() { printf '>> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# The units run as $RACESOW_USER, so check that account (not necessarily the
# invoker) can talk to Docker. Only root can probe another user without a
# password, which is exactly the cloud-init (RACESOW_USER != invoker) case.
if [ "${RACESOW_USER}" = "$(id -un)" ]; then
    docker info >/dev/null 2>&1 \
        || die "user ${RACESOW_USER} cannot talk to Docker — the units run as this user"
else
    sudo -u "${RACESOW_USER}" docker info >/dev/null 2>&1 \
        || die "user ${RACESOW_USER} cannot talk to Docker — the units run as this user"
fi

# Both tiers host game pk3 packs, so both get the weekly ClamAV pak scan.
if [ "${MODE}" = "full" ]; then
    UNITS="racesow-web.service racesow-server.service racesow-db-backup.service racesow-db-backup.timer racesow-pakscan.service racesow-pakscan.timer"
    ENABLE="racesow-web.service racesow-server.service racesow-db-backup.timer racesow-pakscan.timer"
else
    UNITS="racesow-agent.service racesow-pakscan.service racesow-pakscan.timer"
    ENABLE="racesow-agent.service racesow-pakscan.timer"
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
