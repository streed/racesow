#!/usr/bin/env python3
"""UDP fuzzer for the mesh receive/parse path (drives mirror_fuzz_target).

Sends a large mix of malformed, boundary, and structured-but-hostile datagrams
to 127.0.0.1:<port> from a 127.0.0.1 source (so the target's source-IP
allowlist accepts them and they reach the full parser under ASan/UBSan).

Categories, weighted toward the parser's sharp edges:
  - random bytes at boundary lengths (0,1,5,6,7,8,1400,1401,2048)
  - "RSM1 " prefix + garbage / truncated headers / no-space / no-newline
  - valid-shaped headers with pathological ts/seq/tag/map (huge numbers,
    over-long %s tokens, embedded NUL/tab/CR, missing fields)
  - hostile S bodies: "P" alone, "P " , short field counts, nan/inf/huge
    floats, giant names, %n-boundary rows, thousands of rows
  - hostile E bodies: kind/eseq edge cases, missing tabs, empty fields,
    huge eseq, many events (dedup-window stress), leave-storms
  - cap-stress: many distinct tags, many distinct player names per tag

Usage: mirror_fuzz.py <port> [iterations]
"""
import os
import random
import socket
import sys
import time

PRINTABLE = bytes(range(0x20, 0x7f))


def now_ts():
    # Most packets use a near-current timestamp so they pass the +-60s skew
    # gate and actually reach the body parser; a minority use a hostile ts to
    # still exercise the skew-reject path.
    if random.random() < 0.85:
        return str(int(time.time()) + random.randint(-40, 40)).encode()
    return _num()


def rnd_bytes(n):
    return bytes(random.getrandbits(8) for _ in range(n))


def rnd_token(maxlen=80, charset=PRINTABLE):
    return bytes(random.choice(charset) for _ in range(random.randint(0, maxlen)))


def gen_random():
    for n in (0, 1, 4, 5, 6, 7, 8, 9, 40, 1399, 1400, 1401, 2000, 2048):
        if random.random() < 0.5:
            return rnd_bytes(n)
    return rnd_bytes(random.randint(0, 1500))


def gen_prefix_garbage():
    tail = rnd_bytes(random.randint(0, 1400))
    sep = random.choice([b"RSM1 ", b"RSM1", b"RSM1  ", b"rsm1 ", b"RSM1 " + b"a" * random.randint(0, 40)])
    return sep + tail


def _mac_field():
    # the receiver only length-checks the mac in secret mode; in no-secret mode
    # it is ignored, but its bytes still drive the memchr/canonLen arithmetic.
    return random.choice([b"-", b"-" * random.randint(0, 40), rnd_token(40), b"", b" ", rnd_bytes(32)])


def _num():
    return random.choice([
        b"0", b"-1", b"1", str(random.randint(-(2**63), 2**63)).encode(),
        b"9" * random.randint(1, 40), b"99999999999999999999999999999",
        b"", b"+", b"-", b"nan", b"inf", b"0x10", str(random.getrandbits(64)).encode(),
    ])


def _token(maxlen=80):
    return random.choice([
        rnd_token(maxlen),
        b"A" * random.randint(0, maxlen),        # over-long tag/map (%16s/%64s)
        b"", b" ", b"\t", b"\x1f", b"map;quit",
        rnd_token(maxlen, PRINTABLE + b"\x00\t\r\x1f"),
    ])


def _float():
    return random.choice([
        b"0", b"0.0", b"nan", b"inf", b"-inf", b"3e38", b"3.5e38", b"1e400",
        b"-1e400", str(random.uniform(-1e9, 1e9)).encode(), b"", b".", b"e",
        b"9" * random.randint(1, 30), rnd_token(12, b"0123456789.eE+-"),
    ])


def gen_state_body(rows=None):
    if rows is None:
        rows = random.choice([0, 1, 2, 5, 33, 50, 200])
    out = []
    for _ in range(rows):
        shape = random.random()
        if shape < 0.15:
            out.append(b"P")
        elif shape < 0.3:
            out.append(b"P ")
        elif shape < 0.45:
            out.append(b"P " + b" ".join(_num() for _ in range(random.randint(0, 9))))
        else:
            fields = [_num()] + [_float() for _ in range(9)]
            name = random.choice([_token(120), b"", b" " * 40, rnd_bytes(120)])
            out.append(b"P " + b" ".join(fields) + b" " + name)
    return b"\n".join(out)


