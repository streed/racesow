#!/usr/bin/env bash
# Push the authorized uploader keys to the box running the demo dropbox and
# reload the SFTP server so they take effect.
#
#   ./sync-keys.sh              # us.east, default port/paths
#   SFTP_BOX=ubuntu@other ./sync-keys.sh
#
# Note the --force-recreate: atmoz/sftp builds the jail's authorized_keys in its
# entrypoint on FIRST run only, so a plain `up -d` (no-op) or `restart` (user
# already exists) will NOT pick up a new .pub. Recreating the container is what
# rebuilds it. The host keys and the incoming/ dir are bind-mounted, so the
# server identity and any queued uploads survive; the blip is a second or two.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

box="${SFTP_BOX:-ubuntu@us.east.racesow.org}"
remote="${SFTP_REMOTE_DIR:-racesow/server}"
ssh_key="${SFTP_SSH_KEY:-$HOME/.ssh/warsow}"
ssh_cmd="ssh -o IdentitiesOnly=yes -o IdentityAgent=none -i $ssh_key"

keys=("$here"/keys/*.pub)
if [ ! -e "${keys[0]}" ]; then
  echo "error: no keys/*.pub to sync — run ./new-uploader.sh <name> first" >&2
  exit 1
fi

echo "Syncing ${#keys[@]} authorized key(s) to $box:$remote/sftp/keys/"
for k in "${keys[@]}"; do echo "  $(basename "$k")  $(ssh-keygen -lf "$k" | awk '{print $2}')"; done

# --delete so removing a .pub locally actually revokes that uploader on the box.
rsync -av --delete -e "$ssh_cmd" \
  "$here/keys/" "$box:$remote/sftp/keys/"
rsync -av -e "$ssh_cmd" \
  "$here/users.conf" "$box:$remote/sftp/users.conf"

$ssh_cmd "$box" "cd $remote && docker compose -f docker-compose.sftp.yml up -d --force-recreate"

echo
echo "Authorized keys now live in the jail:"
$ssh_cmd "$box" "docker exec racesow-sftp sh -c 'ssh-keygen -lf /home/demos/.ssh/authorized_keys'"
