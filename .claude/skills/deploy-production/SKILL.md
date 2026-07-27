---
name: deploy-production
description: Deploy racesow changes to the production boxes (eu.frankfurt = web+game+DB, us.east = game only). Reconcile the hand-maintained box git drift, notify players of a 2-5 min game downtime, roll the web layer (migrations auto-apply), run any data scans, and rebuild+restart the game servers. Use whenever shipping web, engine/racemod, migration, or config changes to production.
---

# Deploy racesow to production

Ship committed changes to the two production boxes safely, with player
notification before any game-server restart. Read this whole file before running
anything — the boxes are **hand-maintained out of git**, so a naive `git pull`
can clobber live config.

## The boxes

| Box | Host | Runs | Notes |
|-----|----|------|-------|
| EU / central | `eu.frankfurt.racesow.org` | web (web + web2 + heatmaps), Postgres, redis, discord, **warsow-race**, warsow-tv | The central stats DB + the site. All migrations + data scans happen here. |
| US | `us.east.racesow.org` | **warsow-race** only (+ tv-hls, pakserver) | No DB/web. The game fetches central endpoints (`rs_api_*_url`) over Cloudflare→EU. Deploy = code + game rebuild only. |

Repo on each box: `~/racesow`, tracking `origin/main`. Deploy = box pulls `main`,
then rebuild/recreate the affected containers.

**The deploy login + SSH key are provisioned out of this (public) repo** (see
`docs/live-stream-rollout.md` — "user to provision"). Set them locally and use
them in every ssh call below; nothing secret is committed:
```bash
DEPLOY_USER=<your-deploy-user>          # the box login (has docker + sudo)
DEPLOY_KEY=~/.ssh/<your-deploy-key>     # private key for these boxes
# then:  ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@eu.frankfurt.racesow.org" '<cmd>'
```

> **Permissions:** read-only SSH is sanctioned; **mutating** SSH (git pull,
> docker build, container recreate) is gated by the auto-mode classifier. The
> user must grant an allow-rule via `/permissions` (or run the steps) before you
> can execute the mutating parts.

## 0. Preconditions (do NOT skip)

1. **Code is on `main` and pushed** (`git push origin main`). The boxes pull main.
2. **Verified locally** for what you changed:
   - Web: `cd web && TEST_PG_URL=… npm test` (needs a throwaway PG; see
     `web/test/pg-util.js`). Optionally curl new endpoints against a local server.
   - Engine/racemod: `docker compose -f server/docker-compose.yml build warsow-race`
     (compiles the C++ natives + asserts they registered), then boot it with a
     couple of maps and confirm `Gametype 'Race' initialized` with **no
     AngelScript errors** — the `.as` compiles at boot, not build.
3. **Know what changed** → deploy only those layers:
   - web/API/frontend → web roll (§4)
   - `web/migrations/*` → applied automatically by the web roll at startup
   - a new data table needing a backfill (e.g. `map_weapon`) → data scan (§5)
   - `server/enginepatches/*`, `server/racemod/*`, `server/entrypoint.sh`,
     `server/Dockerfile` → game rebuild+restart (§6), which interrupts players

## 1. Read-only recon (both boxes)

```bash
for H in eu.frankfurt us.east; do
  echo "### $H"
  ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$H.racesow.org" \
    'cd ~/racesow && echo "HEAD: $(git rev-parse --short HEAD)" && \
     echo "--- drift ---" && git status --short && \
     echo "--- containers ---" && docker ps --format "{{.Names}} {{.Status}}"'
done
```

Note the HEAD (how far behind main) and any `git status` drift. Check whether
players are on right now (a game restart interrupts active races — prefer a quiet
window, and always notify first per §3).

> **SSH gotcha:** if calls hang or you see `communication with agent failed` /
> `Too many authentication failures`, the local ssh-agent is interfering. Bypass
> it: add `-o IdentityAgent=none -o IdentitiesOnly=yes` to every ssh call.

