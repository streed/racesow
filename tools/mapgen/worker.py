#!/usr/bin/env python3
"""mapgen worker: turns queued /mapgen requests into built, checked maps.

    DATABASE_URL=postgres://... ANTHROPIC_API_KEY=... MAPGEN_DIR=/data/mapgen \\
        MAPGEN_STORE=/srv/store python3 tools/mapgen/worker.py

The web side (web/server.js /api/mapgen) only queues: it checks the daily
identity's quota and the site's budget and writes a mapgen_job row. This loop
does the work:

    queued -> planning   describe.plan: Claude writes a spec, the layout checks it
                         (a job from the map editor already HAS a spec: it is
                         only checked, and no model is called)
           -> building   build.build: q3map2, pack, check the compiled bsp
           -> publishing the .pk3 is in the shared map store (MAPGEN_STORE)
           -> published  set by the web once a game server confirms it loaded
                         the map (sv_mapscan picks up new packs within a minute;
                         GET /api/game/map-sync carries the confirmation)
           -> failed     with a message the requester can read

There is no human step: a map that passes every automated check (the spec
ranges, the layout rules, the compile, tools/mapfix and the race-entity
checks on the compiled bsp) is published. A moderator can still pull one
afterwards with the map blocklist.

Claiming uses FOR UPDATE SKIP LOCKED, so running two workers is safe. A worker
that dies mid-job leaves the row in planning/building; any worker re-queues
rows stuck there longer than STALE_SECONDS.

Refunds: a failed BUILD or PUBLISH gives the requester their map back, because
a map that will not compile, or a store we cannot write, is our fault. A failed PLAN does not: the model call already
cost what the quota exists to bound, and "that description can't be made into
a course" is a real answer.
"""

import json
import logging
import os
import shutil
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build as buildmod  # noqa: E402
import describe  # noqa: E402
import layout  # noqa: E402
import spec as specmod  # noqa: E402

log = logging.getLogger("mapgen.worker")

POLL_SECONDS = 5
STALE_SECONDS = 30 * 60

PLAN_FAILED = ("The generator couldn't turn that description into a course it could check. "
               "Try describing it differently: the layout, the turns, where the jumps go.")
BUILD_FAILED = "The map failed to build. That one's on us, so it didn't count toward your daily maps."
EDITOR_FAILED = ("The generator refused this course: {problems} That one didn't count toward "
                 "your daily maps. Open it in the editor to fix it.")
PUBLISH_FAILED = ("The map was built but couldn't be copied to the servers. That one's on us, "
                  "so it didn't count toward your daily maps.")
STORE_SENTINEL = ".racesow-map-store"   # docs/shared-maps.md


class PublishError(Exception):
    pass


