#!/usr/bin/env bash
# Mint credentials for one demo-dropbox uploader.
#
#   ./new-uploader.sh alice
#
# Generates a dedicated ed25519 keypair, files the PUBLIC half under keys/ (which
# is committed and becomes an authorized key on the box), and leaves the PRIVATE
# half plus a ready-to-send instruction sheet in handouts/<name>/ (gitignored).
# Hand that folder to the person over a private channel, then delete it —
# nothing on our side ever needs the private key again.
#
# Run ./sync-keys.sh afterwards to push the new authorized key to the US box.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="${1:-}"

if [ -z "$name" ]; then
  echo "usage: $0 <uploader-name>   e.g. $0 alice" >&2
  exit 64
fi
# The name becomes a filename inside keys/ and a chunk of the key comment; keep
# it boring so it can never escape the directory or confuse authorized_keys.
if ! printf '%s' "$name" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,30}$'; then
  echo "error: name must be lowercase [a-z0-9._-], max 31 chars (got '$name')" >&2
  exit 64
fi

pub="$here/keys/$name.pub"
out="$here/handouts/$name"

if [ -e "$pub" ]; then
  echo "error: $pub already exists — pick another name, or remove it to rotate" >&2
  exit 1
fi
if [ -e "$out" ]; then
  echo "error: $out already exists (a previous unsent handout?) — remove it first" >&2
  exit 1
fi

host="${SFTP_HOST:-us.east.racesow.org}"
port="${SFTP_PORT:-2222}"

mkdir -p "$here/handouts"
chmod 700 "$here/handouts"
mkdir -p "$out"
chmod 700 "$out"

ssh-keygen -q -t ed25519 -N '' \
  -C "racesow-demo-upload-$name" \
  -f "$out/id_ed25519"

cp "$out/id_ed25519.pub" "$pub"
chmod 644 "$pub"

fp="$(ssh-keygen -lf "$out/id_ed25519.pub" | awk '{print $2}')"

# The server's own host key fingerprints, so the uploader can verify the box on
# first connect instead of blindly typing "yes". Read from the local hostkeys/
# dir when running ON the box, otherwise scanned off the live server.
hostfps=""
for hk in "$here/hostkeys/ssh_host_ed25519_key.pub" "$here/hostkeys/ssh_host_rsa_key.pub"; do
  [ -f "$hk" ] && hostfps="$hostfps  $(ssh-keygen -lf "$hk")
"
done
if [ -z "$hostfps" ]; then
  hostfps="$(ssh-keyscan -p "$port" -t ed25519,rsa "$host" 2>/dev/null \
    | ssh-keygen -lf - 2>/dev/null | sed 's/^/  /')
"
fi
[ -n "${hostfps//[[:space:]]/}" ] || hostfps="  (ask $USER for the host key fingerprints)
"

cat > "$out/README.txt" <<EOF
Racesow demo upload — credentials for: $name
=============================================

You can upload client-recorded race demos (.wdz20) to the Racesow network.
Uploaded demos are virus-scanned, parsed, and attributed to the map/player/time
recorded inside the demo itself, so the filename does not matter.

1. Save the enclosed private key
-------------------------------
Save the file 'id_ed25519' to your ~/.ssh/ directory and lock it down:

    mkdir -p ~/.ssh
    mv id_ed25519 ~/.ssh/racesow-demo
    chmod 600 ~/.ssh/racesow-demo

Keep it private — it is the only thing that authenticates you. Do not email it
onward, commit it, or paste it into chat. If it leaks, tell $USER and we will
revoke it.

2. Add a shortcut (optional, but makes step 3 one word)
-------------------------------------------------------
Append to ~/.ssh/config:

    Host racesow-demos
        HostName $host
        Port $port
        User demos
        IdentityFile ~/.ssh/racesow-demo
        IdentitiesOnly yes

3. Upload
---------
    sftp racesow-demos               # or: sftp -P $port -i ~/.ssh/racesow-demo demos@$host
    sftp> put my_run.wdz20 incoming/
    sftp> bye

Everything must go inside 'incoming/' — that is the only writable directory.
Demos are picked up automatically a couple of minutes after upload; there is
nothing else to do. You cannot list or download other people's files, and the
account has no shell.

On the very first connect you will be asked to trust the server. The expected
fingerprints are:

$hostfps
Your key fingerprint (for our records): $fp
EOF

chmod 600 "$out/id_ed25519" "$out/README.txt"

cat <<EOF
Created uploader '$name'
  authorized key : keys/$name.pub    ($fp)
  handout        : $out/  (private key + README.txt — send, then delete)

Next:
  $here/sync-keys.sh        # push authorized keys to the box + reload sshd
  git add $pub && git commit
EOF