## 2. Reconcile box git drift (the careful part)

The boxes carry **uncommitted working-tree edits** — some redundant, some real:

- **Redundant** (a past hotfix that later landed in main): the box's working copy
  is byte-identical to a commit already in main. Safe to discard — the pull
  re-applies it via history. Verify per file:
  ```bash
  ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@eu.frankfurt.racesow.org" 'cat ~/racesow/<file>' \
    | diff - <(git show origin/main:<file>)   # empty diff = redundant, safe to drop
  ```
- **Real box-specific config** that is NOT in git and MUST be preserved —
  historically `server/docker-compose.yml` (EU) and `docker-compose.agent.yml`
  (US), which hold per-box container wiring (TV capture, ports, mounts). **Never
  blanket `git checkout -- .` or `git reset --hard`** — you'll wipe live config.

**Also watch untracked files that the pull will ADD.** If the box has an
untracked file at a path a new commit adds (e.g. `server/docker-compose.tv.yml`),
`git pull` aborts with *"untracked working tree files would be overwritten"*. If
the box's copy is identical to main's, `rm` it before the pull (git restores the
identical version); if it differs, move it aside and merge by hand.

Precise (lossless) reconcile — classify each drifted/blocking file first:
```bash
cd ~/racesow
git branch box-drift-backup-$(date +%Y%m%d) 2>/dev/null || true   # safety ref

# (a) Redundant tracked files == a commit already in main (verify with the diff
#     in §2 above): discard — the pull re-applies them from history.
git checkout -- <redundant files...>

# (b) Real box-specific tracked edits (e.g. server/docker-compose.yml on EU,
#     docker-compose.agent.yml on US): LEAVE them dirty IFF the pull doesn't
#     touch that file — check `git diff <boxHEAD> origin/main -- <file>` is EMPTY.
#     If the pull DOES touch it, `git stash push <file>` then pop after.

# (c) Blocking untracked files the pull adds (verify identical to main first):
rm -f server/docker-compose.tv.yml    # only if identical; else preserve

git pull --ff-only origin main
git --no-pager diff --stat -- <box-specific files>   # confirm real edits survived
```
If unsure whether a drifted file is redundant or real, **stop and show the diff
to the user** — do not guess. (Memory: "never `git add -A` on prod box".)

> **Verified 2026-07-25 reconcile (both boxes at `91e4aa3`, deploying `b3c7fab`):**
> redundant (discard): `server/tv/getstatus.sh`, `web/db.js`, `web/live.js`,
> `web/public/assets/js/app.js`. Real box edits the pull doesn't touch (keep):
> EU `server/docker-compose.yml` (published `44450` port + `EXTRA_ARGS +set
> rs_tv_name RACESOW-TV`), US `docker-compose.agent.yml`. Blocking-untracked
> (identical to main → `rm` first): `server/docker-compose.tv.yml`.

## 3. Notify players of downtime — REQUIRED before any game restart

Run once from the **central (EU) box** — it rcon-broadcasts to *all* enrolled
servers (EU + US) at once. `admin.js` lives in the web container:

```bash
DC="docker compose exec -T web node admin.js"   # on eu.frankfurt, in ~/racesow
```

Give players a **2–5 minute** heads-up, then a final call. `maintenance on`
also re-broadcasts every 180s on a web timer, which covers the whole window:

```bash
# T-5 min: turn on maintenance (auto re-broadcasts) + explicit notice
$DC maintenance on "^3Heads up:^7 the race servers restart for an update in ~5 min — down 2-5 min, then back. Your records are safe."
# T-2 min: explicit countdown
$DC broadcast "^3Restart in ~2 minutes^7 — finish your run! Back in 2-5 min."
# T-0: about to recreate
$DC broadcast "^1Restarting now^7 — back in 2-5 minutes. Thanks!"
```

