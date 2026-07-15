// Racesow admin CLI — enroll / list / revoke game servers for record ingest.
//
//   node admin.js enroll "My Race Server"     # prints a one-time token
//   node admin.js list                        # show enrolled servers + health
//   node admin.js revoke <id>                 # stop accepting a server's records
//   node admin.js trust  <id>                 # re-enable a revoked/quarantined server
//   node admin.js delete-map <id>             # remove a map (and its races) + rerank
//
// Tokens are stored only as a SHA-256 hash; the plaintext is shown once at
// enrollment. Give it to the server operator to set as INGEST_TOKEN.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.sqlite");

function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "never";
}

const [cmd, ...args] = process.argv.slice(2);
const race = openDatabase(DB_PATH);
const db = race.db;

try {
  switch (cmd) {
    case "enroll": {
      const name = args.join(" ").trim();
      if (!name) throw new Error('usage: node admin.js enroll "Server Name"');
      const token = crypto.randomBytes(32).toString("hex");
      const { id } = race.enrollServer(name, token);
      console.log(`Enrolled server #${id}: ${name}`);
      console.log(`\n  INGEST_TOKEN=${token}\n`);
      console.log("Give this token to the operator (shown once; only its hash is stored).");
      break;
    }
    case "list": {
      const rows = race.servers();
      if (!rows.length) {
        console.log("No servers enrolled.");
        break;
      }
      console.log("id  status      records   last seen              address                name");
      for (const s of rows) {
        console.log(
          `${String(s.id).padEnd(3)} ${s.status.padEnd(11)} ${String(s.records).padEnd(9)} ${fmtTime(s.last_seen_at).padEnd(22)} ${String(s.address || "—").padEnd(22)} ${s.name}`
        );
      }
      break;
    }
    case "address": {
      // Query address for the Live page (UDP getstatus). "-" clears it.
      // The game server must run sv_public 1, or it ignores non-LAN queries.
      const id = parseInt(args[0], 10);
      const addr = (args[1] || "").trim();
      if (Number.isNaN(id) || !addr) throw new Error('usage: node admin.js address <serverId> <host:port | ->');
      const ok = race.setServerAddress(id, addr === "-" ? null : addr);
      console.log(ok ? `Server #${id} address -> ${addr === "-" ? "(cleared)" : addr}` : `No server #${id}`);
      break;
    }
    case "revoke":
    case "trust": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error(`usage: node admin.js ${cmd} <serverId>`);
      const status = cmd === "revoke" ? "revoked" : "trusted";
      const info = db.prepare("UPDATE server SET status = ? WHERE id = ?").run(status, id);
      console.log(info.changes ? `Server #${id} -> ${status}` : `No server #${id}`);
      break;
    }
    case "delete-map": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error("usage: node admin.js delete-map <mapId>");
      const del = db.transaction(() => {
        db.prepare("DELETE FROM checkpoint WHERE race_id IN (SELECT id FROM race WHERE map_id = ?)").run(id);
        const r = db.prepare("DELETE FROM race WHERE map_id = ?").run(id);
        db.prepare("DELETE FROM run_tally WHERE map_id = ?").run(id).changes;
        db.prepare("DELETE FROM map WHERE id = ?").run(id);
        return r.changes;
      });
      const races = del();
      race.refreshAggregates();
      console.log(`Deleted map #${id} and ${races} race rows.`);
      break;
    }
    default:
      console.log("commands: enroll <name> | list | address <id> <host:port|-> | revoke <id> | trust <id> | delete-map <id>");
  }
} finally {
  db.close();
}