def publish(pk3, store):
    """Copy a built pack into the shared map store, where every game server's
    sv_mapscan finds it (docs/shared-maps.md). Returns the stored path.

    The store's rules hold: never rewrite a pack in place (a new name every
    time, and an existing one is refused), and never write into a directory
    that is not the store (no sentinel = an empty mountpoint or a typo). The
    copy lands under a dot-name the engine does not scan, and is renamed into
    place in one step, so a server never loads half a pack."""
    if not store or not os.path.isfile(os.path.join(store, STORE_SENTINEL)):
        raise PublishError(f"{store!r} is not the map store (no {STORE_SENTINEL})")
    size = os.path.getsize(pk3)
    if size > buildmod.PK3_MAX_BYTES:   # build() already refuses these; the store is shared
        raise PublishError(f"{pk3} is {size} bytes; at most {buildmod.PK3_MAX_BYTES}")
    name = os.path.basename(pk3)
    dest = os.path.join(store, name)
    if os.path.exists(dest):
        raise PublishError(f"{dest} already exists; packs are never rewritten in place")
    part = os.path.join(store, "." + name + ".part")
    try:
        with open(pk3, "rb") as src, open(part, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.chmod(part, 0o644)
        os.rename(part, dest)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return dest


def now():
    return int(time.time())


def unique_name(spec_name, token):
    """The model picks a readable gen_ name; two requests may well pick the same
    one. A slice of the job's random token keeps every map name unique without
    losing the readable part. Stays inside spec.NAME_RE (gen_ + 2-36 chars)."""
    stem = spec_name[len("gen_"):] if spec_name.startswith("gen_") else spec_name
    stem = "".join(c for c in stem.lower() if c.isalnum() or c == "_")[:29] or "map"
    return f"gen_{stem}_{token[:6]}"


def requeue_stale(cur):
    cur.execute(
        """UPDATE mapgen_job SET status = 'queued', started_at = NULL
           WHERE status IN ('planning', 'building') AND started_at < %s""",
        (now() - STALE_SECONDS,),
    )
    return cur.rowcount


def claim(cur):
    cur.execute(
        """UPDATE mapgen_job SET status = 'planning', started_at = %s
           WHERE id = (SELECT id FROM mapgen_job WHERE status = 'queued'
                       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING id, token, description, quota_day, identity, source, spec""",
        (now(),),
    )
    return cur.fetchone()


def fail(cur, job_id, message, detail, refund=None):
    log.warning("job %s failed: %s", job_id, detail)
    cur.execute(
        "UPDATE mapgen_job SET status = 'failed', error = %s, finished_at = %s WHERE id = %s",
        (message, now(), job_id),
    )
    if refund and refund[1] is not None:
        day, identity = refund
        cur.execute(
            "UPDATE mapgen_quota SET used = used - 1 WHERE day = %s AND identity = %s AND used > 0",
            (day, identity),
        )


def record_usage(cur, job_id, calls):
    """Store what planning this job cost in Claude tokens (llm_usage, never
    served by the web) and log a one-line summary. Failed plans are recorded
    too: every call is billed whether or not a map comes out of it."""
    summary = describe.usage_summary(calls)
    cur.execute("UPDATE mapgen_job SET llm_usage = %s WHERE id = %s",
                (json.dumps(summary), job_id))
    est = summary["est_usd"]
    log.info("job %s: Claude usage: %d call(s), %d input + %d cache-write + %d cache-read "
             "+ %d output tokens, ~%s", job_id, summary["calls"], summary["input_tokens"],
             summary["cache_creation_input_tokens"], summary["cache_read_input_tokens"],
             summary["output_tokens"], "?" if est is None else f"${est:.4f}")


def check_editor_spec(raw, token):
    """A spec someone built by hand on /mapgen/editor -> (spec, problems).

    It is as untrusted as a model's draft and goes through the same gate:
    normalize (only known keys survive), a unique name, then spec.validate and
    the layout. The editor ran the same rules in the page (its port is pinned
    to this tree by golden.py), so a refusal here is rare; when it happens the
    problems are what the requester sees."""
    if not isinstance(raw, dict) or not isinstance(raw.get("segments"), list):
        return None, ["the spec is not a course"]
    if not all(isinstance(s, dict) for s in raw["segments"]):
        return None, ["every segment must be an object"]
    spec = specmod.normalize(raw)
    spec["name"] = unique_name(spec.get("name") if isinstance(spec.get("name"), str) else "gen_map", token)
    try:
        layout.build(spec)
    except layout.LayoutError as e:
        return None, e.problems
    return spec, []


def run_job(conn, job, out_root, planner, builder, q3map2=None, store=None):
    job_id, token, description, quota_day, identity, *rest = job
    source, editor_spec = (list(rest) + [None, None])[:2]
    if source == "editor":
        log.info("job %s: checking an editor spec", job_id)
        if isinstance(editor_spec, str):
            editor_spec = json.loads(editor_spec)
        spec, problems = check_editor_spec(editor_spec, token)
        attempts = 0
        if problems:
            with conn.cursor() as cur:
                # No model was called, so nothing was spent: refund it.
                fail(cur, job_id, EDITOR_FAILED.format(problems="; ".join(problems[:3]) + "."),
                     "editor spec refused: " + "; ".join(problems), refund=(quota_day, identity))
            conn.commit()
            return "failed"
    else:
        log.info("job %s: planning %r", job_id, description[:80])
        calls = []
        try:
            spec, attempts = planner(description, log=lambda m: log.info("job %s: %s", job_id, m),
                                     usage=calls)
            spec["name"] = unique_name(spec["name"], token)
            layout.build(spec)   # the name changed; re-check before anything else
        except Exception as e:   # noqa: BLE001 - any planning failure is the same answer
            with conn.cursor() as cur:
                record_usage(cur, job_id, calls)
                fail(cur, job_id, PLAN_FAILED, f"{type(e).__name__}: {e}")
            conn.commit()
            return "failed"
        with conn.cursor() as cur:
            record_usage(cur, job_id, calls)

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE mapgen_job SET status = 'building', map_name = %s, spec = %s WHERE id = %s",
            (spec["name"], json.dumps(spec), job_id),
        )
    conn.commit()

    out = os.path.join(out_root, token)
    try:
        log.info("job %s: building %s", job_id, spec["name"])
        pk3, report = builder(spec, out, q3map2=q3map2)
        # The web serves the preview under a fixed name, so no path in a URL
        # ever has to carry the map name.
        shutil.copyfile(os.path.join(out, spec["name"] + ".svg"), os.path.join(out, "plan.svg"))
        report = {k: v for k, v in report.items() if k != "pk3"}
        report["plan_attempts"] = attempts
    except Exception as e:   # noqa: BLE001
        with conn.cursor() as cur:
            fail(cur, job_id, BUILD_FAILED, traceback.format_exc(), refund=(quota_day, identity))
        conn.commit()
        return "failed"

    try:
        stored = publish(pk3, store)
    except Exception as e:   # noqa: BLE001
        with conn.cursor() as cur:
            cur.execute("UPDATE mapgen_job SET report = %s WHERE id = %s", (json.dumps(report), job_id))
            fail(cur, job_id, PUBLISH_FAILED, f"{type(e).__name__}: {e}", refund=(quota_day, identity))
        conn.commit()
        return "failed"

    t = now()
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE mapgen_job SET status = 'publishing', report = %s, finished_at = %s,
                      published_at = %s WHERE id = %s""",
            (json.dumps(report), t, t, job_id),
        )
    conn.commit()
    log.info("job %s: published %s to the map store", job_id, stored)
    return "publishing"


def run_once(conn, out_root, planner, builder, q3map2=None, store=None):
    """Claim and run at most one job. Returns its outcome, or None when idle."""
    with conn.cursor() as cur:
        stale = requeue_stale(cur)
        job = claim(cur)
    conn.commit()
    if stale:
        log.warning("re-queued %d stale job(s)", stale)
    if not job:
        return None
    return run_job(conn, job, out_root, planner, builder, q3map2, store)


def main():
    import psycopg

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    url = os.environ.get("DATABASE_URL")
    out_root = os.environ.get("MAPGEN_DIR", "/data/mapgen")
    store = os.environ.get("MAPGEN_STORE", "")
    if not url:
        sys.exit("DATABASE_URL is required")
    if not os.path.isfile(os.path.join(store, STORE_SENTINEL)):
        sys.exit(f"MAPGEN_STORE={store!r} is not the map store (no {STORE_SENTINEL}); "
                 "the worker publishes every map it builds there")
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("ANTHROPIC_API_KEY is required: the worker plans every map with Claude")
    if not buildmod.find_q3map2():
        sys.exit("q3map2 not found (set Q3MAP2)")
    os.makedirs(out_root, exist_ok=True)
    log.info("mapgen worker up; building in %s, publishing to %s", out_root, store)
    while True:
        try:
            with psycopg.connect(url) as conn:
                while True:
                    if run_once(conn, out_root, describe.plan, buildmod.build, store=store) is None:
                        time.sleep(POLL_SECONDS)
        except psycopg.OperationalError as e:
            log.warning("database unavailable (%s); retrying", e)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
