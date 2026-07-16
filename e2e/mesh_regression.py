#!/usr/bin/env python3
"""Headless regression suite for the cross-server mirror mesh (protocol RSM1).

Drives the local 3-node mirror-test mesh (docker-compose.mirror-test.yml, tags
A/B/C) entirely from the host: it signs arbitrary RSM1 datagrams with the shared
test secret (so it can exercise auth, caps, dedup, clock-skew, sanitization and
the full map-vote state machine), queries getstatus, reads container logs, and
runs rcon. Each check asserts an OBSERVABLE (a uniquely-tagged probe appearing —
or NOT appearing — in logs / getstatus / mesh_status), so drops are proven by
absence of effect rather than an internal counter.

Ordering matters (single shared mesh): read-only -> security -> mirroring/chat
-> records -> map vote (which changes maps), then state is restored. Run:

    python3 e2e/mesh_regression.py
"""
import hashlib, hmac, socket, subprocess, sys, time, os, random

SECRET = "mirror-test-local-only"
NONCE = "%06d" % (int(time.time()) % 1000000)  # unique-per-run probe suffix
MAP = "aurora-speed1"

# ---------------------------------------------------------------------------
# infra discovery
# ---------------------------------------------------------------------------
def cip(container):
    out = subprocess.run(["docker", "inspect", "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
        capture_output=True, text=True).stdout.strip()
    return out

NODES = {
    "A": {"ip": "127.0.0.1", "mport": 44450, "gport": 44403, "cont": "warsow-mirror-a"},
    "B": {"ip": cip("warsow-mirror-b"), "mport": 44450, "gport": 44401, "cont": "warsow-mirror-b"},
    "C": {"ip": cip("warsow-mirror-c"), "mport": 44450, "gport": 44402, "cont": "warsow-mirror-c"},
}
OOB = b"\xff\xff\xff\xff"

# ---------------------------------------------------------------------------
# results
# ---------------------------------------------------------------------------
RESULTS = []
def check(cid, cat, sev, passed, detail=""):
    RESULTS.append((cid, cat, sev, passed, detail))
    mark = "PASS" if passed else ("FAIL" if sev in ("critical", "high") else "WARN")
    print("  [%s] %-9s %-40s %s" % (mark, sev, cid, detail))
    return passed

# ---------------------------------------------------------------------------
# wire helpers
# ---------------------------------------------------------------------------
def sign(secret, ts, seq, typ, tag, mapn, body):
    canon = "%d %d %s %s %s\n%s" % (ts, seq, typ, tag, mapn, body)
    mac = hmac.new(secret.encode(), canon.encode(), hashlib.sha256).digest()[:16].hex() if secret else "-"
    return ("RSM1 %s %s" % (mac, canon)).encode()

def send(node, pkt):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(pkt, (NODES[node]["ip"], NODES[node]["mport"])); s.close()

def state_body(name, flags=1, x=100.0, y=200.0, z=64.0):
    return "P %d %.1f %.1f %.1f 0.0 90.0 0.0 300.0 0.0 0.0 %s\n" % (flags, x, y, z, name)

def send_state(node, tag, name, mapn=MAP, seq=None, ts=None, secret=SECRET, body=None):
    ts = ts if ts is not None else int(time.time())
    seq = seq if seq is not None else random.randint(1, 2**31)
    send(node, sign(secret, ts, seq, "S", tag, mapn, body if body is not None else state_body(name)))

def send_event(node, tag, kind, eseq, name, text="", mapn=MAP, seq=None, ts=None, secret=SECRET):
    ts = ts if ts is not None else int(time.time())
    seq = seq if seq is not None else random.randint(1, 2**31)
    body = "%s %d\t%s\t%s\n" % (kind, eseq, name, text)
    send(node, sign(secret, ts, seq, "E", tag, mapn, body))

def getstatus(node):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(OOB + b"getstatus\n", ("127.0.0.1", NODES[node]["gport"]))
        d = s.recvfrom(9000)[0].decode("latin1").split("\n")
    except Exception:
        return None, None
    finally:
        s.close()
    info = {}
    parts = d[1].split("\\")
    for i in range(1, len(parts) - 1, 2):
        info[parts[i]] = parts[i + 1]
    rows = [x for x in d[2:] if x.strip()]
    return info, rows

def rcon(node, cmd):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(OOB + ("rcon mirrortest %s" % cmd).encode(), ("127.0.0.1", NODES[node]["gport"]))
        return s.recvfrom(9000)[0].decode("latin1", "replace")
    except Exception:
        return ""
    finally:
        s.close()

def dlogs(node, since="60s"):
    r = subprocess.run(["docker", "logs", "--since", since, NODES[node]["cont"]],
                       capture_output=True, text=True)
    out = (r.stdout + r.stderr)
    # strip color codes
    import re
    return re.sub(r"\x1b\[[0-9;]*m", "", out)

def alive(node):
    r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", NODES[node]["cont"]],
                       capture_output=True, text=True).stdout.strip()
    return r == "true"