If a box has no rcon configured, `broadcast` prints how to set it
(`admin.js address <id> <host:port>` + `admin.js rcon <id> <pw>`). Do NOT restart
a populated server without this notice.

## 4. Deploy the web layer (EU only)

Zero-downtime roll of web + web2 (+ heatmaps sidecar). **Migrations apply
automatically** at web startup (node-pg-migrate, advisory-locked).

```bash
cd ~/racesow
scripts/rolling-deploy.sh          # builds racesow-web, rolls replicas one at a time
# NEVER `docker compose up -d web` directly — the SIGTERM force-kill resets
# every connection. Use the rolling script.
```
Confirm the migration ran (watch the roll output for "Applied N migration(s)")
and both replicas pass `/api/health`.

## 5. Data scans / backfills (EU only, if the change needs one)

Run one-off maintenance in the same image via the heatmaps sidecar (it already
mounts `./server/maps` at `/maps` and has `DATABASE_URL`). Example — the map
weapon scan that powers randmap-by-weapon + the website weapon filter:

```bash
docker compose run --rm heatmaps node scan-map-weapons.js   # ~minutes for 4000+ packs
curl -s localhost:8080/api/game/map-weapons | head          # sanity: non-empty, sane lines
```
Scan **only on EU** — both boxes share the same livesow map pool and the US game
fetches the central endpoint. Re-run after `fetch-maps.sh` pulls new packs.

## 6. Rebuild + restart the game servers (both boxes — interrupts players)

Only when engine/racemod/entrypoint/Dockerfile changed. Do §3 first.

```bash
cd ~/racesow
docker compose -f server/docker-compose.yml build warsow-race   # compiles engine+racemod
docker compose -f server/docker-compose.yml up -d warsow-race   # recreate (kicks players)
docker logs --tail 40 warsow-race                               # expect "Gametype 'Race' initialized", no AS errors
```
US uses the same commands (its compose is `server/docker-compose.yml`; the agent
bundle `docker-compose.agent.yml` is for third-party operators, not this box).
New `rs_api_*` cvars in `entrypoint.sh` take effect on this recreate.

## 7. All clear + verify

```bash
$DC maintenance off       # broadcasts "maintenance complete" to all servers
```
Then verify the specific change end to end, e.g. for the map-weapons feature:
- `curl -s https://racesow.org/api/game/map-weapons | head` — served.
- Website maps page: the weapon/strafe dropdown filters + per-map badges show.
- In-game: `callvote randmap strafe` and `callvote randmap rl` report a match
  count and pick a matching map; `callvote randmap q3dm*` still name-matches.
- `docker logs warsow-race | grep -i mapweapons` — fetch OK, no errors.

## 8. Rollback

- **Web**: the roll tags the prior image `racesow-web:prev`. Recover with
  `docker tag racesow-web:prev racesow-web:latest && FORCE=1 scripts/rolling-deploy.sh`.
- **Game/engine**: keep the previous image tag before building (e.g.
  `docker tag warsow-race:2.1.2 warsow-race:prev`), then recreate from `:prev`.
- **Migration**: node-pg-migrate migrations ship a `-- Down` section; roll back
  with the migrate down tooling only if a migration is the fault (rare — additive
  tables like `map_weapon` are safe to leave).
- **Code**: `git revert` on main + redeploy; don't force-push main.

## Quick reference

```
EU:  ssh $DEPLOY_USER@eu.frankfurt.racesow.org   (web+game+DB; migrations, scans here)
US:  ssh $DEPLOY_USER@us.east.racesow.org        (game only; fetches central endpoints)
auth: -i "$DEPLOY_KEY"   (set DEPLOY_USER/DEPLOY_KEY locally — not committed)
notify: docker compose exec -T web node admin.js maintenance on "…" / broadcast "…" / maintenance off
web:  scripts/rolling-deploy.sh            (migrations auto-apply; never plain `up -d web`)
game: docker compose -f server/docker-compose.yml build warsow-race && … up -d warsow-race
```
