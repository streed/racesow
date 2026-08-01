---
name: import-demo
description: Import a one-off Warsow/Warfork .wdz20 demo into the production race database — recover map/player/time, RECOMPUTE strafe quality from the recorded snapshots, backdate every row to when the run actually happened, publish the download and the in-browser replay. Use when handed a loose demo file (a server autorecord, a recovered WR, an SFTP upload the watcher rejected) that needs to become a real record.
---

# Import a one-off demo

For a demo file that the normal pipeline can't handle. Read all of this before
running anything: the tool writes to the **production** database, and a couple of
its guards exist because getting them wrong silently corrupts a leaderboard.

## When this applies (and when it doesn't)

| Situation | Use |
|---|---|
| A **server autorecord** — `<date>_<gametype>_<map>_auto<NNNN>.wdz20`, `multipov=1` | **this skill** |
| A demo the SFTP watcher rejected ("no runner name (matchname) in demo") | **this skill** |
| A run that must be dated when it HAPPENED, not when it was imported | **this skill** |
| A demo that needs `strafe_quality` (the live sampler never saw it) | **this skill** |
| A normal client per-run demo dropped in the SFTP dropbox | `scripts/ingest-demos.sh` — leave it alone, it works |

`web/demo-meta.mjs` reads `matchname`/`matchscore` from the demo metadata block.
A server autorecord never sets configstrings 22/23, so `parseDemoMeta()` rejects
it outright. `/api/ingest` also stamps `created_at = now()` with no override, and
nothing in that path can supply a strafe figure. Hence a separate tool.

## The two pieces

- **`web/demo-replay.mjs`** — decodes the recorded network stream (container
  framing, configstrings, gamecommands, per-frame playerstates) and recomputes
  air-strafe quality by porting `hrace/player.as sampleStrafe()` gate for gate.
  Pure; no database. Run it alone to inspect a file.
- **`web/import-demo.mjs`** — writes `finish`, `player_demo`, the `race` PB and
  optionally `player_ghost`. Uses `pg` only (no `db.js` import), so it
  bind-mounts into the **deployed** web image without shipping any other code.

Both are in `web/Dockerfile`'s COPY list, so a rebuilt image already has them;
the bind-mount route below exists so you can run an import **without** deploying
whatever else is sitting uncommitted in the tree.

## 1. Inspect locally first

```bash
node web/demo-replay.mjs --best some.wdz20     # the fastest run + provenance
node web/demo-replay.mjs some.wdz20            # every finish in the file
node web/demo-replay.mjs --frames some.wdz20   # parser stats only
```

Sanity-check before going further:

- `stats.walkEnd == stats.rawBytes` — the walk reached exactly EOF. A short walk
  means a desync, and a desync yields *plausible but wrong* velocities rather
  than an error.
- `maxSpeed` / `startSpeed` marked `"printed"` in `provenance.speedSource` came
  from the mod's own console output and are exact; `"sampled"` ones are derived
  from 20–40 Hz snapshots and can differ by a few ups.
- `provenance.rejected` — if `slow` or `keys` dominates, the run window is
  probably wrong.

## 2. Dry run against production

Dry run is the default; it writes nothing.

```bash
tar cz web/demo-replay.mjs web/import-demo.mjs some.wdz20 \
  | ssh "$DEPLOY" 'mkdir -p ~/racesow/import-staging && tar xz -C ~/racesow/import-staging'

ssh "$DEPLOY" 'cd ~/racesow && S=$HOME/racesow/import-staging && docker compose run --rm --no-deps \
  -v "$S/web/import-demo.mjs":/app/import-demo.mjs:ro \
  -v "$S/web/demo-replay.mjs":/app/demo-replay.mjs:ro \
  -v "$S/some.wdz20":/data/demo.wdz20:ro \
  web node import-demo.mjs /data/demo.wdz20'
```

Read the plan. `dated` must be the run's real date. If the player line errors
with *"no player row for …"*, go to §5 — do **not** reach for `--create-player`
reflexively.

## 3. Commit

```bash
... web node import-demo.mjs --ghost --commit /data/demo.wdz20
```

Useful flags: `--all-runs` (every finish, not just the fastest), `--tally` (bump
`run_tally` — see §5), `--player-id <n>`, `--strafe <bp>`, `--version <name>`,
`--no-demo-pointer`, `--json`.

Re-running is safe: the finish row is deduped, the PB is faster-only, the ghost
and demo pointer are faster-only.

## 4. Publish the file and the replay

The DB now points at a demo path, but the **file** must reach the served tree or
the download 404s. Demos are served from the Docker named volume
`server_pakshare` at `demos/<map>/<file>`, **not** from the bind-mounted
`~/racesow/server/demos/` — that one is where the game *writes*.