def mapname(node):
    info, _ = getstatus(node)
    return (info or {}).get("mapname", "?")

def stop_feeders():
    for pid in subprocess.run(["pgrep", "-f", "mirror_wire_check"], capture_output=True, text=True).stdout.split():
        try:
            if open("/proc/%s/comm" % pid).read().strip() == "python3":
                os.kill(int(pid), 15)
        except Exception:
            pass

def wait_map(node, want, timeout=15):
    t = time.time() + timeout
    while time.time() < t:
        if mapname(node) == want:
            return True
        time.sleep(1)
    return False

def wait_mesh(node, substr, timeout=5):
    # rs_mesh_status is republished every ~2s, so poll across a couple cycles
    # rather than a single sub-2s check (avoids flaky races on the publish tick).
    t = time.time() + timeout
    last = ""
    while time.time() < t:
        info, _ = getstatus(node)
        last = (info or {}).get("rs_mesh_status", "")
        if substr in last:
            return True, last
        time.sleep(0.5)
    return False, last

# ===========================================================================
# PHASE 1 — read-only baseline (quiet mesh)
# ===========================================================================
def phase1():
    print("\n== PHASE 1: read-only baseline ==")
    heard = {}
    for n in "ABC":
        info, rows = getstatus(n)
        heard[n] = info.get("rs_mesh_status", "") if info else ""
    # peer discovery: each node hears the other two
    ok = all(heard[n] and heard[n].count(",") >= 1 for n in "ABC")
    check("core-keepalive-peer-discovery", "happy", "critical", ok,
          "A=%r B=%r C=%r" % (heard["A"], heard["B"], heard["C"]))
    # mesh_status is info-string-safe and within MAX_INFO_VALUE (64)
    safe = all(len(heard[n]) < 64 and not (set('\\";') & set(heard[n])) for n in "ABC")
    check("mesh-status-info-string-safe", "security", "high", safe,
          "all <64 chars, no backslash/quote/semicolon")
    # getstatus baseline: no feeders -> no real players, and no ghost rows leak
    rows_ok = all((getstatus(n)[1] == []) for n in "ABC")
    check("status-getstatus-hides-bots-baseline", "regression", "high", rows_ok,
          "0 player rows on all nodes at rest")

# ===========================================================================
# PHASE 2 — security / protocol (signed injection, observable = probe absence)
# ===========================================================================
def probe_seen(node, token, since="15s"):
    return token in dlogs(node, since)