def gen_event_body(events=None):
    if events is None:
        events = random.choice([0, 1, 2, 10, 200])
    out = []
    for _ in range(events):
        kind = random.choice([b"C", b"J", b"L", b"X", b"", b" ", rnd_bytes(1)])
        eseq = _num()
        name = random.choice([_token(80), b"", b"\t", rnd_bytes(40)])
        text = random.choice([_token(300), b"", b"a" * 400, rnd_bytes(300)])
        sep = random.choice([b"\t", b"", b" "])
        out.append(kind + b" " + eseq + sep + name + b"\t" + text)
    return b"\n".join(out)


def gen_structured(tag=None, mapn=None):
    # weight S and E heavily (with a valid-ish tag much of the time) so both
    # body parsers are actually reached with accepted packets, not just rejects
    typ = random.choice([b"S", b"S", b"E", b"E", b"X", b"", rnd_bytes(1)])
    if tag is None:
        tag = random.choice([("P%d" % random.randint(0, 20)).encode(), _token(30)])
    mapn = mapn if mapn is not None else random.choice([b"fuzzmap", _token(90)])
    header = b" ".join([now_ts(), _num(), typ, tag, mapn])
    body = gen_state_body() if typ == b"S" else gen_event_body()
    dg = b"RSM1 " + _mac_field() + b" " + header
    if random.random() < 0.85:
        dg += b"\n" + body
    if random.random() < 0.1:
        dg = dg.replace(b"\n", b"", random.randint(0, 3))  # strip some newlines
    return dg


def gen_valid_event(i):
    # a well-formed E datagram whose body IS a valid event line, so
    # processEventLine reaches push_back and the consumer sees it — proves the
    # event body parser runs on accepted input (fields still lightly fuzzed).
    tag = ("E%d" % (i % 8)).encode()
    kind = random.choice([b"C", b"J", b"L"])
    eseq = i  # monotonic-ish so the dedup window doesn't swallow everything
    name = random.choice([b"racer", ("guy_%d" % (i % 50)).encode(), rnd_token(20)])
    text = random.choice([b"hi", b"gg", rnd_token(60), b"a" * random.randint(0, 300)])
    ts = int(time.time()) + random.randint(-30, 30)
    body = b"%s %d\t%s\t%s" % (kind, eseq, name, text)
    return b"RSM1 - %d %d E %s fuzzmap\n%s" % (ts, i, tag, body)


def gen_cap_stress(i):
    # many distinct tags / names to probe the MAX_TAGS / per-tag caps; a valid
    # near-current ts so these actually populate rows/peersRt (cap exercise)
    tag = ("T%d" % (i % 40)).encode()
    mapn = random.choice([b"fuzzmap", ("m%d" % (i % 3)).encode()])  # also flips maps
    name = ("player_%d" % (i % 200)).encode()
    body = b"P 1 0 0 0 0 0 0 0 0 0 " + name
    ts = int(time.time()) + random.randint(-30, 30)
    return b"RSM1 - %d %d S %s %s\n%s" % (ts, i, tag, mapn, body)


GENERATORS = [gen_random, gen_prefix_garbage, gen_structured, gen_structured,
              gen_structured, lambda: gen_cap_stress(random.randint(0, 10**6)),
              lambda: gen_valid_event(random.randint(0, 10**6))]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    port = int(sys.argv[1])
    iterations = int(sys.argv[2]) if len(sys.argv) > 2 else 200000
    random.seed(int.from_bytes(os.urandom(4), "little"))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))  # source is 127.0.0.1 => passes the allowlist
    sent = 0
    for i in range(iterations):
        dg = random.choice(GENERATORS)()
        if len(dg) > 65000:
            dg = dg[:65000]
        try:
            sock.sendto(dg, ("127.0.0.1", port))
            sent += 1
        except OSError:
            pass
        if i % 20000 == 0 and i:
            # let the single-threaded worker drain its socket buffer
            import time
            time.sleep(0.05)
    print("fuzz: sent %d datagrams" % sent)
    return 0


if __name__ == "__main__":
    sys.exit(main())
