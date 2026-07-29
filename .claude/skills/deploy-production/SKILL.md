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
| EU / central | `eu.frankfurt.racesow.org` | web (web + web2 + heatmaps), Postgres, redis, discord, **warsow-race**, **warfork-race**, warsow-tv-capture | The central stats DB + the site. All migrations + data scans happen here. |
| US | `us.east.racesow.org` | **warsow-race**, **warfork-race** (+ warsow-tv-capture, tv-hls, pakserver, sftp) | No DB/web. The game fetches central endpoints (`rs_api_*_url`) over Cloudflare→EU. Deploy = code + game rebuild only. |

Repo on each box: `~/racesow`, tracking `origin/main`. Deploy = box pulls `main`,
then rebuild/recreate the affected containers. Both boxes now run **two** game
servers (Warsow + Warfork; §6 has the per-server compose files) and a
**`racesow-xpiry-heartbeat`** systemd timer pushing uptime to xpiry.dev (its
`XPIRY_*` + `XPIRY_API_KEY` live in each box's `.env`, gitignored — untouched by
a pull). Set `DEPLOY_USER`/`DEPLOY_KEY` from the placeholder block below (not
committed here); add `-o IdentityAgent=none -o IdentitiesOnly=yes` to every ssh
call if the local agent interferes.

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
>
> **Verified 2026-07-29 reconcile (both boxes `bc148db`→`11fc57d`):** the pull
> blocks on prior rsync-overlay files that later landed in main — classify each
> against `origin/main` and `rm` only the byte-identical ones (this loop is safe):
> ```bash
> git fetch origin main -q
> for f in $(git diff --name-only <boxHEAD>..origin/main); do
>   if [ -e "$f" ] && ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
>     git show "origin/main:$f" | diff -q - "$f" >/dev/null 2>&1 \
>       && { echo "rm $f"; rm -f "$f"; } || echo "DIFFERS (keep, review): $f"
>   fi
> done
> git pull --ff-only origin main
> ```
> Files seen: EU — the 3 xpiry files (`scripts/xpiry-heartbeat.sh`,
> `systemd/racesow-xpiry-heartbeat.{service,timer}`). US — those plus the sftp/
> demo overlay (`scripts/ingest-demos.sh`, `server/docker-compose.sftp.yml`,
> `server/sftp/*`, `systemd/racesow-demo-ingest.*`, `web/demo-meta.mjs`); all 8
> were identical → rm'd. Real box edit kept (pull doesn't touch it): US
> `docker-compose.agent.yml`. `.env` (XPIRY_* etc.) is gitignored → never touched.

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

Only when engine/racemod/entrypoint/Dockerfile OR warfork/* changed. Do §3 first.
**Each box now runs TWO game servers — Warsow AND Warfork — and each is a
distinct compose project/file. Get these exactly right or you rebuild/recreate
the wrong thing (or spawn a duplicate that fails silently):**

| Box  | Server       | compose file                 | `-p` project | working_dir        | image tag              |
|------|--------------|------------------------------|--------------|--------------------|------------------------|
| EU   | warsow-race  | `server/docker-compose.yml`  | `server`     | `~/racesow/server` | `warsow-race:2.1.2`    |
| US   | warsow-race  | `docker-compose.agent.yml`   | `racesow`    | `~/racesow`        | `warsow-race:2.1.2`    |
| both | warfork-race | `docker-compose.warfork.yml` | `racesow`    | `~/racesow`        | `warfork-race:racesow` |

Confirm on the box:
`docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' <name>`.
The racemod `.as` is **baked into the image**, and Warfork runs the SAME racemod,
so ANY racemod change means rebuilding BOTH games. Use explicit `-p`/`-f` (don't
rely on cwd) and `build` then a **`--force-recreate`**:

```bash
# EU warsow
docker compose -p server  -f ~/racesow/server/docker-compose.yml   build warsow-race
docker compose -p server  -f ~/racesow/server/docker-compose.yml   up -d --force-recreate warsow-race
# US warsow  (NOT server/docker-compose.yml — an older version of this doc was wrong)
docker compose -p racesow -f ~/racesow/docker-compose.agent.yml    build warsow-race
docker compose -p racesow -f ~/racesow/docker-compose.agent.yml    up -d --force-recreate warsow-race
# Warfork (both boxes)
docker compose -p racesow -f ~/racesow/docker-compose.warfork.yml  build warfork-race
docker compose -p racesow -f ~/racesow/docker-compose.warfork.yml  up -d --force-recreate warfork-race
```

Gotchas that WILL bite you:
- **`--force-recreate` is mandatory.** The image tag is reused, so a plain
  `up -d` sees "same tag" and does NOT swap to the freshly-built image — the
  container keeps running OLD code and reports success. Verify the swap:
  `[ "$(docker inspect -f '{{.Image}}' warsow-race)" = "$(docker image inspect -f '{{.Id}}' warsow-race:2.1.2)" ] && echo FRESH || echo STALE`.
- **`docker compose exec -T … node admin.js` reads stdin — it eats heredocs.** If
  you script the §3 notify and the recreate together in one `ssh 'bash -s' <<'EOF'`,
  the `exec -T` consumes the rest of the heredoc and the recreate lines silently
  never run (exit 0, no output). Do the notify as its OWN ssh call, or append
  `</dev/null` to the exec.
- **Warsow boot takes 60-90s on prod** (loads the 4000+ pak livesow mirror). No
  `Gametype 'Race' initialized` within 45s is NOT a failure if the container is
  `running`, on the FRESH image, with no AS errors — wait and re-check the logs.
  Warfork boots in seconds.
- Boot-test each: `docker logs <name> | grep -E "Gametype 'Race' initialized"`,
  scan for AS errors, and confirm `rs_mirror: configured … peers=N`.

**Stagger the boxes:** builds are non-disruptive (old container keeps serving), so
build BOTH boxes first, then recreate EU (both games) and confirm healthy BEFORE
recreating US — keeps the EU↔US mesh from going down on both ends at once.
Rollback: `docker tag warsow-race:2.1.2 warsow-race:prev` (and
`warfork-race:racesow`→`:prev`) before building; recreate from `:prev` if a
boot-test fails. New `rs_api_*` cvars in `entrypoint.sh` take effect on recreate.

**PRE-FLIGHT (strongly recommended for racemod/engine):** build + boot-test
LOCALLY first — `.as` compiles at BOOT not build, so a green build can still fail
gametype init (memory: Warsow AS is stricter than Warfork; a bad ternary passed
Warfork build but broke Warsow at boot). Validates the shared racemod before any
prod downtime:
```bash
docker compose -f server/docker-compose.yml build warsow-race
docker run -d --name wsw-boot --tty -e SV_PUBLIC=0 --ulimit nofile=16384:16384 \
  warsow-race:2.1.2 +map wbomb1
docker logs wsw-boot | grep "Gametype 'Race' initialized"   # + no AS errors; then: docker rm -f wsw-boot
```

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