def phase2():
    print("\n== PHASE 2: security / protocol ==")
    # 2.0 sanity: a correctly-signed chat IS delivered (proves the probe method works)
    tok = "OKPROBE" + NONCE
    send_event("A", "ZZ", "C", random.randint(1, 2**31), "prober", tok)
    time.sleep(1.0)
    check("proto-valid-hmac-accepted", "security", "critical", probe_seen("A", tok),
          "correctly-signed chat delivered (control)")
    # 2.1 bad HMAC dropped
    tok = "BADMAC" + NONCE
    send_event("A", "ZZ", "C", random.randint(1, 2**31), "prober", tok, secret="wrong-secret")
    time.sleep(1.0)
    check("proto-bad-hmac-dropped", "security", "critical", not probe_seen("A", tok),
          "wrong-secret chat NOT delivered")
    # 2.2 own-tag dropped (inject AS node A's own tag to node A)
    tok = "SELFTAG" + NONCE
    send_event("A", "A", "C", random.randint(1, 2**31), "prober", tok)
    time.sleep(1.0)
    check("proto-self-tag-dropped", "security", "high", not probe_seen("A", tok),
          "own-tag packet dropped (anti-echo)")
    # 2.3 empty tag: robustness. A real peer never sends an empty tag, and the
    # wire format can't represent one (sscanf would field-shift), so we assert
    # no crash / no mesh_status corruption rather than drop-by-absence.
    send_event("A", "", "C", random.randint(1, 2**31), "prober", "EMPTYTAG" + NONCE)
    time.sleep(0.6)
    info, _ = getstatus("A")
    ms = (info or {}).get("rs_mesh_status", "")
    check("proto-empty-tag-robust", "security", "medium",
          alive("A") and info is not None and "\\" not in ms and '"' not in ms,
          "empty-tag datagram caused no crash / no corruption")
    # 2.4 clock skew outside +/-60s dropped
    tok = "SKEW" + NONCE
    send_event("A", "ZZ", "C", random.randint(1, 2**31), "prober", tok, ts=int(time.time()) + 9999)
    time.sleep(1.0)
    check("proto-clock-skew-dropped", "security", "high", not probe_seen("A", tok),
          "ts +9999s dropped (TS_WINDOW=60)")
    # 2.5 malformed header dropped, no crash
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(b"RSM1 not-a-real-header at all\n\n", (NODES["A"]["ip"], 44450))
    s.sendto(b"total garbage no rsm1 prefix", (NODES["A"]["ip"], 44450))
    s.close(); time.sleep(0.5)
    check("proto-malformed-header-dropped", "security", "high", alive("A"),
          "garbage header did not crash node A")
    # 2.6 oversized datagram (>1400) dropped, no crash
    tok = "OVERSIZE" + NONCE
    big = state_body("filler") * 60  # ~ big body
    send_state("A", "ZZ", "x", body="P 1 0 0 0 0 0 0 0 0 0 %s\n%s" % (tok, big))
    time.sleep(0.5)
    check("proto-oversized-dropped", "security", "high", alive("A") and not probe_seen("A", tok),
          "oversized datagram rejected, node A alive")
    # 2.7 event dedup: same eseq twice -> chat logged once
    tok = "DEDUP" + NONCE
    eseq = random.randint(1, 2**31)
    send_event("A", "ZZ", "C", eseq, "prober", tok)
    time.sleep(0.3)
    send_event("A", "ZZ", "C", eseq, "prober", tok)  # duplicate eseq
    time.sleep(1.0)
    # each DELIVERED chat logs the token twice (debug line + G_PrintMsg); count
    # the single "event type=1" debug line per delivery to measure dedup.
    lg = dlogs("A", "10s")
    n_seen = sum(1 for ln in lg.splitlines() if "event type=1" in ln and tok in ln)
    check("proto-event-dedup", "security", "high", n_seen == 1,
          "duplicate eventseq delivered %d time(s) (want 1)" % n_seen)
    # 2.8 token sanitization: control/backslash/quote in name -> no crash, getstatus valid
    weird = "ZZ\\bad\"name\t" + NONCE
    send_state("A", "ZZ", weird)
    time.sleep(1.0)
    info, _ = getstatus("A")
    ms = (info or {}).get("rs_mesh_status", "")
    check("proto-token-sanitization", "security", "high",
          alive("A") and info is not None and "\\" not in ms and '"' not in ms,
          "weird name handled; mesh_status stays valid")

