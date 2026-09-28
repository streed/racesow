# Shared map store

One copy of the map pool, on the EU box. The US box reads it over NFS through a
WireGuard tunnel, and every game server picks up new packs while it runs.

Before this, each box kept its own ~12.5 GB pool: its own `fetch-maps.sh` run,
its own ClamAV scan, and a restart to load anything new. Now a map is added
once, on EU, and every server can vote for it within a minute.

## How it fits together

```
 EU box (owns the store)                         US box (reads it)
 ┌───────────────────────────────┐               ┌──────────────────────────────────┐
 │ server/maps/  ◀── fetch-maps  │               │ /srv/racesow/maps  (NFS, ro)     │
 │   *.pk3       ◀── mapgen      │   WireGuard   │   ▲ read on every map load       │
 │   .racesow-map-store          │═══ 10.66.0.x ═│   │                              │
 │   │  ClamAV (pakscan)         │   NFSv4.2 ro  │   └─▶ server/maps-snapshot/      │
 │   ▼                           │               │       (rsync every 6 h, the      │
 │ warsow-race  fs_cdpath=store  │               │        fallback copy)            │
 │ warfork-race, web mappack     │               │ warsow-race  fs_cdpath=store     │
 └───────────────────────────────┘               │        or snapshot if unreachable│
                                                 └──────────────────────────────────┘
```

**The engine reads the store directly.** The store is mounted in the container
at `/warsow/shared/racemod` and passed as `fs_cdpath`, an extra base path the
engine scans for each game directory's packs (`qcommon/files.c`, `FS_Init` →
`FS_AddBasePath`). No packs are copied or symlinked into the mod dir any more.

**New packs load without a restart.** `enginepatches/patch-mapscan.py` adds:
- `sv_mapscan <seconds>`: while a map runs, rescan the base paths this often.
  Set from `MAPSCAN_SECONDS`, default 60.
- `mapscan`: a console and rcon command that rescans now and reports.

A rescan calls the stock `ML_Update()`, which loads packs it hasn't seen and
adds their maps to the list that every vote path reads (`GetMapsByPattern` →
`ML_GetMapByNum`). So a new map is votable, playable with `map`, and part of
the idle rotation. The patch also clears the new-packs flag, which the stock
engine would otherwise answer by restarting an idle server's map.

**Downloads come from the same store.** The HTTP pak mirror (`pakserver`, profile
`httpdl`) serves `<gamedir>/<pack>.pk3` from the mod's pakshare export, then
the store, then the snapshot (`server/pakserver.conf`).

## What happens when the link is down

| situation | US game server | new maps |
| --- | --- | --- |
| store reachable | loads from the NFS mount | votable within `MAPSCAN_SECONDS` |
| link drops mid-map | the running map keeps going (already in memory); rescans fail quietly; a map change that needs the store fails, the engine relaunches, and the entrypoint picks the snapshot | wait for the link |
| link down at launch | `store_answers` fails within 5 s → `fs_cdpath` = snapshot, with a warning in the log | missing until the next snapshot after the link returns |
| no snapshot yet | stock maps only, with a warning | — |

The US box stays up with the last-known pool, which is the choice made for
this rollout. The mount is `soft` with short timeouts, so a dead link is an
error rather than a frozen server thread. `scripts/map-snapshot.sh` refuses to
sync when it can't see the store's sentinel, or when the store lists fewer
than half the packs the snapshot holds. So a sick mount can never empty the
fallback.

## Rules for the store

- **Add packs with a new name; never rewrite one in place.** The engine reads
  a pack's table of contents once, when it first loads the pack
  (`FS_LoadPackFile`), and reopens the file by name for every read. A pack
  replaced under the same name is then read with the old pack's offsets,
  which is garbage. For `mapfix --keep-bsp-name`, which is meant to replace a
  pack, do it just before the daily restart.
