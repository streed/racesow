#!/usr/bin/env python3
"""Headless wire checks for the cross-server mirror mesh (protocol RSM1).

Speaks just enough of the protocol (see server/enginepatches/g_rs_mirror.cpp)
to verify a running server from outside, without game clients:

  listen <port> [seconds]
      Bind <port> on the host and print the header line of every datagram
      received. Point a server at us (e.g. the mirror-test compose:
      MIRROR_PEERS_A="warsow-b:44450 warsow-c:44450 host.docker.internal:45001")
      and real keepalives appear here at ~10Hz: "RSM1 <mac> <ts> <seq> S A <map>".

  send <host:port> <secret> <tag> <map> [player]
      Send one valid state datagram (HMAC'd with <secret>) introducing
      <player> at a fixed position, plus join + chat events. A same-map
      server spawns a ghost and prints the chat/join to its players.

  garbage <host:port>
      Send one unauthenticated datagram. The server must log
      "rs_mirror: dropped N unauthenticated/malformed datagram(s)".

  fakeplayer <targets> <secret> <tag> <map> <name> <cx> <cy> <cz> \
             [seconds] [delay_ms] [jitter_ms] [loss_pct]
      Impersonate mesh peer <tag> and stream a fake racer running circles
      around (<cx> <cy> <cz>) at 60Hz to every comma-separated host:port in
      <targets>, with join/chat on start and leave on exit. Connect a game
      client to a receiving server: the ghost runs laps near that spot,
      shows in /who, and can be followed with /watch. Ctrl-C to stop early.
      delay/jitter/loss simulate a WAN link (e.g. US-East<->EU): try
      45 12 0.5 for ~90ms RTT with jitter and light packet loss.
"""
import hashlib
import heapq
import hmac
import math
import random
import socket
import sys
import threading
import time


class DelayedSender:
    """Simulate a WAN link: send each datagram after delay +/- jitter ms, with
    optional loss %. Jitter can reorder packets (realistic UDP), which also
    exercises the receiver's out-of-order handling. delay=jitter=loss=0 -> send
    immediately (no thread cost on the hot path)."""

    def __init__(self, sock, delay_ms=0.0, jitter_ms=0.0, loss_pct=0.0):
        self.sock = sock
        self.delay = delay_ms / 1000.0
        self.jitter = jitter_ms / 1000.0
        self.loss = loss_pct / 100.0
        self.active = self.delay > 0 or self.jitter > 0 or self.loss > 0
        if not self.active:
            return
        self.heap = []
        self.seq = 0
        self.cv = threading.Condition()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def send(self, pkt, addr):
        if not self.active:
            self.sock.sendto(pkt, addr)
            return
        if self.loss and random.random() < self.loss:
            return  # dropped in transit
        d = self.delay + random.uniform(-self.jitter, self.jitter)
        if d < 0:
            d = 0.0
        with self.cv:
            heapq.heappush(self.heap, (time.time() + d, self.seq, pkt, addr))
            self.seq += 1
            self.cv.notify()

    def _run(self):
        while True:
            with self.cv:
                while not self.heap:
                    self.cv.wait()
                at = self.heap[0][0]
                now = time.time()
                if at > now:
                    self.cv.wait(timeout=at - now)
                    continue
                _, _, pkt, addr = heapq.heappop(self.heap)
            try:
                self.sock.sendto(pkt, addr)
            except OSError:
                pass


def mac_hex(secret, canonical):
    digest = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).digest()
    return digest[:16].hex()


def build(secret, tag, map_name, dgram_type, body, seq):
    canonical = "%d %d %s %s %s\n%s" % (int(time.time()), seq, dgram_type, tag, map_name, body)
    mac = mac_hex(secret, canonical) if secret else "-"
    return ("RSM1 %s %s" % (mac, canonical)).encode()


def cmd_listen(port, seconds):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    sock.settimeout(0.5)
    deadline = time.time() + seconds
    count = 0
    print("listening on udp/%d for %ds..." % (port, seconds))
    while time.time() < deadline:
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            continue
        count += 1
        header = data.split(b"\n", 1)[0].decode(errors="replace")
        print("%3d  %s:%d  %s" % (count, addr[0], addr[1], header))
    print("received %d datagram(s)" % count)
    return 0 if count > 0 else 1


