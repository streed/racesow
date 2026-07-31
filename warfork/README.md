# Warfork race server (racesow port)

A **Warfork 2.16** race server that runs OUR racemod gametype alongside the
Warsow servers, feeding the SAME racesow.org leaderboard (records tagged
`wf 2.16`) and joined to the SAME cross-server mesh. Full design + rationale:
[`../docs/warfork-port-design.md`](../docs/warfork-port-design.md).

## How it's built (proven end-to-end)

`Dockerfile` (build from the **repo root**) does, in order:
1. clone warfork-qfusion 2.16 (pinned) + submodules (−crashpad);
2. vendor Gelmo's racesow projectile/prejump natives (`enginepatches/{g,gs}_racesow.*`)
   + `patch-pjstate-natives.py` — creates the `RS_ResetPjState` binding our patches need;
3. apply our `../server/enginepatches/patch-{api,mirror,wrghost}-*.py` **unchanged**
   (Warfork & Warsow share the qfusion game-module lineage);
4. `cmake --preset workflow-linux-release -DBUILD_STEAMLIB=0` → `wf_server` + game module;
5. package our `../server/racemod/source` as the `racesow` fs_game, after
   `scriptpatches/patch-scripts-as2024.py` adapts the shared scripts to AS2024.

```bash
# from repo root:
docker build -f warfork/Dockerfile -t warfork-race:racesow .
```

Validated: natives compile+link, `hrace` gametype boots ("Gametype 'Race'
initialized"), Warfork↔Warsow mesh (drop=0, heard both ways), shared IBSP+FBSP
map load, api fetch wiring.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | multi-stage build (source → runtime image) |
| `entrypoint.sh` | env → `rs_api_*`/`rs_mirror_*` cvars; shared-map symlink + `g_maplist`; launch |
| `configs/server.cfg` | race gameplay tuning (`sv_pure 0` for v1) |
| `enginepatches/` | Gelmo racesow natives (`g_racesow.*`, `gs_racesow.*`) + `patch-pjstate-natives.py` + UPSTREAM |
| `scriptpatches/patch-scripts-as2024.py` | Warfork-only AS2024 adaptation of the shared scripts |
| `build-from-source.sh` | standalone local source build (dev iteration) |
| `../docker-compose.warfork.yml` | additive deploy service (ports 44410/44411/44451, shared maps) |

## Deploy (additive; leaves Warsow untouched)

See the runbook in `../docs/warfork-port-design.md §11.4`. In short, per box:
set `.env` (`WF_INGEST_TOKEN`, `MIRROR_TAG`/`MIRROR_PEERS` per §11.1,
`VERSION_NAME="wf 2.16"`, reuse `MIRROR_SECRET`+`INGEST_URL`), open UFW
`44451/udp`, `docker compose -f docker-compose.warfork.yml up -d --build`,
then expand the live Warsow `MIRROR_PEERS`+retag and tear down the old
`warfork-test` spike.

**Deferred** (not launch blockers): client UI pak + `sv_pure 1` delivery, per-client
demo natives, weapon-def physics parity, public Steam listing (`BUILD_STEAMLIB=1`
+ GSLT).

The prejump `gs_pmove.c` hooks are no longer deferred — they shipped 2026-07-30
(`enginepatches/patch-pjcount-hooks.py`). Until then the prejump rule was
unenforced on Warfork: the natives bound, but nothing incremented the counters.