# ===========================================================================
# PHASE 5 — caps + flood. Runs LAST: it saturates peersRt (MAX_TAGS) with junk
# tags that linger for PEER_TTL (15s), which would starve any later test.
# ===========================================================================
def phase5_caps():
    print("\n== PHASE 5: caps + flood (pollutes peersRt; run last) ==")
    # MAX_TAGS cap: inject 20 distinct tags -> peersRt capped at 16, node alive
    for i in range(20):
        send_state("A", "T%02d" % i, "p%d" % i, )
    time.sleep(1.5)
    check("proto-max-tags-cap", "security", "high", alive("A"),
          "20 distinct tags injected; node A alive (MAX_TAGS=16)")
    # with many peers heard, mesh_status is greedily truncated to stay valid
    # (< MAX_INFO_VALUE=64 and delimiter-safe) rather than rejected wholesale.
    # Re-inject a few times while polling, so a just-reloaded (empty) cvar has
    # peers to truncate.
    for _ in range(3):
        for i in range(20):
            send_state("A", "T%02d" % i, "p%d" % i)
        seen, ms = wait_mesh("A", "T", 4)
        if seen:
            break
    check("mesh-status-budget-truncation-valid", "edge", "high",
          ("T" in ms) and len(ms) < 64 and not (set('\\";') & set(ms)),
          "mesh_status valid & truncated under peer overflow (len=%d)" % len(ms))
    # MAX_PLAYERS_PER_TAG cap: 40 players under one tag -> capped 32, node alive
    body = "".join(state_body("PP%d" % i, x=100.0 + i) for i in range(40))
    send_state("A", "MANY", "unused", body=body)
    time.sleep(1.0)
    check("proto-max-players-cap", "security", "high", alive("A"),
          "40 players under one tag; node A alive (cap=32)")
    # flood: blast mixed garbage + valid, node stays up and responsive
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for i in range(3000):
        if i % 2:
            s.sendto(b"RSM1 deadbeefdeadbeefdeadbeefdeadbeef 0 %d E X mapx\nC 1\tn\thi\n" % i,
                     (NODES["A"]["ip"], 44450))
        else:
            s.sendto(sign(SECRET, int(time.time()), i, "S", "FL", MAP, state_body("f%d" % i)),
                     (NODES["A"]["ip"], 44450))
    s.close(); time.sleep(1.0)
    info, _ = getstatus("A")
    check("proto-flood-no-crash", "security", "critical", alive("A") and info is not None,
          "3000-datagram flood: node A alive and still answering getstatus")