- **Removing a pack takes effect at the next restart.** Until then the engine
  still lists its maps, and a vote for one fails to load. Block the map first
  (the blocklist hides it from every vote path within 30 s), then remove the
  pack.
- **Block before you add.** The live blocklist is re-read every 30 s. A
  generated map copied into the store before it is blocked is votable for up
  to a minute. The publish flow in `docs/map-generation-design.md` blocks
  first.
- **Only EU writes.** The export is read-only. `fetch-maps.sh` refuses to run
  on a box whose `server/.env` sets `MAP_STORE_DIR` (`MAPS_DEST_FORCE=1`
  overrides).
- **The sentinel stays.** `server/maps/.racesow-map-store` is how every reader
  tells "the store is up" from "the mount is an empty directory". Without it,
  an empty store would look like a dead one.

## Setting it up

Templates are in `deploy/map-store/`. Replace `__RACESOW_DIR__` with the
checkout path on EU.

**EU (owns the store)**

```sh
touch server/maps/.racesow-map-store
apt install wireguard nfs-kernel-server
# /etc/wireguard/wg-racesow.conf from wg-racesow.eu.conf.example
systemctl enable --now wg-quick@wg-racesow
# /etc/nfs.conf.d/racesow.conf from nfs.conf.example
# /etc/exports.d/racesow.exports from exports.example
systemctl restart nfs-server && exportfs -ra
ufw allow from <US public IP> to any port 51820 proto udp
ufw allow in on wg-racesow to any port 2049 proto tcp
```

EU needs no `server/.env` change: `MAP_STORE_DIR` defaults to `./maps`.

**US (reads it)**

```sh
apt install wireguard nfs-common rsync
# /etc/wireguard/wg-racesow.conf from wg-racesow.us.conf.example
systemctl enable --now wg-quick@wg-racesow
mkdir -p /srv/racesow/maps
# the line from fstab.us.example, then:
mount /srv/racesow/maps && ls /srv/racesow/maps/.racesow-map-store
ufw allow from <EU public IP> to any port 51820 proto udp
# server/.env
MAP_STORE_DIR=/srv/racesow/maps
MAP_STORE_SNAPSHOT_DIR=./maps-snapshot
scripts/map-snapshot.sh             # first snapshot (hours for ~12.5 GB)
systemd/install.sh agent            # installs racesow-map-snapshot.timer
```

## Rollout order

1. Deploy the image with the mapscan patch everywhere. With no store configured
   it changes nothing: `MAP_STORE_DIR` defaults to `./maps`, the same packs as
   before, now read through `fs_cdpath` instead of symlinks.
2. EU: sentinel, WireGuard, NFS export.
3. US: WireGuard, mount, first snapshot (while its local `server/maps` is still
   in place).
4. US: set `MAP_STORE_DIR` and `MAP_STORE_SNAPSHOT_DIR`, restart the game server,
   and check the log for `>> map store: /warsow/shared/racemod`.
5. US: once a week has passed without trouble, delete the old local
   `server/maps`. That's the 12.5 GB this frees.

## Checking it

```sh
docker logs warsow-race 2>&1 | grep -E 'map store|mapscan'
#  >> map store: /warsow/shared/racemod
#  mapscan: +1 map(s), 4303 on the list
rcon mapscan          # rescan now: "mapscan: no new map packs, 4303 on the list"
```

CI proves the engine side on every push (`.github/workflows/e2e.yml`):
- A generated map boots from the store (`boot-test.sh --maps-dir`).
- A pack dropped into the store while the server runs is found by
  `sv_mapscan` and loaded over rcon (`e2e/mapscan_run.sh`).

## Not covered yet

- **Warfork.** The Warfork server (EU only) reads the same `server/maps` from
  local disk, so the store changes nothing for it. But its engine has no
  mapscan patch yet, so it still needs a restart for new maps. Porting
  `patch-mapscan.py` to `warfork/enginepatches/` is the follow-up.
- **The US pak mirror during an outage** serves from the snapshot, so a
  client can download any map the US server can run.
