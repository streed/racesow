#!/usr/bin/env python3
"""mapgen worker: turns queued /mapgen requests into built, checked maps.

    DATABASE_URL=postgres://... ANTHROPIC_API_KEY=... MAPGEN_DIR=/data/mapgen \\
        python3 tools/mapgen/worker.py

The web side (web/server.js /api/mapgen) only queues: it checks the daily
identity's quota and the site's budget and writes a mapgen_job row. This loop
does the work:

    queued -> planning   describe.plan: Claude writes a spec, the layout checks it
           -> building   build.build: q3map2, pack, check the compiled bsp
           -> review     files in MAPGEN_DIR/<token>/, waiting for a moderator
           -> failed     with a message the requester can read

Claiming uses FOR UPDATE SKIP LOCKED, so running two workers is safe. A worker
that dies mid-job leaves the row in planning/building; any worker re-queues
rows stuck there longer than STALE_SECONDS.

Refunds: a failed BUILD gives the requester their map back, because a map that
will not compile is our bug. A failed PLAN does not: the model call already
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
import layout  # noqa: E402

log = logging.getLogger("mapgen.worker")

POLL_SECONDS = 5
STALE_SECONDS = 30 * 60

PLAN_FAILED = ("The generator couldn't turn that description into a course it could check. "
               "Try describing it differently: the layout, the turns, where the jumps go.")
BUILD_FAILED = "The map failed to build. That one's on us, so it didn't count toward your daily maps."


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
           RETURNING id, token, description, quota_day, identity""",
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


def run_job(conn, job, out_root, planner, builder, q3map2=None):
    job_id, token, description, quota_day, identity = job
    log.info("job %s: planning %r", job_id, description[:80])
    try:
        spec, attempts = planner(description, log=lambda m: log.info("job %s: %s", job_id, m))
        spec["name"] = unique_name(spec["name"], token)
        layout.build(spec)   # the name changed; re-check before anything else
    except Exception as e:   # noqa: BLE001 - any planning failure is the same answer
        with conn.cursor() as cur:
            fail(cur, job_id, PLAN_FAILED, f"{type(e).__name__}: {e}")
        conn.commit()
        return "failed"

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE mapgen_job SET status = 'building', map_name = %s, spec = %s WHERE id = %s",
            (spec["name"], json.dumps(spec), job_id),
        )
    conn.commit()

    out = os.path.join(out_root, token)
    try:
        log.info("job %s: building %s", job_id, spec["name"])
        _pk3, report = builder(spec, out, q3map2=q3map2)
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

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE mapgen_job SET status = 'review', report = %s, finished_at = %s WHERE id = %s",
            (json.dumps(report), now(), job_id),
        )
    conn.commit()
    log.info("job %s: ready for review (%s)", job_id, spec["name"])
    return "review"


def run_once(conn, out_root, planner, builder, q3map2=None):
    """Claim and run at most one job. Returns its outcome, or None when idle."""
    with conn.cursor() as cur:
        stale = requeue_stale(cur)
        job = claim(cur)
    conn.commit()
    if stale:
        log.warning("re-queued %d stale job(s)", stale)
    if not job:
        return None
    return run_job(conn, job, out_root, planner, builder, q3map2)


def main():
    import psycopg

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    import describe

    url = os.environ.get("DATABASE_URL")
    out_root = os.environ.get("MAPGEN_DIR", "/data/mapgen")
    if not url:
        sys.exit("DATABASE_URL is required")
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("ANTHROPIC_API_KEY is required: the worker plans every map with Claude")
    if not buildmod.find_q3map2():
        sys.exit("q3map2 not found (set Q3MAP2)")
    os.makedirs(out_root, exist_ok=True)
    log.info("mapgen worker up; writing to %s", out_root)
    while True:
        try:
            with psycopg.connect(url) as conn:
                while True:
                    if run_once(conn, out_root, describe.plan, buildmod.build) is None:
                        time.sleep(POLL_SECONDS)
        except psycopg.OperationalError as e:
            log.warning("database unavailable (%s); retrying", e)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
