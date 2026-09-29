# Map store runbook: NFS over WireGuard, EU → US

This runbook sets up the shared map store in production. The EU box keeps the
one copy of the map pool. The US box reads it over NFS through a private
WireGuard tunnel, and keeps a local snapshot to fall back on. Every game server
loads new packs while it runs.

For how it works and why, see [shared-maps.md](shared-maps.md). This file is
the how-to. Follow it top to bottom. Every step ends with a check, so do not
start a step until the one before it checks out.

Time needed: about an hour of hands-on work, plus the first snapshot sync (a
few minutes if you seed it from the US box's existing pool, as step E does).
Player-facing downtime: one normal game-server restart on each box (step F),
with the usual notice.

## Contents

- [The layout](#the-layout)
- [Before you start](#before-you-start)
- [A. Ship the code](#a-ship-the-code-both-boxes-no-behaviour-change)
- [B. WireGuard tunnel](#b-wireguard-tunnel-both-boxes)
- [C. NFS export](#c-nfs-export-eu)
- [D. NFS mount](#d-nfs-mount-us)
- [E. First snapshot and the timer](#e-first-snapshot-and-the-timer-us)
- [F. Switch the US game servers over](#f-switch-the-us-game-servers-over-us)
- [G. Generated maps publish into the store](#g-generated-maps-publish-into-the-store-eu)
- [H. Failure drills](#h-failure-drills-do-them-once-before-you-rely-on-it)
- [I. Clean up the old US pool](#i-clean-up-the-old-us-pool-us-a-week-later)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)
- [Rollback](#rollback)
- [Security notes](#security-notes)
- [Files this runbook installs](#files-this-runbook-installs)

## The layout

| | EU (`eu.frankfurt.racesow.org`) | US (`us.east.racesow.org`) |
| --- | --- | --- |
| Role | owns the store; the only writer | reads the store |
| Map pool | `~/racesow/server/maps` (local disk) | `/srv/racesow/maps` (NFS mount, read-only) |
| Fallback | none needed | `~/racesow/server/maps-snapshot` (local copy, hourly) |
| WireGuard | `10.66.0.1`, UDP 51820 | `10.66.0.2`, UDP 51820 |
| NFS | nfsd on `10.66.0.1:2049` (TCP), NFSv4.2 only | client |
| Export | `/srv/racesow/store` (bind mount of `server/maps`) | — |
| Warsow reads | `server/maps` as `fs_cdpath` | the NFS mount as `fs_cdpath`; the snapshot if it does not answer at launch |
| Warfork reads | `server/maps` as `fs_cdpath` | the NFS mount as `fs_cdpath`; the snapshot if it does not answer at launch |
| Game compose | `server/docker-compose.yml`, reads `server/.env` | `docker-compose.agent.yml` + `docker-compose.warfork.yml`, read `~/racesow/.env` |
| Who adds maps | `scripts/fetch-maps.sh`, the mapgen worker | nobody (`fetch-maps.sh` refuses) |

The repository is checked out at `~/racesow` on both boxes. Wherever a template
says `__RACESOW_DIR__`, use the absolute path: `readlink -f ~/racesow`, run as
the deploy user.

Placeholders used below:

```bash
DEPLOY_USER=<the box login>                 # see .claude/skills/deploy-production
RACESOW_DIR=/home/$DEPLOY_USER/racesow      # confirm with: readlink -f ~/racesow
EU_PUBLIC_IP=<eu.frankfurt public IPv4>     # dig +short eu.frankfurt.racesow.org
US_PUBLIC_IP=<us.east public IPv4>          # dig +short us.east.racesow.org
```

## Before you start

- [ ] Both boxes are on the commit that contains this runbook, or later (step A).
- [ ] You have sudo on both boxes. Every command below that edits `/etc` or
      touches systemd needs it. The rest run as the deploy user in `~/racesow`.
- [ ] **Kernel and packages.** Ubuntu or Debian with the stock kernel (it has
      WireGuard and the NFS server built in).
- [ ] **Disk on US.** The snapshot is a second copy of the pool: check
      `du -sh ~/racesow/server/maps` on EU (about 12.5 GB) and leave at least
      that much plus 25% free on US. With the step E seed the snapshot starts as
      hard links into the existing US pool, so it only takes real space once
      step I deletes that pool.
- [ ] **Firewall.** The examples use `ufw`. If the boxes use something else, or
      the host has a cloud firewall or security group, open the same two
      things there: UDP 51820 from the other box only, and TCP 2049 on the
      tunnel only.
- [ ] **A quiet window** for step F, which restarts the US game servers.
      Announce it the usual way (deploy-production skill, section 3).

## A. Ship the code (both boxes, no behaviour change)

Deploy the commit that contains this runbook the normal way
(`.claude/skills/deploy-production`), including rebuilding and recreating both
game servers on both boxes. With no store configured nothing changes for
players: `MAP_STORE_DIR` defaults to the box's own `server/maps`, which the
engine now reads through `fs_cdpath` instead of per-file symlinks.

**Check, on each box:**

```bash
docker logs warsow-race 2>&1 | grep -E '>> map store|mapscan'
#  >> map store: /warsow/shared/racemod
docker exec warsow-race sh -c 'ls /warsow/shared/racemod | wc -l'   # the pool's pack count
```

Vote a map in game, or `rcon map <name>`, and confirm it loads.

## B. WireGuard tunnel (both boxes)

**1. Install and make keys.** On **each** box:

```bash
sudo apt install -y wireguard
umask 077
wg genkey | sudo tee /etc/wireguard/wg-racesow.key | wg pubkey | sudo tee /etc/wireguard/wg-racesow.pub
```

The private key never leaves its box. Copy each box's **public** key (the line
the command prints) to the other box's config.

**2. Configure.** On EU, create `/etc/wireguard/wg-racesow.conf` from
[`deploy/map-store/wg-racesow.eu.conf.example`](../deploy/map-store/wg-racesow.eu.conf.example);
on US from
[`wg-racesow.us.conf.example`](../deploy/map-store/wg-racesow.us.conf.example).
Paste the box's own private key (`sudo cat /etc/wireguard/wg-racesow.key`) and
the other box's public key. Then:

```bash
sudo chmod 600 /etc/wireguard/wg-racesow.conf
```

**3. Open the port.** WireGuard answers only to packets signed by the peer's
key, but there is no reason to let anyone else reach it:

```bash
# on EU
sudo ufw allow from $US_PUBLIC_IP to any port 51820 proto udp comment 'racesow map store tunnel'
# on US
sudo ufw allow from $EU_PUBLIC_IP to any port 51820 proto udp comment 'racesow map store tunnel'
```

**4. Start it** (on both boxes, now and at every boot):

```bash
sudo systemctl enable --now wg-quick@wg-racesow
```

**Check:**

```bash
sudo wg show wg-racesow          # "latest handshake: N seconds ago" and transfer counters moving
ping -c 3 10.66.0.2              # from EU
ping -c 3 10.66.0.1              # from US
```

No handshake usually means a key pasted into the wrong box, a firewall
(including a cloud one) dropping UDP 51820, or a wrong `Endpoint`.

## C. NFS export (EU)

**1. Sentinel.** Every reader tells "the store is up" from "the mount is an
empty directory" by this file. It must stay in the store for good:

```bash
cd ~/racesow && touch server/maps/.racesow-map-store
```

**2. Permissions.** The reader is anonymous (`all_squash`), so every pack must
be world-readable and the directory world-searchable. `fetch-maps.sh` and the
mapgen worker already write packs `0644`. Fix anything older:

```bash
chmod 755 ~/racesow/server/maps
find ~/racesow/server/maps -maxdepth 1 -name '*.pk3' ! -perm -004 -exec chmod o+r {} +
```

**3. A neutral export path.** Export a bind mount at `/srv/racesow/store`
rather than the checkout itself. Otherwise the anonymous reader would need
execute permission on your home directory.

```bash
sudo mkdir -p /srv/racesow/store
# /etc/fstab: the line from deploy/map-store/fstab.eu.example, with __RACESOW_DIR__ = $RACESOW_DIR
echo "$RACESOW_DIR/server/maps  /srv/racesow/store  none  bind,nofail  0  0" | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount /srv/racesow/store
ls /srv/racesow/store/.racesow-map-store   # the sentinel is visible through the bind
```

**4. Install the NFS server, v4.2 only, on the tunnel only:**

```bash
sudo apt install -y nfs-kernel-server
sudo cp deploy/map-store/nfs.conf.example /etc/nfs.conf.d/racesow.conf
sudo mkdir -p /etc/systemd/system/nfs-server.service.d
sudo cp deploy/map-store/nfs-server-after-wg.conf /etc/systemd/system/nfs-server.service.d/racesow.conf
sudo cp deploy/map-store/exports.example /etc/exports.d/racesow.exports
sudo systemctl daemon-reload
sudo systemctl enable nfs-server
sudo systemctl restart nfs-server
sudo exportfs -ra
```

The drop-in orders nfsd after the tunnel and the bind mount. Without it nfsd
can start first at boot, fail to bind to `10.66.0.1`, and stay down.

**5. Firewall.** Allow NFS on the tunnel interface only:

```bash
sudo ufw allow in on wg-racesow to any port 2049 proto tcp comment 'racesow map store NFS'
```

**6. Optional hardening.** NFSv4-only needs no rpcbind. If nothing else on the
box uses NFSv3 or NIS, you can stop it listening on the internet:
`sudo systemctl mask --now rpcbind.service rpcbind.socket`, then
`sudo systemctl restart nfs-server` and re-run the checks below.

**Check:**

```bash
sudo exportfs -v
#  /srv/racesow/store  10.66.0.2/32(... ro ... all_squash ...)   one line, the US address only
sudo ss -tlnp | grep ':2049'
#  LISTEN ... 10.66.0.1:2049 ...     <- the tunnel address only, never 0.0.0.0
cat /proc/fs/nfsd/versions
#  -3 -4 +4.1 +4.2                   (the exact format varies by kernel)
```

From outside the tunnel (your laptop, for example), `nc -vz $EU_PUBLIC_IP 2049`
must fail.

## D. NFS mount (US)

```bash
sudo apt install -y nfs-common rsync
sudo mkdir -p /srv/racesow/maps
# /etc/fstab: the line from deploy/map-store/fstab.us.example
grep -v '^#' deploy/map-store/fstab.us.example | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /srv/racesow/maps
```

The mount options, and why each one is there, are commented in
[`fstab.us.example`](../deploy/map-store/fstab.us.example). In short:
read-only; `soft` with short timeouts, so a dead link becomes an I/O error
within about 15 s instead of a hung game server; and `nofail`, so boot never
waits on the link.

**Check:**

```bash
findmnt /srv/racesow/maps                     # nfs4, ro, 10.66.0.1:/srv/racesow/store
ls /srv/racesow/maps/.racesow-map-store       # the sentinel
ls /srv/racesow/maps/*.pk3 | wc -l            # same count as EU's server/maps
nfsstat -m                                    # vers=4.2, soft, timeo=50, retrans=2
time head -c 10M "$(ls /srv/racesow/maps/*.pk3 | head -1)" > /dev/null   # reads work
```

## E. First snapshot and the timer (US)

**1. Configure the paths.** Add the lines from
[`deploy/map-store/us.env.example`](../deploy/map-store/us.env.example) to
**`~/racesow/.env`**. That is the file `docker-compose.agent.yml`,
`docker-compose.warfork.yml` and the scripts read on this box, not
`server/.env`:

```bash
cd ~/racesow
grep -v '^#' deploy/map-store/us.env.example >> .env
grep -E '^(MAP_STORE|MAPSCAN|WARFORK_MAPS)' .env     # each key exactly once
```

The game servers do not see these until they are recreated in step F.

**2. Seed the snapshot from the existing local pool.** This is instant (hard
links, no extra disk) and saves copying about 12.5 GB across the Atlantic:

```bash
mkdir -p server/maps-snapshot
cp -al server/maps/. server/maps-snapshot/
```

**3. First sync, comparing packs by size only** (packs are never rewritten in
place, so a pack of the right size is the right pack). It fetches only the
packs this box was missing and removes ones the store no longer has:

```bash
MAP_SNAPSHOT_SIZE_ONLY=1 scripts/map-snapshot.sh
#  map-snapshot: syncing 4612 packs from /srv/racesow/maps to .../server/maps-snapshot (snapshot had 4598)
#  map-snapshot: done: 4612 packs in the snapshot
```

Without a seed, run the plain `scripts/map-snapshot.sh` in `tmux`: a full copy
takes hours.

**4. Install the timer.** It re-runs the sync every hour and, before each run,
remounts the store if the box booted while the link was down:

```bash
sudo systemd/install.sh agent          # re-installs this box's units; safe to re-run
systemctl list-timers racesow-map-snapshot.timer
sudo systemctl start racesow-map-snapshot.service
journalctl -u racesow-map-snapshot.service -n 20 --no-pager
```

**Check:** the journal ends with `map-snapshot: done: N packs in the
snapshot`, where N matches the store, and
`ls server/maps-snapshot/.racesow-map-store` exists.

## F. Switch the US game servers over (US)

This restarts both US game servers. Announce it first (deploy-production
skill, section 3).

```bash
cd ~/racesow
docker compose -p racesow -f docker-compose.agent.yml   up -d --force-recreate warsow-race
docker compose -p racesow -f docker-compose.warfork.yml up -d --force-recreate warfork-race
# only if the US box runs the HTTP pak mirror:
docker compose -p racesow -f docker-compose.agent.yml --profile httpdl up -d --force-recreate pakserver
```

**Check:**

```bash
docker logs warsow-race 2>&1 | grep -E '>> (map store|WARNING: map store)|mapscan'
#  >> map store: /warsow/shared/racemod                       <- the live store
#  ">> WARNING: map store /warsow/shared is unreachable; using the local snapshot"
#  followed by ">> map store: /warsow/shared-fallback/racemod" means it fell back:
#  see Troubleshooting
docker logs warfork-race 2>&1 | grep -E '>> (shared map pool|WARNING: map store)'
#  >> shared map pool: /warfork/maps_extra mounted as fs_cdpath ... (N pk3s, rescan every 60s)
docker exec warsow-race  sh -c 'ls /warsow/shared/racemod/*.pk3 | wc -l'          # the store's count
docker exec warfork-race sh -c 'ls /warfork/maps_extra/*.pk3   | wc -l'           # the same store
curl -sI http://127.0.0.1:${PAK_HTTP_PORT:-44445}/racemod/$(ls /srv/racesow/maps | grep pk3 | head -1) | head -1
#  HTTP/1.1 200 OK                                             <- downloads come from the store
```

Both engines boot in 60 to 90 s with the full pool. The first boot after the
switch reads the local snapshot to warm its pack cache (`>> map scan (warming
the cache from ...)`) and then reads over NFS only the packs the snapshot did
not have. Without that cache the boot reads all ~4,600 packs across the
Atlantic at about 52 RPCs/sec and the server is unreachable for twenty
minutes — which is exactly what happened on 2026-09-28 and is why the cache
exists (`server/mapscan-lib.sh`). Then vote a map in game, and
confirm that a player without the map downloads it.

**The live test.** Add a pack on EU and watch US pick it up without a restart.
Any pack not yet in the pool will do; a generated one is the easiest:

```bash
# EU
cp some_new_map.pk3 ~/racesow/server/maps/ && chmod 644 ~/racesow/server/maps/some_new_map.pk3
# US, within MAPSCAN_SECONDS (60 s) — BOTH games, they share the schedule:
docker logs --since 2m warsow-race  2>&1 | grep 'mapscan: +'
docker logs --since 2m warfork-race 2>&1 | grep 'mapscan: +'
#  mapscan: +1 map(s), 4613 on the list
```

A steady run of `mapscan: +0 map(s), <N> on the list` with `N` never moving
means the rescan is healthy but its source is not changing. Check the hourly
sync before you touch the engine — see "the snapshot stops growing" under
[Troubleshooting](#troubleshooting).

## G. Generated maps publish into the store (EU)

The mapgen worker (root `docker-compose.yml`, profile `mapgen`) copies every
map that passes its checks into the store, and each game server confirms it
over `/api/game/map-sync` ([map-generation-design.md](map-generation-design.md)).
On EU the store is `~/racesow/server/maps`, which the worker mounts at
`/srv/store` by default. The worker refuses to start if it does not see the
sentinel from step C there.

```bash
cd ~/racesow
docker compose --profile mapgen up -d mapgen
docker logs racesow-mapgen 2>&1 | head -3
#  mapgen worker up; building in /data/mapgen, publishing to /srv/store
```

Each game server confirms new maps with its own token (`INGEST_TOKEN` in its
`.env`, `WF_INGEST_TOKEN` for Warfork). A server on the legacy shared token
still works, but shows as `shared` on a map's page.

**Check:** request a map on `/mapgen`. Its page goes through publishing to "On
the servers", listing every game server with a tick.

## H. Failure drills (do them once before you rely on it)

Each drill proves one row of the failure table in shared-maps.md. Do them in a
quiet window.

**1. Link down while a map runs.** On US: `sudo systemctl stop wg-quick@wg-racesow`.
The running map keeps going (it is in memory). Within about 15 s,
`docker logs warsow-race` may show a scan I/O error; that is expected.
Then `sudo systemctl start wg-quick@wg-racesow`: the next scan works
again with no remount (a soft mount stays mounted through errors).

**2. Link down at launch.** Stop the tunnel as above, then
`docker restart warsow-race`. The log shows
`>> WARNING: map store /warsow/shared is unreachable; using the local snapshot`
and `>> map store: /warsow/shared-fallback/racemod`: it is running from the
snapshot. Start the tunnel and restart again, and it is back on the store.

**3. Boot with the link down.** Stop the tunnel, `sudo reboot`. The box boots
normally, and `findmnt /srv/racesow/maps` shows nothing mounted. The game
servers run from the snapshot. Start the tunnel, then
`sudo systemctl start racesow-map-snapshot.service`: its first step remounts the
store (`journalctl -u racesow-map-snapshot` shows `mounted /srv/racesow/maps`).
Left alone, the hourly timer does the same.

**4. Snapshot guards.** With the tunnel stopped, run `scripts/map-snapshot.sh`:
it refuses (exit 1, "does not show .racesow-map-store") and leaves the snapshot
as it was.

**5. EU restart.** `sudo reboot` on EU. When it is back: `sudo exportfs -v`
lists the export, and `ss -tlnp | grep 2049` shows nfsd on `10.66.0.1`
(the drop-in's ordering). On US the mount recovers by itself.

## I. Clean up the old US pool (US, a week later)

Once a week has passed with no trouble, the old per-box pool is dead weight.
Nothing reads `~/racesow/server/maps` on US any more: Warsow uses the store,
Warfork and the pak mirror use the store or the snapshot.

```bash
cd ~/racesow
grep -E '^(MAP_STORE_DIR|WARFORK_MAPS_DIR)=' .env                      # both set, as in step E
docker logs warsow-race 2>&1 | grep '>> map store'                     # /warsow/shared/racemod
du -sh server/maps
rm -rf server/maps && mkdir server/maps
```

The snapshot's hard links keep every pack's data, so this frees only what the
snapshot does not share: about the full pool once the hourly syncs have run.

## Operating it

| Task | Where | How |
| --- | --- | --- |
| Add maps from livesow | EU | `scripts/fetch-maps.sh` as before. It refuses on US. |
| Add one pack by hand | EU | Copy it into `server/maps`, `chmod 644`. Always a new name; never overwrite a pack in place. |
| Pull a map | EU web admin | Block it: every vote path drops it within 30 s. Delete the pack later, just before a daily restart. |
| See what US has | US | `ls /srv/racesow/maps/*.pk3 | wc -l`, and `ls server/maps-snapshot/*.pk3 | wc -l` for the fallback. |
| Force a rescan | any box | `rcon mapscan` → `mapscan: +N map(s), M on the list` |
| Snapshot health | US | `systemctl list-timers racesow-map-snapshot.timer`; `journalctl -u racesow-map-snapshot -n 20` |
| Tunnel health | both | `sudo wg show wg-racesow`: a handshake within the last 2 minutes |
| NFS health | US | `findmnt /srv/racesow/maps`; `nfsstat -m` |

Worth alerting on, if you wire up monitoring:

- `racesow-map-snapshot.service` failing twice in a row (the store has been
  unreachable for an hour or more, or a listing shrank).
- A `latest handshake` older than 5 minutes.
- `>> WARNING: map store ... is unreachable` in a US game server's log (it
  started from the snapshot).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `wg show` has no handshake | Keys swapped, UDP 51820 blocked (check the cloud firewall too), wrong `Endpoint` | Re-check step B on both ends. `tcpdump -ni any udp port 51820` shows whether packets arrive. |
| `mount` hangs, then `Connection timed out` | Tunnel down, nfsd not listening on `10.66.0.1`, or TCP 2049 blocked on `wg-racesow` | `ping 10.66.0.1`; on EU `ss -tlnp | grep 2049` and `ufw status`. |
| `mount.nfs4: access denied by server` | The export does not list `10.66.0.2`, or `exportfs -ra` was not run | On EU `sudo exportfs -v`. |
| `mount.nfs4: No such file or directory` | The bind mount at `/srv/racesow/store` is missing on EU | On EU `sudo mount /srv/racesow/store && sudo exportfs -ra`. |
| Listing works, a pack will not open (`Permission denied`) | The pack is not world-readable | On EU `chmod o+r` it (step C.2). |
| `Stale file handle` on US | EU's export was recreated (a new bind or filesystem under it) | `sudo umount -l /srv/racesow/maps && sudo mount /srv/racesow/maps`, then restart the game servers so they reopen the store. |
| nfsd down after an EU reboot | The drop-in is missing, so nfsd started before the tunnel | Install `nfs-server-after-wg.conf` (step C.4), `daemon-reload`, restart nfs-server. |
| A US game server started on the snapshot | The store did not answer within 5 s at launch | Fix the link. The server uses the store again from its next relaunch; the daily restart is enough. |
| `/srv/racesow/maps` empty after a reboot | Booted while the link was down (`nofail`) | `sudo systemctl start racesow-map-snapshot.service` remounts it, and so does the hourly timer. |
| Snapshot refuses: "does not show .racesow-map-store" | The store is unreachable, or the sentinel was deleted on EU | Fix the link, or `touch server/maps/.racesow-map-store` on EU. |
| Snapshot refuses: "refusing to delete more than half" | A partial listing from a sick mount, or a real mass deletion on EU | If the deletion was real, run it once with the store checked by hand and move the old snapshot aside first. Otherwise fix the mount. |
| New map not votable on US after a minute | `MAPSCAN_SECONDS` is 0, the pack is not world-readable, or it is blocked | `rcon mapscan`; check the pack's permissions on EU; check the admin blocklist. |
| Warfork on US is missing new maps | It is pointed at the snapshot instead of the store | `WARFORK_MAPS_DIR` must be the mountpoint, the same value as `MAP_STORE_DIR` (step E). Warfork has read the store with a 60 s rescan since 2026-09-29. |
| **The snapshot stops growing.** `map-snapshot` logs `done: N packs` every hour with `N` frozen, and both engines tick `mapscan: +0 map(s)` forever | `MAP_STORE_DIR` is set to the snapshot, so the sync has nothing to copy from and rsyncs the directory onto itself | Point `MAP_STORE_DIR` at `/srv/racesow/maps` (step E). Recent versions refuse to run at all in this state; if the log reads `syncing N packs from X to X`, this is it. Compare the counts to be sure: `ls /srv/racesow/maps/*.pk3 \| wc -l` against `ls ~/racesow/server/maps-snapshot/*.pk3 \| wc -l`. |
| Boot hangs for many minutes with the server unreachable | The pack cache is cold and the scan is reading ~4,600 packs over NFS | Expect it once per lost `racelog`/`wf_racelog` volume; the snapshot normally warms the cache first (`>> map scan (warming the cache from ...)`). Confirm the snapshot is populated — an empty one warms nothing. |
| `fetch-maps: this box reads the shared map store` on US | Correct: US never grows its own pool | Run `fetch-maps.sh` on EU. `MAPS_DEST_FORCE=1` overrides only if you really mean it. |

## Rollback

The store can be switched off on US at any point before step I, because the old
local pool is still there:

1. In `~/racesow/.env` on US, delete the `MAP_STORE_DIR`,
   `MAP_STORE_SNAPSHOT_DIR` and `WARFORK_MAPS_DIR` lines. Every setting falls
   back to `./server/maps`.
2. Recreate the game servers as in step F.
3. Optionally `sudo systemctl disable --now racesow-map-snapshot.timer`,
   `sudo umount /srv/racesow/maps`, comment the fstab line, and
   `sudo systemctl disable --now wg-quick@wg-racesow`.

After step I, first rebuild the local pool: seed it from the snapshot
(`cp -al server/maps-snapshot/. server/maps/`), then do the steps above.

On EU nothing needs rolling back: the store is its own `server/maps`. To stop
serving it: `sudo systemctl disable --now nfs-server`, remove
`/etc/exports.d/racesow.exports`, and delete the ufw rules
(`sudo ufw status numbered`, then `sudo ufw delete N`).

## Security notes

- **Nothing is exposed to the internet.** NFS listens on the tunnel address
  only, and the firewall admits TCP 2049 on the tunnel interface only. The
  tunnel's UDP port accepts the one peer IP and authenticates by key.
- **The reader cannot write.** The export is `ro`, the mount is `ro`, and
  `all_squash` maps every client user to the anonymous user. The pool is
  public data (every pack is downloadable anyway), so the only thing worth
  protecting is its integrity, and US cannot change it.
- **The mount cannot run anything.** `nodev,nosuid,noexec`.
- **A broken link cannot hang a game server.** The mount is `soft` with short
  timeouts, and the entrypoint gives the store 5 s to answer before it uses
  the snapshot.
- **A sick mount cannot empty the fallback.** The snapshot refuses to sync
  without the sentinel, or when the store lists fewer than half the packs the
  snapshot holds.
- **Rotating the tunnel keys:** generate a new key pair on one box (step B.1),
  put the new public key in the other box's config, restart
  `wg-quick@wg-racesow` on both. Expect a few seconds of NFS I/O errors, which
  the soft mount turns into a skipped scan.
- **Scanning.** The weekly ClamAV scan (`racesow-pakscan.timer`,
  `scripts/scan-paks.sh`) runs on EU against the one pool, which is every pack
  any server can load. On US it scans `server/maps`, which after step I is
  empty: its only packs are copies of the EU pool, already scanned there.

## Files this runbook installs

| Box | File | From |
| --- | --- | --- |
| both | `/etc/wireguard/wg-racesow.conf` (+ `.key`, `.pub`) | `deploy/map-store/wg-racesow.{eu,us}.conf.example` |
| EU | `/etc/fstab` bind line for `/srv/racesow/store` | `deploy/map-store/fstab.eu.example` |
| EU | `/etc/nfs.conf.d/racesow.conf` | `deploy/map-store/nfs.conf.example` |
| EU | `/etc/systemd/system/nfs-server.service.d/racesow.conf` | `deploy/map-store/nfs-server-after-wg.conf` |
| EU | `/etc/exports.d/racesow.exports` | `deploy/map-store/exports.example` |
| EU | `~/racesow/server/maps/.racesow-map-store` | `touch` |
| US | `/etc/fstab` NFS line for `/srv/racesow/maps` | `deploy/map-store/fstab.us.example` |
| US | `~/racesow/.env` lines | `deploy/map-store/us.env.example` |
| US | `racesow-map-snapshot.{service,timer}` | `systemd/install.sh agent` |
| both | ufw rules (UDP 51820 from the peer; TCP 2049 on `wg-racesow`, EU) | step B.3, step C.5 |
