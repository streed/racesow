# Live-client smoke checklist — hettoo integration

The headless gate (`verify-mesh.sh`) proves compile + mesh + fake-player join.
Everything below is what it *cannot* prove: real racing/spectating gameplay.
Section A verifies the specific bug-fixes from the two audits; Section B is a
quick pass over every new feature; Section C needs a second client (or the fake
player) and is optional.

## Setup

```sh
# 1. Bring up the 3-node test cluster and leave it running:
cd server && ./test/verify-mesh.sh --no-build --keep
#    (or: docker compose -f docker-compose.mirror-test.yml up -d)

# 2. Connect a Warsow 2.1.2 client:  open console →  connect localhost:44403

# 3. Map switching (installed: aurora-speed1, coldrun):
#      in client console:  rcon_password mirrortest   then   rcon map coldrun
#    For the checkpoint items (A3–A5, B: find cp) use a map that actually has
#    checkpoints — if neither installed map does, drop any racesow CP map .pk3
#    into server/mirror-test-maps/ and rcon-map to it.

# 4. Watch the server console during ALL tests (generic failure signature =
#    any line containing "ERR :", "exception", or "Index out of bounds"):
docker logs -f warsow-mirror-a

# 5. Optional fake player (for C-items / mesh sanity) — reliable once the
#    server has been up ~2 minutes:
python3 e2e/mirror_wire_check.py fakeplayer 127.0.0.1:44450 \
    mirror-test-local-only B <current-map> TestGhost 0 0 100 120
```

All gametype commands are typed in the client console (leading `/` optional).

---

## A. Critical regression checks (audit bug-fix verification)

**A1 — recall → spectate (camera hijack, fix M2)**
`practicemode` → move around a few seconds → `position recall 1` → `kill`
(respawns frozen for ~20 frames) → immediately `spec`.
- PASS: spectator camera stays free.
- FAIL: ~half a second after speccing, your camera snaps to the recalled spot.

**A2 — recall → noclip (yank-out, fixes M3/L2/L3)**
`practicemode` → `position recall 1` → `kill` → during/right after the freeze,
`noclip`.
- PASS: you enter/stay in noclip; no teleport back ~0.5 s later; `kill` during
  a recall-freeze does NOT print a spurious "Noclip mode disabled."
- FAIL: you get yanked out of noclip back to the recall spot.

**A3 — auto-recall extend + /cps (fix M1)** *(CP map)*
`practicemode` → `position recall extend on` → run through 1–2 checkpoints →
`cps` → recall + extend the run → `cps` again.
- PASS: `/cps` shows only the CURRENT run's splits; repeat runs show fresh
  values (no stale splits from the previous run, never blank).

**A4 — /position find cp (fix M5)** *(CP map)*
`practicemode` (or spec) → `position find cp` → repeat.
- PASS: teleports to a checkpoint; repeating cycles through them.
- FAIL: "No matching entity found." on a map that clearly has CPs.

**A5 — /cps on a real multi-CP finish (safe-core verification)** *(CP map)*
Race normally through all CPs to the finish; run `cps` mid-run and again after
finishing.
- PASS: per-CP table (time, Personal/Server diff, speed) both times, matching
  the automatic finish report. No script errors in the server console.

**A6 — /mark → disconnect (edict-leak fix)**
`mark` → `disconnect` → reconnect.
- PASS: no marker model floating at the old spot for the reconnected (or any
  new) client.

---

## B. New-feature walkthrough (quick pass each)

| # | Steps | Expect |
|---|---|---|
| B1 | `position find` (no arg) | Map stats line + usage; no teleport |
| B2 | `position find rl` / `gl` / `pg` / `start` / `finish` / `push` / `door` / `tele` / `slick` (practice/spec) | Teleport; repeat cycles matches |
| B3 | `position find rl info` | Entity dump (no teleport); big lists omit detail |
| B4 | `position find zzz` (typo) | "No matching entity found." — must NOT teleport you (worldspawn-trap fix) |
| B5 | `position save spot1` → move → `position load spot1` → `position list` → `position clear spot1` | Named slot round-trip; load also copies to main; list shows "Main position saved" + named entries; 9th named save says "No free position slot available." |
| B6 | `position speed 1000`, then `position speed +100` | Spawn speed set; `+/-` adjust relative to the slot's CURRENT speed |
| B7 | `position recall best` / `start` / `end` / `cp1` / `rl` and arrow-key cycling in noclip | All pre-existing recall behavior intact |
| B8 | `position recall fake 5000` (after `position save`) | Next load starts the timer at 5.000 |
| B9 | `position recall interval` → `position recall interval auto` (after a finish) → `position recall delay` / `delay 10` | Prints, sets; `auto` errors "You haven't finished yet." with no finish |
| B10 | `mark` → move → `mark` again | Dummy model at your spot, only you see it; re-mark moves it |
| B11 | `prerandmap *` and `prerandmap <pattern>` | Prints chosen map + its top-scores table + match count; re-rolls each call |
| B12 | `lastrecs` (after setting a record, then `rcon map` to another map) | Cross-map recent-records table with "(previously …)" |
| B13 | `top coldrun` (from another map) | That map's board without loading it; `top` alone unchanged |
| B14 | `noclip` as a spectator; `noclip` while dead; `noclip` while playing outside practice | Joins + enters practice + noclips in place; auto-enters practicemode; "Can't use noclip in overtime." during overtime |
| B15 | In noclip: hold ATTACK+SPECIAL aiming at a wall, then at water | Glide toward the aimed surface, stopping just short; water surfaces now valid targets (MASK_WATER) |
| B16 | `position save` in prerace while dead / under a low ceiling | "You can only save your position while alive." / "…where you cannot stand up." |
| B17 | `help` and `help position find`, `help mark`, `help lastrecs`, `help cps`, `help prerandmap` | New entries present and accurate |
| B18 | `cps` with no run started | "No checkpoint splits recorded…" (no error) |

---

## C. Two-client / mesh items (optional — use a friend or the fake player)

| # | Steps | Expect |
|---|---|---|
| C1 | `position join <player>` (practice/spec) | Teleport to their live position; velocity zeroed |
| C2 | `position recall current <player>` | Copies their in-progress run; recall cycling works on it |
| C3 | `mark <player>` (they must have a marker) | Copies their marker to your view |
| C4 | Prerace `position save` while another racer stands inside/on you | Save must succeed (MASK_DEADSOLID: bodies don't block) |
| C5 | With the fake player streaming: `who`, `watch TestGhost`, ghost visible running circles | Mesh play unaffected by the integration |

---

## Reporting

For any FAIL: note the item #, what you saw, and paste the surrounding
`docker logs warsow-mirror-a` excerpt (especially any `ERR :` / exception
lines). Tear down when done: `docker compose -f docker-compose.mirror-test.yml down`
