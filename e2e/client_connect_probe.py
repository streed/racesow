#!/usr/bin/env python3
"""Prove a real client can CONNECT to the running Warsow race server.

Everything else in e2e/ tests the pieces AROUND the game (the report natives,
the mesh wire protocol, the web API). This one exercises the game server's own
connectionless network protocol from the outside, exactly as the Warsow 2.1.2
client does when a player types `connect <host>`:

  1. getchallenge  ->  server replies "challenge <n>"        (netcode alive)
  2. getinfo <n>   ->  "infoResponse\\<infostring>"           (server browser)
  3. getstatus     ->  "statusResponse\\<serverinfo>\\<rows>"  (server browser)
  4. connect <protocol> <qport> <n> "<userinfo>"
                   ->  "client_connect\\n<session>"           (a client is in)

Reaching `client_connect` is the real "clients can connect" signal: the server
issued a challenge, accepted our protocol version, and allocated a client slot.

The engine is built from DenMSC/racemod_2.1 with PUBLIC_BUILD undefined, so its
APP_PROTOCOL_VERSION is 1001; a PUBLIC_BUILD would be 1. We try both candidates
(and any passed with --protocols) and succeed on whichever the built binary
actually accepts, so the probe stays correct across either build flavour.

Usage:
  python3 client_connect_probe.py <host> <port> [--expect-map NAME]
                                  [--protocols 1001,1] [--timeout 3] [--tries 40]

Exit 0 iff every stage passed; non-zero with a diagnostic otherwise.
"""
import argparse
import socket
import sys
import time

OOB = b"\xff\xff\xff\xff"  # Quake/qfusion out-of-band datagram prefix


def send_oob(sock, addr, payload):
    """Send a single connectionless command (payload is the ascii after 0xFFx4)."""
    sock.sendto(OOB + payload, addr)


def recv_oob(sock):
    """Receive one datagram and strip the 0xFF*4 OOB prefix; None on timeout."""
    try:
        data, _ = sock.recvfrom(65536)
    except socket.timeout:
        return None
    if data[:4] == OOB:
        data = data[4:]
    return data


def request(sock, addr, payload, want_prefix, timeout, tries):
    """Send `payload` up to `tries` times until a reply starting with any of
    `want_prefix` (bytes or tuple of bytes) arrives. Returns the reply bytes or
    None. Retrying covers UDP loss and a server still finishing its first frame."""
    prefixes = want_prefix if isinstance(want_prefix, tuple) else (want_prefix,)
    sock.settimeout(timeout)
    for _ in range(tries):
        send_oob(sock, addr, payload)
        reply = recv_oob(sock)
        if reply is None:
            continue
        if any(reply.startswith(p) for p in prefixes):
            return reply
        # A reply we did not expect (e.g. an async "print" while booting) — keep
        # trying; the one we want may be the next datagram.
    return None


def parse_infostring(s):
    """`\\key\\value\\key\\value` -> dict. Leading backslash optional/ignored."""
    parts = s.split("\\")
    if parts and parts[0] == "":
        parts = parts[1:]
    out = {}
    for i in range(0, len(parts) - 1, 2):
        out[parts[i].lower()] = parts[i + 1]
    return out