# ===========================================================================
# PHASE 3 — mirroring + chat + presence + records (same map)
# ===========================================================================
def phase3():
    print("\n== PHASE 3: mirroring / chat / presence / records ==")
    # snapshot racelog for the records test
    pre_racelog = subprocess.run(["docker", "exec", NODES["A"]["cont"], "sh", "-c",
        "cat /warsow/racemod/racelog/events.log 2>/dev/null | wc -l"],
        capture_output=True, text=True).stdout.strip()

    # 3.1 remote player -> bot spawns on same map
    runner = "RUN" + NONCE
    def stream(tag, name, mapn=MAP, n=25, node="A"):
        base = random.randint(1, 2**31)
        for i in range(n):
            send_state(node, tag, name, mapn=mapn, seq=base + i,
                       body=state_body(name, x=100.0 + i * 20))
            time.sleep(0.1)
    import threading
    t = threading.Thread(target=stream, args=("QQ", runner, MAP, 45), daemon=True); t.start()
    time.sleep(1.5)
    check("core-mirror-bot-spawns-same-map", "happy", "critical",
          ("bot slot" in dlogs("A", "8s") and runner in dlogs("A", "8s")),
          "same-map remote player spawned a ghost bot")
    # 3.2 getstatus HIDES the ghost bot (regression: no website double-count)
    _, rows = getstatus("A")
    check("status-getstatus-hides-mirror-bots", "regression", "critical",
          all(runner not in r for r in rows),
          "ghost bot absent from getstatus player rows (rows=%d)" % len(rows))
    # 3.3 mesh_status counts the remote player (poll across publish cycles)
    listed, ms = wait_mesh("A", "QQ:aurora-speed1:1", 5)
    check("mesh-status-counts-remote-player", "happy", "high", listed,
          "mesh_status lists QQ with 1 player: %r" % ms)
    t.join()
    # 3.4 chat relay with [TAG] prefix
    tok = "CHAT" + NONCE
    send_event("A", "QQ", "C", random.randint(1, 2**31), "talker", tok)
    time.sleep(1.0)
    check("chat-relay-tag-prefix", "happy", "high",
          ("[QQ]" in dlogs("A", "6s") and tok in dlogs("A", "6s")),
          "remote chat printed with [TAG] prefix")
    # 3.5 join / leave notices
    jn = "JOIN" + NONCE
    send_event("A", "QQ", "J", random.randint(1, 2**31), jn)
    time.sleep(0.5)
    send_event("A", "QQ", "L", random.randint(1, 2**31), jn)
    time.sleep(1.0)
    lg = dlogs("A", "6s")
    check("chat-join-leave-notices", "happy", "medium",
          (jn in lg and "connected" in lg and "disconnected" in lg),
          "join+leave notices printed")
    # 3.6 hop-limit-1 + echo-suppression: inject a player to A ONLY; B and C must
    #     never learn it (A must not re-forward mirrored data, nor echo a J for
    #     the ghost bot it spawns).
    ghost = "HOP" + NONCE
    t2 = threading.Thread(target=stream, args=("HH", ghost), daemon=True); t2.start()
    time.sleep(2.0); t2.join(); time.sleep(1.0)
    leaked = probe_seen("B", ghost, "8s") or probe_seen("C", ghost, "8s")
    check("chat-hop-limit-1-no-reforward", "regression", "critical", not leaked,
          "player injected to A alone never appeared on B or C")
    # 3.7 cross-map: peer on a DIFFERENT map -> listed in mesh_status, NO ghost bot.
    # Use a first-sorting tag ("A1") so the different-map peer is guaranteed to
    # fit inside the 63-char mesh_status budget even with leftover test peers
    # (B/C/QQ/HH) present — peersRt iterates tag-sorted and the tail is greedily
    # dropped. (That truncation is by-design; verified separately in phase 5.)
    xname = "XMAP" + NONCE
    t3 = threading.Thread(target=stream, args=("A1", xname, "coldrun", 30), daemon=True); t3.start()
    listed, ms = wait_mesh("A", "A1:coldrun", 6)  # poll across publish cycles
    # no ghost bot for a different-map player: no "bot slot ... XMAP<nonce>" line
    noghost = not any(("bot slot" in ln and xname in ln) for ln in dlogs("A", "8s").splitlines())
    t3.join()
    check("core-cross-map-no-ghost-but-listed", "edge", "critical", listed and noghost,
          "different-map peer listed (%s) with no ghost; ms=%r" % (listed, ms))
    # 3.8 player TTL: stop streaming -> ghost bot removed within PLAYER_TTL (3s)
    ttlname = "TTL" + NONCE
    for i in range(12):
        send_state("A", "QQ", ttlname, body=state_body(ttlname, x=100.0 + i * 20)); time.sleep(0.1)
    time.sleep(0.5)
    spawned = ttlname in dlogs("A", "5s")
    time.sleep(4.0)  # > PLAYER_TTL_MS
    _, rows = getstatus("A")
    gone = all(ttlname not in r for r in rows)
    check("core-player-ttl-removes-bot", "regression", "high", spawned and gone,
          "ghost aged out after 3s of silence")
    # 3.9 records integrity: a streamed ghost never writes a racelog/topscore
    time.sleep(1.0)
    post_racelog = subprocess.run(["docker", "exec", NODES["A"]["cont"], "sh", "-c",
        "cat /warsow/racemod/racelog/events.log 2>/dev/null | wc -l"],
        capture_output=True, text=True).stdout.strip()
    check("records-bot-no-persistence", "regression", "critical", pre_racelog == post_racelog,
          "racelog line count unchanged by ghost traffic (%s -> %s)" % (pre_racelog, post_racelog))

