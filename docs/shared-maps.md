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
 │   ▼                           │               │       (rsync hourly, the         │
 │ warsow-race  fs_cdpath=store  │               │        fallback copy)            │
 │ warfork-race, web mappack     │               │ warsow-race  fs_cdpath=store     │
 └───────────────────────────────┘               │ warfork-race fs_cdpath=store     │
                                                 │        or snapshot if unreachable│
                                                 └──────────────────────────────────┘
```

**The engine reads the store directly.** The store is mounted in the container
at `/warsow/shared/racemod` and passed as `fs_cdpath`, an extra base path the
engine scans for each game directory's packs (`qcommon/files.c`, `FS_Init` →
`FS_AddBasePath`). No packs are copied or symlinked into the mod dir any more.

**Both games, one schedule.** Warfork does the same thing through one symlink
(`/warfork/shared/racesow` → the pool), because its `fs_game` layout wants the
base path a level up. Both engines carry `patch-mapscan.py` and read the same
`MAPSCAN_SECONDS` (60), so a pack that lands in the store is votable on all
four servers within a minute, with no restart anywhere.

**Enumerating the pool is cached.** Separately from the engine's rescan, each
entrypoint lists every installed map at boot to build the rotation and the
vote pool, and the only way to know what a pack contains is to read its
central directory. Against the NFS store that ran at about 52 RPCs/sec across
4,588 packs and hung a US boot for over twenty minutes, every restart paying
it again. Packs are never rewritten in place, so `server/mapscan-lib.sh`
(shared by both entrypoints) caches `<size> <name> → <maps>` on the persisted
racelog mount and re-reads only packs it has never seen. Because the key is
size and name rather than path, the *local snapshot* warms the cache for the
identical packs in the store: a cold boot reads local disk once and then
fetches only the handful of packs added since the last hourly sync.

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
- **Generated maps publish themselves.** The mapgen worker copies every map
  that passes its checks into the store (dot-name, then rename), and servers
  confirm loading it over `/api/game/map-sync`. To add any other map without
  it being votable at once, block it first: the live blocklist is re-read
  every 30 s.
- **Only EU writes.** The export is read-only. `fetch-maps.sh` refuses to run
  on a box whose `.env` or `server/.env` sets `MAP_STORE_DIR` (`MAPS_DEST_FORCE=1`
  overrides).
- **The sentinel stays.** `server/maps/.racesow-map-store` is how every reader
  tells "the store is up" from "the mount is an empty directory". Without it,
  an empty store would look like a dead one.

## Setting it up

Production setup is a step-by-step runbook with a check after every step,
failure drills, troubleshooting and rollback:
**[map-store-runbook.md](map-store-runbook.md)**. The templates it installs are
in `deploy/map-store/`. In outline:

1. Ship the code to both boxes. With no store configured nothing changes:
   `MAP_STORE_DIR` defaults to each box's own `server/maps`, read through
   `fs_cdpath` instead of symlinks.
2. WireGuard between the boxes (`10.66.0.1` EU, `10.66.0.2` US).
3. EU: the sentinel, a bind mount of `server/maps` at `/srv/racesow/store`, and
   an NFSv4.2-only, read-only export of it on the tunnel address only.
4. US: the NFS mount at `/srv/racesow/maps`.
5. US: the store paths in `~/racesow/.env` (the file its compose files read),
   the first snapshot seeded from its existing pool, and the hourly snapshot
   timer.
6. US: recreate both game servers. Both read the store and fall back to the
   snapshot; the pak mirror serves from the store, then the snapshot.
7. EU: the mapgen worker publishes into the store.
8. Failure drills, then, a week later, delete the old US pool.

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

- **The US pak mirror during an outage** serves from the snapshot, so a
  client can download any map the US server can run.
