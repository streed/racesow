// Tests for the live-presence layer: the getstatus wire parsing, the UDP
// query round-trip, and the poller that turns enrolled servers with a query
// address into the /api/live snapshot — all against a fake in-process game
// server, so no real Warsow binary is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../db.js";
import { parseAddress, parseStatusResponse, queryServer, createLivePoller } from "../live.js";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function freshDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "racelive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openDatabase(path.join(dir, "db.sqlite"));
}

// Minimal qfusion-style game server: answers getstatus with a canned reply.
function fakeGameServer(t, { hostname = "^1Fake^7Srv", map = "coldrun", players = [] } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    t.after(() => { try { sock.close(); } catch { /* closed */ } });
    sock.on("message", (msg, rinfo) => {
      if (!msg.subarray(0, 4).equals(OOB)) return;
      if (!msg.subarray(4).toString().startsWith("getstatus")) return;
      const info = `\\sv_hostname\\${hostname}\\mapname\\${map}\\gametype\\hrace\\fs_game\\racemod\\sv_maxclients\\16`;
      const lines = players.map((p) => `${p.score} ${p.ping} "${p.name}" ${p.team ?? 0}`);
      const body = `statusResponse\n${info}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
      sock.send(Buffer.concat([OOB, Buffer.from(body)]), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve({ port: sock.address().port }));
  });
}

test("parseAddress accepts host, host:port and rejects junk", () => {
  assert.deepEqual(parseAddress("play.example.org:44400"), { host: "play.example.org", port: 44400 });
  assert.deepEqual(parseAddress("10.1.2.3"), { host: "10.1.2.3", port: 44400 });
  assert.equal(parseAddress("host:99999"), null);
  assert.equal(parseAddress(""), null);
  assert.equal(parseAddress(null), null);
});

test("parseStatusResponse extracts serverinfo and player rows", () => {
  const body = 'statusResponse\n\\sv_hostname\\^1EU^7 Race\\mapname\\aurora-speed1\\sv_maxclients\\16\n' +
    '12 48 "^1No^7va" 1\n-9999 999 "spec ^2guy" 0\n';
  const parsed = parseStatusResponse(Buffer.concat([OOB, Buffer.from(body)]));
  assert.equal(parsed.info.sv_hostname, "^1EU^7 Race");
  assert.equal(parsed.info.mapname, "aurora-speed1");
  assert.equal(parsed.players.length, 2);
  assert.deepEqual(parsed.players[0], { score: 12, ping: 48, name: "^1No^7va", team: 1 });
  assert.equal(parsed.players[1].name, "spec ^2guy");
  // Not a statusResponse -> null
  assert.equal(parseStatusResponse(Buffer.concat([OOB, Buffer.from("infoResponse\n\\a\\b")])), null);
  assert.equal(parseStatusResponse(Buffer.from("statusResponse\n")), null); // no OOB header
});

test("queryServer round-trips getstatus against a live socket", async (t) => {
  const { port } = await fakeGameServer(t, {
    map: "pornstar-slopin",
    players: [{ score: 3, ping: 25, name: "^4Wa^5ve" }],
  });
  const r = await queryServer("127.0.0.1", port, 1500);
  assert.equal(r.info.mapname, "pornstar-slopin");
  assert.equal(r.players.length, 1);
  assert.equal(r.players[0].name, "^4Wa^5ve");
});

test("queryServer rejects on timeout for a dead port", async () => {
  // Grab a free port, then close it so nothing answers.
  const dead = await new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await assert.rejects(() => queryServer("127.0.0.1", dead, 250));
});

test("poller snapshots enrolled+addressed servers, marks dead ones offline", async (t) => {
  const race = freshDb(t);
  t.after(() => race.db.close());
  const { port } = await fakeGameServer(t, {
    hostname: "^2Live^7 One",
    map: "coldrun",
    players: [
      { score: 1, ping: 30, name: "^1No^7va" },
      { score: 2, ping: 55, name: "plain" },
    ],
  });

  const a = race.enrollServer("Live One", "tok-a".repeat(8));
  const b = race.enrollServer("Dead One", "tok-b".repeat(8));
  const c = race.enrollServer("No Address", "tok-c".repeat(8));
  race.setServerAddress(a.id, `127.0.0.1:${port}`);
  race.setServerAddress(b.id, "127.0.0.1:1"); // nothing there
  assert.equal(race.servers().find((s) => s.id === a.id).address, `127.0.0.1:${port}`);

  const poller = createLivePoller(race, { timeoutMs: 300 });
  const snap = await poller.poll();

  assert.ok(snap.updatedAt > 0);
  // Only servers WITH an address are polled; "No Address" is absent.
  assert.equal(snap.servers.length, 2);
  assert.equal(snap.servers.find((s) => s.id === c.id), undefined);

  const liveOne = snap.servers.find((s) => s.id === a.id);
  assert.equal(liveOne.online, true);
  assert.equal(liveOne.map, "coldrun");
  assert.equal(liveOne.hostname, "^2Live^7 One");
  assert.equal(liveOne.maxclients, 16);
  assert.equal(liveOne.players.length, 2);
  assert.equal(liveOne.players[0].simplified, "Nova"); // colour codes stripped

  const deadOne = snap.servers.find((s) => s.id === b.id);
  assert.equal(deadOne.online, false);
  assert.deepEqual(deadOne.players, []);
});

test("revoked servers are not polled", async (t) => {
  const race = freshDb(t);
  t.after(() => race.db.close());
  const { port } = await fakeGameServer(t);
  const s = race.enrollServer("Was Ours", "tok-r".repeat(8));
  race.setServerAddress(s.id, `127.0.0.1:${port}`);
  race.db.prepare("UPDATE server SET status='revoked' WHERE id=?").run(s.id);

  const poller = createLivePoller(race, { timeoutMs: 300 });
  const snap = await poller.poll();
  assert.equal(snap.servers.length, 0);
});