```bash
ssh "$DEPLOY" 'cd ~/racesow/server && \
  docker compose exec -T pakserver mkdir -p /usr/share/nginx/html/demos/<map> && \
  docker compose cp ~/racesow/import-staging/some.wdz20 \
    pakserver:/usr/share/nginx/html/demos/<map>/<the demoPath basename>'
```

Verify all three surfaces:

```bash
curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" https://racesow.org/demos/<map>/<file>
curl -sS "https://racesow.org/api/demos/<mapId>"                 # directory entry
curl -sS "https://racesow.org/api/maps/<mapId>/ghost?player=<id>" # replay trajectory
```

`--ghost` makes the run playable at `https://racesow.org/replay/<mapId>` and puts
a "▶ Watch replay" button on the map page. It needs `<map>.glb` under
`web/public/maps/` to render geometry; without it the viewer still plays the
trajectory.

## 5. The guards, and why they exist

**Unknown player → it refuses.** The database stores the name the *game module*
reports, and `client.name` in AngelScript appends `S_COLOR_WHITE`
(`g_ascript.cpp objectGameClient_getName`) to the raw `netname` the demo's
configstring carries. `demo-replay.mjs` already applies that `^7`, so a normal
demo resolves. If it still misses, the stored nick genuinely differs — bind it
explicitly with `--player-id <n>` after confirming with the printed near-misses.
Reach for `--create-player` only when it really is a new person: a wrong guess
forks someone's history in two.

**`run_tally` is not bumped by default.** The legacy bulk import counted finishes
without logging them, so a re-imported historical run would double-count. Check
first, and pass `--tally` only when the run is genuinely new to the counter:

```sql
SELECT finishes, attempts FROM run_tally WHERE player_id=<p> AND map_id=<m>;
```

**Everything is backdated.** Rows are dated from the demo's own clock
(`localtime` + the `serverTime` offset to that finish). This is not cosmetic —
`web/tournaments.js` scores a tournament as a filter over `finish.created_at`, so
a historical run stamped `now()` would win a live competition it never entered.
It also keeps the rolling-30-day strafe chart and the `rolling30` achievement
periods honest.

**The PB strafe column.** `db.js` writes `race.strafe_quality` only on
insert/improve, so re-importing a time that *equals* the stored PB would leave
the leaderboard blank. The tool fills it when the times match exactly, guarded on
the column being NULL so a live value is never clobbered.

## 6. How much to trust the strafe number

Recovered **exactly**: velocity (pmove snaps to 1/16 in memory and the wire uses
the same 1/16), view yaw (16-bit angle lattice), pressed keys, `PM_STAT_MAXSPEED`,
`pm_flags`.

The real limit is sampling rate. `sampleStrafe()` runs every game frame
(`WORLDFRAMETIME` 16 ms); a demo holds one sample per snapshot (50 ms at the
`sv_pps 20` demos were recorded at, 25 ms at 40). Every demo sample IS a real
sampler frame — just a subset. **Quote a demo-derived value as ±3 points.**

Three things that look like bugs and are not:

1. **Do not "correct" for the rate gap.** A pmove-accurate simulation over 8
   strafing styles showed the lumped reading errs −517…+86 bp, mean ~1 point
   *low*. Concavity inflates, but the per-frame gates and the `q<=1` clamp
   dominate the other way. Both a linear extrapolation and an analytic
   sub-stepped ideal gain made it **worse**. `provenance.bpSubSteppedGain` is
   reported as a diagnostic only.
2. **`plrkeys` is one snapshot out of phase.** `ps.plrkeys` is assigned only at
   `p_view.cpp:480` inside `G_ClientEndSnapFrame`, which runs *after* that
   interval's game frames. So snapshot *k*'s mask is what the sampler read during
   `(t_k, t_k+1]`. `keyLag: 1` is correct; `keyLag: 0` reads ~186 bp low because
   it stops rejecting the frames at direction switches.
3. **`PMF_ON_GROUND` stands in for `onStrafeGround()`**, which is really an
   8-unit downward box trace and is also true while hovering. Worth ~0.2 points
   on an air map, more on a ground-heavy one. `provenance.bpGroundHalo` /
   `bpNoGround` bracket it.

## 7. Reference

- Engine source for the wire format (clone for reference, not vendored):
  `git clone --depth 1 -b race-demos https://github.com/DenMSC/racemod_2.1`
  → `qcommon/snap_demos.c`, `snap_read.c`, `msg.c`, `client/cl_parse.c`.
  `svc_*` opcodes are the **declaration order** of `enum svc_ops_e`
  (`qcommon/qcommon.h`) — frame=12, servercs=11, playerinfo=6, gamecommands=8.
  Do not reconstruct them from memory.
- Tests: `node --test server/test/demo-replay.test.mjs` (10 tests; the fixture
  `server/test/fixtures/hrace_line_auto2472.wdz20` pins the decode against values
  the demo asserts about itself).
- Our own servers autorecord too — hundreds of files already sit in the
  `server_pakshare` volume under `demos/`, all importable with this tool.
