// Live player presence: polls each enrolled game server's public query
// address with a Warsow (qfusion / Quake3-style) connectionless "getstatus"
// UDP packet and caches who is online.
//
// The cache is what /api/live serves — HTTP requests never trigger UDP
// queries themselves, so the site cannot be used to amplify traffic at the
// game servers, and a burst of viewers costs the game servers nothing.
//
// A server only shows up here after the admin sets its query address:
//   node admin.js address <serverId> <host:port>
// The queried server must run sv_public 1 — with 0 the engine silently
// ignores getstatus from non-LAN sources (the co-located container queries
// arrive from the docker network, which counts as LAN).
import dgram from "node:dgram";
import { simplifyName } from "./db.js";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const GETSTATUS = Buffer.concat([OOB, Buffer.from("getstatus\n")]);

export const DEFAULT_PORT = 44400;
const QUERY_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 10_000;
const MAX_NAME = 64;
const MAX_PLAYERS = 256;

export function parseAddress(address) {
  if (typeof address !== "string" || !address.trim()) return null;
  const s = address.trim();
  // host[:port]; host may be a DNS name, IPv4, or [IPv6].
  const m = s.match(/^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : DEFAULT_PORT;
  if (port <= 0 || port > 65535) return null;
  return { host: m[1], port };
}

// Parse a statusResponse datagram:
//   \xff\xff\xff\xffstatusResponse\n\key\value\...\n<score> <ping> "name" [team]\n...
export function parseStatusResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || !buf.subarray(0, 4).equals(OOB)) return null;
  const text = buf.subarray(4).toString("latin1");
  const lines = text.split("\n");
  if (!/^statusResponse/.test(lines[0] || "")) return null;

  const info = {};
  const infoLine = lines[1] || "";
  const parts = infoLine.split("\\");
  for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];

  const players = [];
  for (const line of lines.slice(2)) {
    if (!line) continue;
    const m = line.match(/^(-?\d+)\s+(-?\d+)\s+"(.*)"(?:\s+(-?\d+))?\s*$/);
    if (!m) continue;
    players.push({
      score: parseInt(m[1], 10),
      ping: parseInt(m[2], 10),
      name: m[3].slice(0, MAX_NAME),
      team: m[4] != null ? parseInt(m[4], 10) : null,
    });
    if (players.length >= MAX_PLAYERS) break;
  }
  return { info, players };
}

// One getstatus round-trip. Resolves to {info, players} or rejects on
// timeout / socket error / unparseable reply.
export function queryServer(host, port, timeoutMs = QUERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    sock.on("error", (e) => finish(e));
    sock.on("message", (msg) => {
      const parsed = parseStatusResponse(msg);
      if (parsed) finish(null, parsed);
      // else: stray datagram — keep waiting for the real reply until timeout.
    });
    sock.send(GETSTATUS, port, host, (err) => {
      if (err) finish(err);
    });
  });
}

// Parse the game server's rs_mesh_status serverinfo field — a compact list of
// the peer servers it currently hears, "TAG:map:players,TAG:map:players,...".
// (Published by the hrace mirror module; see mirror.as RACE_MirrorPublishStatus.)
// Absent/empty => null (mesh disabled or no peers heard). Defensive: skip
// malformed records so a stray value can never throw.
export function parseMeshStatus(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const peers = [];
  for (const rec of raw.split(",")) {
    const f = rec.split(":");
    if (f.length < 3 || !f[0]) continue;
    const players = parseInt(f[2], 10);
    peers.push({
      tag: f[0].slice(0, 8),
      map: f[1] || null,
      players: Number.isFinite(players) ? players : 0,
    });
    if (peers.length >= 16) break;
  }
  return peers.length ? peers : null;
}

// Shape one server's poll result for the API/frontend.
function presentResult(server, result) {
  const base = {
    id: server.id,
    name: server.name,
    address: server.address,
    online: false,
    players: [],
  };
  if (!result) return base;
  const { info, players } = result;
  return {
    ...base,
    online: true,
    hostname: info.sv_hostname || null,
    map: info.mapname || null,
    gametype: info.gametype || info.g_gametype || null,
    maxclients: info.sv_maxclients ? parseInt(info.sv_maxclients, 10) : null,
    mesh: parseMeshStatus(info.rs_mesh_status),
    players: players.map((p) => ({
      name: p.name,
      simplified: simplifyName(p.name),
      ping: p.ping,
      score: p.score,
    })),
  };
}

// Background poller over the DB's enrolled servers. Keeps an in-memory
// snapshot; getLive() is synchronous and cheap. The interval is unref()ed so
// importing this module never keeps a test or CLI process alive.
export function createLivePoller(race, { intervalMs = POLL_INTERVAL_MS, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  let snapshot = { updatedAt: null, servers: [] };
  let timer = null;
  let polling = false;

  async function poll() {
    if (polling) return snapshot; // a slow round must not stack another
    polling = true;
    try {
      const targets = (await race.servers()).filter(
        (s) => s.status !== "revoked" && s.address && parseAddress(s.address)
      );
      const results = await Promise.all(
        targets.map(async (s) => {
          const { host, port } = parseAddress(s.address);
          try {
            return presentResult(s, await queryServer(host, port, timeoutMs));
          } catch {
            return presentResult(s, null); // offline / unreachable
          }
        })
      );
      snapshot = { updatedAt: Math.floor(Date.now() / 1000), servers: results };
    } finally {
      polling = false;
    }
    return snapshot;
  }

  return {
    start() {
      if (timer) return;
      poll().catch(() => {});
      timer = setInterval(() => poll().catch(() => {}), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    poll, // exposed for tests / forced refresh
    getLive: () => snapshot,
  };
}
