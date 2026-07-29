# SFTP demo dropbox (US box)

A hardened, **key-only, chrooted** SFTP endpoint where trusted people drop
client-recorded race demos. It is an **isolated quarantine** — files land in
`server/sftp-uploads/demos/incoming/` and are *not* served or trusted until the
host-side watcher (`scripts/ingest-demos.sh`) AV-scans, parses
(`web/demo-meta.mjs`) and promotes them.

See the header of `../docker-compose.sftp.yml` for the full design rationale.

## First-time setup (on the US box, from the `server/` dir)

```sh
mkdir -p sftp/hostkeys sftp-uploads/demos/incoming
# Persistent host keys (so clients don't hit a MITM warning on every restart):
ssh-keygen -t ed25519 -f sftp/hostkeys/ssh_host_ed25519_key -N ''
ssh-keygen -t rsa -b 4096 -f sftp/hostkeys/ssh_host_rsa_key -N ''

docker compose -f docker-compose.sftp.yml up -d
sudo ufw allow 2222/tcp          # dedicated port, distinct from admin SSH (22)
```

`sftp-uploads/` and `sftp/hostkeys/` are gitignored (runtime data / private keys);
`sftp/keys/*.pub` and `sftp/users.conf` are committed (public).

## Add / remove an uploader

Uploaders authenticate with an SSH **public** key — passwords are disabled.

```sh
# add: drop their public key and recreate the container
cp their_key.pub sftp/keys/alice.pub
docker compose -f docker-compose.sftp.yml up -d      # re-reads keys on start

# remove: delete the .pub and recreate
rm sftp/keys/alice.pub
docker compose -f docker-compose.sftp.yml up -d
```

All `*.pub` in `sftp/keys/` are appended to the shared `demos` jail's
`authorized_keys` at container start. `admin.pub` is a bootstrap key — replace it
with the real uploaders' keys.

To give people **separate** jails instead of one shared account, add
`bob::1501:1501:incoming` lines to `users.conf` and matching
`./sftp/keys-bob:/home/bob/.ssh/keys` + `./sftp-uploads/bob:/home/bob/incoming`
volumes in the compose file.

## Uploading (client side)

```sh
sftp -P 2222 demos@us.east.racesow.org
sftp> put my_run.wdz20 incoming/
```

Only `.wdz20` (or `.wd`) race demos are useful — anything else is rejected by the
ingestion watcher. The demo's own metadata (map, runner, finish time) is what
attributes it, so the filename doesn't matter.

## Ingestion watcher (turns uploads into records)

`scripts/ingest-demos.sh` is the host-side half: every couple of minutes it
picks up settled `*.wdz20` files from the incoming dirs, ClamAV-scans them,
parses each with `web/demo-meta.mjs` (in a `node:20` container) to recover
`{map, runner, finish time}`, and POSTs a `wr_demo` pointer to the stats ingest —
the same attribution path the game module uses for server demos. Clean, parsed
demos are staged under `sftp-uploads/.promoted/<map>/` with a canonical
`<map>_<clean>_<MM-SS-mmm>.wdz20` name; unparseable ones go to `.rejected/`.

Install the timer on the US box (mirrors what `systemd/install.sh` does), from
the repo root:

```sh
for u in racesow-demo-ingest.service racesow-demo-ingest.timer; do
  sed "s#__RACESOW_DIR__#$PWD#g" "systemd/$u" | sudo tee "/etc/systemd/system/$u" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now racesow-demo-ingest.timer
sudo systemctl start racesow-demo-ingest        # process anything already waiting
journalctl -u racesow-demo-ingest -f            # or tail demo-ingest.log
```

Config (env / systemd `EnvironmentFile=.env`):

| var | default | meaning |
|-----|---------|---------|
| `INGEST_URL`, `INGEST_TOKEN` | from `.env` | stats ingest endpoint + this box's token (already set for the game) |
| `DEMO_INGEST_VERSION` | `client` | provenance tag stored on the demo row |
| `DEMO_DELIVER_DEST` | *(unset)* | rsync target for the served demos tree, e.g. `ubuntu@eu.frankfurt.racesow.org:racesow/server/demos/server`. **Unset ⇒ attribution still works, but the download link 404s until the file is delivered** (the site serves demos from one host via `DEMO_BASE_URL`). |
| `DEMO_MIN_AGE_SEC` | `20` | ignore files modified more recently than this (still uploading) |

Needs `clamav` (`apt install clamav clamav-freshclam`) for the AV gate — without
it the watcher logs a note and proceeds (demos from trusted uploaders).

## Hardening notes

- Key-only (no passwords), `ForceCommand internal-sftp`, per-user chroot, no
  shell, `no-new-privileges`. The jail can't see or touch the rest of the box.
- The port is internet-facing. If the uploaders' source IPs are stable, tighten
  UFW to them: `sudo ufw allow from <ip> to any port 2222 proto tcp` then
  `sudo ufw delete allow 2222/tcp`.
- Pin the image to a digest (`atmoz/sftp:alpine@sha256:...`) after the first pull
  for supply-chain stability.