class Probe:
    def __init__(self, host, port, timeout, tries):
        self.addr = (host, port)
        self.timeout = timeout
        self.tries = tries
        # ONE socket for the whole run: the server binds the challenge it issues
        # to our source ip:port, so `connect` must come from the same socket.
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.failures = []

    def ok(self, name, detail=""):
        print("  [PASS] %-22s %s" % (name, detail))

    def fail(self, name, detail=""):
        print("  [FAIL] %-22s %s" % (name, detail))
        self.failures.append(name)

    # -- stage 1: challenge --------------------------------------------------
    def getchallenge(self):
        reply = request(self.sock, self.addr, b"getchallenge",
                        b"challenge ", self.timeout, self.tries)
        if reply is None:
            self.fail("getchallenge", "no 'challenge' reply from %s:%d" % self.addr)
            return None
        try:
            challenge = int(reply.split()[1])
        except (IndexError, ValueError):
            self.fail("getchallenge", "unparseable reply: %r" % reply[:64])
            return None
        self.ok("getchallenge", "challenge=%d" % challenge)
        return challenge

    # -- stage 2: getinfo (server-browser short form) ------------------------
    def getinfo(self, challenge, expect_map):
        payload = b"getinfo " + str(challenge).encode()
        reply = request(self.sock, self.addr, payload,
                        b"infoResponse", self.timeout, self.tries)
        if reply is None:
            self.fail("getinfo", "no infoResponse")
            return
        text = reply.decode("latin1")
        body = text.split("\n", 1)[1] if "\n" in text else text
        info = parse_infostring(body)
        # the challenge we sent must be echoed back (anti-spoofing in the browser)
        if info.get("challenge") != str(challenge):
            self.fail("getinfo", "challenge not echoed (got %r)" % info.get("challenge"))
            return
        gametype = info.get("gametype", "")
        mapname = info.get("mapname", "")
        if "race" not in gametype.lower():
            self.fail("getinfo", "gametype is %r, expected race/hrace" % gametype)
            return
        if not mapname:
            self.fail("getinfo", "no mapname in infoResponse: %r" % info)
            return
        if expect_map and mapname.lower() != expect_map.lower():
            self.fail("getinfo", "map=%r, expected %r" % (mapname, expect_map))
            return
        self.ok("getinfo", "gametype=%s map=%s maxclients=%s"
                % (gametype, mapname, info.get("sv_maxclients", "?")))

    # -- stage 3: getstatus (full serverinfo + player rows) ------------------
    def getstatus(self):
        reply = request(self.sock, self.addr, b"getstatus",
                        b"statusResponse", self.timeout, self.tries)
        if reply is None:
            self.fail("getstatus", "no statusResponse")
            return
        lines = reply.decode("latin1").split("\n")
        info = parse_infostring(lines[1]) if len(lines) > 1 else {}
        if not info:
            self.fail("getstatus", "empty serverinfo in statusResponse")
            return
        players = [ln for ln in lines[2:] if ln.strip()]
        self.ok("getstatus", "serverinfo keys=%d players=%d" % (len(info), len(players)))

    # -- stage 4: the real connection handshake ------------------------------
    def connect(self, protocols):
        # A minimal but valid userinfo — the server needs at least a name.
        userinfo = "\\name\\ci_connect_probe\\rate\\5000\\port\\0"
        qport = 29200  # any 16-bit; the server records it for the netchan
        last = b""
        for proto in protocols:
            challenge = self.getchallenge_quiet()
            if challenge is None:
                continue
            payload = ('connect %d %d %d "%s"' % (proto, qport, challenge, userinfo)).encode()
            reply = request(self.sock, self.addr, payload,
                            (b"client_connect", b"reject", b"print"),
                            self.timeout, max(self.tries, 8))
            if reply is None:
                last = b"(no reply for protocol %d)" % proto
                continue
            if reply.startswith(b"client_connect"):
                self.ok("connect", "client_connect accepted (protocol %d)" % proto)
                return
            last = reply[:160]
            print("       protocol %d rejected: %r" % (proto, last))
        self.fail("connect", "no protocol reached client_connect; last=%r" % last)

    def getchallenge_quiet(self):
        reply = request(self.sock, self.addr, b"getchallenge",
                        b"challenge ", self.timeout, self.tries)
        if reply is None:
            return None
        try:
            return int(reply.split()[1])
        except (IndexError, ValueError):
            return None

    def run(self, expect_map, protocols):
        print("== client connect probe -> %s:%d ==" % self.addr)
        challenge = self.getchallenge()
        if challenge is None:
            return 1  # nothing answers; the rest can't run
        self.getinfo(challenge, expect_map)
        self.getstatus()
        self.connect(protocols)
        print()
        if self.failures:
            print("CLIENT CONNECT PROBE FAILED: " + ", ".join(self.failures))
            return 1
        print("OK: a client completed the connect handshake with the server")
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("host")
    ap.add_argument("port", type=int)
    ap.add_argument("--expect-map", default=None, help="assert the running map name")
    ap.add_argument("--protocols", default="1001,1",
                    help="comma-separated protocol candidates to try for connect")
    ap.add_argument("--timeout", type=float, default=3.0, help="per-datagram timeout (s)")
    ap.add_argument("--tries", type=int, default=40,
                    help="retries per request (also the boot-settle window)")
    args = ap.parse_args()
    protocols = [int(p) for p in args.protocols.split(",") if p.strip()]
    probe = Probe(args.host, args.port, args.timeout, args.tries)
    sys.exit(probe.run(args.expect_map, protocols))


if __name__ == "__main__":
    main()
