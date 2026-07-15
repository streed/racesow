// Racesow admin CLI — enroll / list / revoke game servers for record ingest.
//
//   node admin.js enroll "My Race Server"     # prints a one-time token
//   node admin.js list                        # show enrolled servers + health
//   node admin.js address <id> <host:port|->  # set/clear the Live query address
//   node admin.js revoke <id>                 # stop accepting a server's records
//   node admin.js trust  <id>                 # re-enable a revoked/quarantined server
//   node admin.js delete-map <id>             # remove a map (and its races) + rerank
//   node admin.js rebuild-canonical           # recompute player identity groups
//
// Tokens are stored only as a SHA-256 hash; the plaintext is shown once at
// enrollment. Give it to the server operator to set as INGEST_TOKEN.
import crypto from "node:crypto";
import { openDatabase, rebuildCanonical } from "./db.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";

function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "never";
}

const [cmd, ...args] = process.argv.slice(2);
const race = await openDatabase(DATABASE_URL);

try {
  switch (cmd) {
    case "enroll": {
      const name = args.join(" ").trim();
      if (!name) throw new Error('usage: node admin.js enroll "Server Name"');
      const token = crypto.randomBytes(32).toString("hex");
      const { id } = await race.enrollServer(name, token);
      console.log(`Enrolled server #${id}: ${name}`);
      console.log(`\n  INGEST_TOKEN=${token}\n`);
      console.log("Give this token to the operator (shown once; only its hash is stored).");
      break;
    }
    case "list": {
      const rows = await race.servers();
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
      const id = parseInt(args[0], 10);
      const addr = (args[1] || "").trim();
      if (Number.isNaN(id) || !addr) throw new Error("usage: node admin.js address <serverId> <host:port | ->");
      const ok = await race.setServerAddress(id, addr === "-" ? null : addr);
      console.log(ok ? `Server #${id} address -> ${addr === "-" ? "(cleared)" : addr}` : `No server #${id}`);
      break;
    }
    case "revoke":
    case "trust": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error(`usage: node admin.js ${cmd} <serverId>`);
      const status = cmd === "revoke" ? "revoked" : "trusted";
      const r = await race.pool.query("UPDATE server SET status = $1 WHERE id = $2", [status, id]);
      console.log(r.rowCount ? `Server #${id} -> ${status}` : `No server #${id}`);
      break;
    }
    case "delete-map": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error("usage: node admin.js delete-map <mapId>");
      const client = await race.pool.connect();
      let races;
      try {
        await client.query("BEGIN");
        // checkpoint rows cascade from race deletes
        races = (await client.query("DELETE FROM race WHERE map_id = $1", [id])).rowCount;
        await client.query("DELETE FROM run_tally WHERE map_id = $1", [id]);
        await client.query("DELETE FROM map WHERE id = $1", [id]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      await race.refreshAggregates();
      console.log(`Deleted map #${id} and ${races} race rows.`);
      break;
    }
    case "rebuild-canonical": {
      await rebuildCanonical(race.pool);
      await race.refreshAggregates();
      console.log("Canonical identity groups rebuilt.");
      break;
    }
    default:
      console.log(
        "commands: enroll <name> | list | address <id> <host:port|-> | revoke <id> | trust <id> | delete-map <id> | rebuild-canonical"
      );
  }
} finally {
  await race.close();
}