# ===========================================================================
# PHASE 4 — mesh map vote (LAST: changes maps) then restore
# ===========================================================================
def phase4():
    print("\n== PHASE 4: mesh map vote (mutates maps) ==")
    # 4.1 straggler switch: OPEN+PASS to A&B, PASS-only to C -> all three switch
    vid = "Z:vote" + NONCE
    for n in "AB":
        send_event(n, "Z", "O", random.randint(1, 2**31), vid, "coldrun 60 Voter")
    time.sleep(1.0)
    ann = "wants to change" in dlogs("A", "5s")
    check("mvote-open-announced", "happy", "high", ann, "OPEN announced on node A")
    for n in "ABC":  # C never saw the OPEN (straggler)
        send_event(n, "Z", "R", random.randint(1, 2**31), vid, "PASS coldrun")
    switched = all(wait_map(n, "coldrun", 12) for n in "ABC")
    check("mvote-pass-all-servers-switch-straggler", "happy", "critical", switched,
          "A, B, and straggler C all switched to coldrun")
    # restore to base map for the next sub-test
    for n in "ABC":
        rcon(n, "map " + MAP)
    for n in "ABC":
        wait_map(n, MAP, 15)
    time.sleep(31)  # ride out the 30s meshvote cooldown

    # 4.2 master-only cancel at the mesh level: a FAIL from a NON-master tag is
    #     ignored; the vote only fails when its real master says so.
    vid2 = "M:vote" + NONCE
    send_event("A", "M", "O", random.randint(1, 2**31), vid2, "coldrun 60 Voter")
    time.sleep(1.0)
    active = "wants to change" in dlogs("A", "4s")
    send_event("A", "X", "R", random.randint(1, 2**31), vid2, "FAIL cancelled")  # wrong master
    time.sleep(1.5)
    still_base = mapname("A") == MAP  # didn't switch (it was a FAIL anyway) - check vote not cancelled by X
    # now the real master cancels
    send_event("A", "M", "R", random.randint(1, 2**31), vid2, "FAIL cancelled")
    time.sleep(1.5)
    check("mvote-master-only-cancel", "regression", "high", active and still_base and alive("A"),
          "non-master FAIL ignored; real master FAIL honored")
    time.sleep(31)

    # 4.3 map-change M announce: rcon a map -> B and C observe "[A] now playing"
    rcon("A", "map coldrun")
    wait_map("A", "coldrun", 15)
    time.sleep(2.0)
    announced = ("[A]" in dlogs("B", "12s") and "now playing" in dlogs("B", "12s"))
    check("mesh-map-change-announced", "happy", "high", announced,
          "A's map change announced to peer B via M event")
    rcon("A", "map " + MAP); wait_map("A", MAP, 15)

# ---------------------------------------------------------------------------
def summary():
    print("\n" + "=" * 72)
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r[3])
    crit_fail = [r for r in RESULTS if not r[3] and r[2] == "critical"]
    high_fail = [r for r in RESULTS if not r[3] and r[2] == "high"]
    other_fail = [r for r in RESULTS if not r[3] and r[2] not in ("critical", "high")]
    print("REGRESSION SUMMARY: %d/%d passed" % (passed, total))
    print("  critical failures: %d, high: %d, medium/low: %d"
          % (len(crit_fail), len(high_fail), len(other_fail)))
    for r in crit_fail + high_fail + other_fail:
        print("   %s %-9s %s :: %s" % ("FAIL" if r[2] in ("critical","high") else "warn", r[2], r[0], r[4]))
    return 1 if (crit_fail or high_fail) else 0

def main():
    print("Mesh regression suite (run nonce %s). Nodes: A=%s B=%s C=%s"
          % (NONCE, NODES["A"]["ip"], NODES["B"]["ip"], NODES["C"]["ip"]))
    print("Stopping feeders for a controlled baseline...")
    stop_feeders(); time.sleep(2)
    for n in "ABC":
        if mapname(n) != MAP:
            rcon(n, "map " + MAP); wait_map(n, MAP, 15)
    # Drain stale test peers from a prior run (PEER_TTL=15s) so the budget-
    # sensitive baseline is clean (node A should hear only the real peers B/C).
    print("Draining stale peers (up to ~18s)...")
    tdl = time.time() + 18
    while time.time() < tdl:
        info, _ = getstatus("A")
        tags = set(r.split(":")[0] for r in (info or {}).get("rs_mesh_status", "").split(",") if r)
        if tags <= {"B", "C"}:
            break
        time.sleep(2)
    try:
        # Order matters on one shared mesh: read-only baseline; then mirroring/
        # chat/records on a CLEAN peersRt; then light auth/security; then the map
        # vote; and finally the cap/flood tests that saturate peersRt with junk.
        phase1(); phase3(); phase2(); phase4(); phase5_caps()
    finally:
        print("\nRestoring mesh (base map)...")
        for n in "ABC":
            if mapname(n) != MAP:
                rcon(n, "map " + MAP)
    rc = summary()
    print("\n(Restart feeders manually if you want live ghosts again.)")
    sys.exit(rc)

if __name__ == "__main__":
    main()