def cmd_send(target, secret, tag, map_name, player):
    host, port = target.rsplit(":", 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    seq = int(time.time()) & 0x7FFFFFFF
    eseq = seq

    events = "J %d\t%s\t\nC %d\t%s\thello from the wire check\n" % (eseq, player, eseq + 1, player)
    sock.sendto(build(secret, tag, map_name, "E", events, seq), (host, int(port)))

    # a few state ticks so the ghost visibly exists before the 3s age-out
    for i in range(30):
        body = "P 1 %.1f %.1f %.1f 0.0 90.0 0.0 400.0 0.0 0.0 %s\n" % (
            100.0 + i * 40.0, 200.0, 64.0, player)
        sock.sendto(build(secret, tag, map_name, "S", body, seq + 1 + i), (host, int(port)))
        time.sleep(0.1)

    sock.sendto(build(secret, tag, map_name, "E",
                      "L %d\t%s\t\n" % (eseq + 2, player), seq + 100), (host, int(port)))
    print("sent join + chat + 30 state ticks + leave for '%s' as [%s] on %s" % (player, tag, map_name))
    return 0


def cmd_fakeplayer(targets, secret, tag, map_name, player, cx, cy, cz, seconds,
                   delay_ms=0.0, jitter_ms=0.0, loss_pct=0.0):
    addrs = []
    for t in targets.replace(",", " ").split():
        host, port = t.rsplit(":", 1)
        addrs.append((host, int(port)))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sender = DelayedSender(sock, delay_ms, jitter_ms, loss_pct)
    seq = int(time.time()) & 0x7FFFFFFF
    eseq = seq

    def blast(dgram_type, body):
        nonlocal seq
        pkt = build(secret, tag, map_name, dgram_type, body, seq)
        seq += 1
        for addr in addrs:
            sender.send(pkt, addr)

    radius, speed = 100.0, 300.0  # ups; yaw/velocity follow the circle so the ghost animates
    omega = speed / radius

    chatter = [
        "go go go", "watch this line", "pb incoming", "so fast", "nice route",
        "walljump ftw", "gg", "who's the fastest?", "on my way", "beat that",
    ]
    events = eseq  # monotonic event-seq counter (join/chat/leave share it)

    def event(line):
        nonlocal events
        events += 1
        blast("E", "%s %d\t%s\n" % (line[0], events, line[1]))

    event(("J", "%s\t" % player))
    event(("C", "%s\tfake racer online, watch me go" % player))
    wan = ("no WAN sim" if not sender.active
           else "WAN: delay=%gms jitter=%gms loss=%g%%" % (delay_ms, jitter_ms, loss_pct))
    print("streaming '%s' as [%s] on %s around (%g %g %g) to %s for %ds @60Hz (%s)"
          % (player, tag, map_name, cx, cy, cz, targets, seconds, wan))
    try:
        start = time.time()
        next_chat = start + 12 + (hash(player) % 8)  # stagger per player
        while time.time() - start < seconds:
            now = time.time()
            th = omega * (now - start)
            x = cx + radius * math.cos(th)
            y = cy + radius * math.sin(th)
            vx = -speed * math.sin(th)
            vy = speed * math.cos(th)
            yaw = math.degrees(math.atan2(vy, vx))
            # a gentle up/down look so the streamed view pitch is visible in POV
            pitch = 12.0 * math.sin(th * 0.5)
            blast("S", "P 1 %.1f %.1f %.1f %.1f %.1f 0.0 %.1f %.1f 0.0 %s\n"
                  % (x, y, cz, pitch, yaw, vx, vy, player))
            if now >= next_chat:
                event(("C", "%s\t%s" % (player, chatter[int(now) % len(chatter)])))
                next_chat = now + 15 + (int(now) % 15)  # every ~15-30s
            time.sleep(1.0 / 60.0)  # 60 Hz
    except KeyboardInterrupt:
        pass
    event(("L", "%s\t" % player))
    print("sent leave, done")
    return 0


def cmd_garbage(target):
    host, port = target.rsplit(":", 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(b"RSM1 deadbeefdeadbeefdeadbeefdeadbeef 0 1 E X mapx\nC 1\tnobody\thi\n",
                (host, int(port)))
    print("sent 1 unauthenticated datagram to %s (expect a drop-counter log line)" % target)
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "listen":
        return cmd_listen(int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 5)
    if cmd == "send":
        return cmd_send(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                        sys.argv[6] if len(sys.argv) > 6 else "WireCheck")
    if cmd == "garbage":
        return cmd_garbage(sys.argv[2])
    if cmd == "fakeplayer":
        a = sys.argv
        return cmd_fakeplayer(a[2], a[3], a[4], a[5], a[6],
                              float(a[7]), float(a[8]), float(a[9]),
                              int(a[10]) if len(a) > 10 else 1800,
                              float(a[11]) if len(a) > 11 else 0.0,   # delay ms
                              float(a[12]) if len(a) > 12 else 0.0,   # jitter ms
                              float(a[13]) if len(a) > 13 else 0.0)   # loss %
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
