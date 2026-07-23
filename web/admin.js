// Racesow admin CLI — enroll / list / revoke game servers for record ingest.
//
//   node admin.js enroll "My Race Server"     # prints a one-time token
//   node admin.js list                        # show enrolled servers + health
//   node admin.js address <id> <host:port|->  # set/clear the Live query address
//   node admin.js rcon <id> <password|->      # set/clear the RCON password (broadcasts, maintenance, console)
//   node admin.js broadcast "message"         # RCON-say a one-off message to all servers
//   node admin.js maintenance <on|off> [msg]  # toggle maintenance mode + notify players (web re-broadcasts)
//   node admin.js logs [serverId|all] [n]     # tail the operator log stream
//   node admin.js revoke <id>                 # stop accepting a server's records
//   node admin.js trust  <id>                 # re-enable a revoked/quarantined server
//   node admin.js delete-map <id>             # remove a map (and its races) + rerank
//   node admin.js rebuild-canonical           # recompute player identity groups
//
//   # Accounts for the /admin area (unlinked from the site). Two tiers:
//   #   admin     = full access;  moderator = map blocking, flags, restart only.
//   node admin.js admin-add <user> [pw] [--role admin|moderator]  # create (default admin; random pw printed if omitted)
//   node admin.js admin-list                  # list accounts + tier + last login
//   node admin.js admin-role <user> <admin|moderator>  # change an account's tier
//   node admin.js admin-passwd <user> [pw]    # reset a password (revokes sessions)
//   node admin.js admin-remove <username>     # delete an account (revokes sessions)
//
//   # Map review flags:
//   node admin.js flags [open|all|resolved|dismissed]   # list flags (default open)
//   node admin.js resolve <flagId>            # close one flag
//   node admin.js dismiss <flagId>            # dismiss one flag
//   node admin.js resolve-map <mapId>         # close ALL open flags on a map
//   node admin.js dismiss-map <mapId>         # dismiss ALL open flags on a map
//   node admin.js block-map <mapId> [reason]  # pull a map from the vote pool + cycle
//   node admin.js unblock-map <mapId>         # return a map to rotation
//   node admin.js blocked                     # list blocked maps
//
// Ingest tokens and admin passwords are stored only hashed; plaintext is shown
// once at creation. Give a server token to the operator (INGEST_TOKEN); give an
// admin password to the moderator (they can change it at /admin/account).
import crypto from "node:crypto";
import { openDatabase, rebuildCanonical, hashPassword } from "./db.js";
import { broadcastRcon, sayCommand } from "./rcon.js";
import { parseAddress } from "./live.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";

function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "never";
}

// Pull a "--role <val>" / "--role=<val>" flag out of an arg list, returning the
// role (or null) and the remaining positional args. Lets admin-add take the tier
// without disturbing the existing <username> [password] positions.
function extractRoleFlag(argv) {
  const rest = [];
  let role = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") role = (argv[++i] || "").trim();
    else if (a.startsWith("--role=")) role = a.slice("--role=".length).trim();
    else rest.push(a);
  }
  return { role, rest };
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
    case "rcon": {
      // Set/clear the per-server RCON password the web app uses to send
      // connectionless `rcon` UDP (broadcasts, maintenance notices, the console).
      // Stored plaintext (the protocol is cleartext); only ever read by the admin
      // routes / this CLI, never by servers() or a public API.
      const id = parseInt(args[0], 10);
      const pw = (args[1] || "").trim();
      if (Number.isNaN(id) || !pw) throw new Error("usage: node admin.js rcon <serverId> <password | ->");
      const set = await race.setServerRcon(id, pw === "-" ? null : pw);
      console.log(set ? `Server #${id} rcon password ${pw === "-" ? "cleared" : "set"}.` : `No server #${id}`);
      break;
    }
    case "broadcast": {
      const msg = args.join(" ").trim();
      if (!msg) throw new Error('usage: node admin.js broadcast "message"');
      const targets = await race.rconTargets();
      if (!targets.length) {
        console.log("No RCON-enabled servers. Set: node admin.js address <id> <host:port> && node admin.js rcon <id> <pw>");
        break;
      }
      const results = await broadcastRcon(targets, sayCommand(msg), { parseAddress });
      for (const r of results) {
        console.log(`  ${r.name}: ${r.ok ? "sent" : "FAILED (" + (r.error || (r.authFailed ? "bad rcon password" : "no reply")) + ")"}`);
      }
      console.log(`Broadcast to ${results.filter((r) => r.ok).length}/${targets.length} server(s).`);
      break;
    }
    case "maintenance": {
      const action = (args[0] || "").toLowerCase();
      if (action !== "on" && action !== "off") throw new Error("usage: node admin.js maintenance <on|off> [message]");
      const now = Math.floor(Date.now() / 1000);
      const targets = await race.rconTargets();
      if (action === "on") {
        const msg =
          args.slice(1).join(" ").trim() ||
          "^3Scheduled maintenance in progress^7 — the server may restart shortly. Thanks for your patience!";
        await race.setConfig("maintenance_active", "1");
        await race.setConfig("maintenance_since", String(now));
        await race.setConfig("maintenance_message", msg);
        await race.setConfig("maintenance_by", "cli");
        await race.setConfig("maintenance_rebroadcast_at", String(now + 180));
        const results = await broadcastRcon(targets, sayCommand(msg), { parseAddress });
        console.log(
          `Maintenance ON — notified ${results.filter((r) => r.ok).length}/${targets.length} server(s). The web app re-broadcasts on a timer.`
        );
      } else {
        for (const k of ["maintenance_active", "maintenance_since", "maintenance_message", "maintenance_by", "maintenance_rebroadcast_at"]) {
          await race.setConfig(k, k === "maintenance_active" ? "0" : null);
        }
        const results = await broadcastRcon(targets, sayCommand("^2Maintenance complete^7 — racing is back to normal."), { parseAddress });
        console.log(`Maintenance OFF — notified ${results.filter((r) => r.ok).length}/${targets.length} server(s).`);
      }
      break;
    }
    case "logs": {
      const sid = args[0] && args[0] !== "all" ? parseInt(args[0], 10) : null;
      const n = parseInt(args[1], 10) || 100;
      const rows = await race.recentServerLogs({ serverId: Number.isNaN(sid) ? null : sid, limit: n });
      if (!rows.length) {
        console.log("No log lines.");
        break;
      }
      // recentServerLogs is newest-first; print oldest-first like a tail.
      for (const r of rows.reverse()) {
        console.log(`${fmtTime(r.createdAt)} [${r.source}]${r.serverName ? " " + r.serverName : ""}  ${r.line}`);
      }
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

    // --- Moderator accounts ---
    case "admin-add":
    case "admin-passwd": {
      const { role: roleFlag, rest } = extractRoleFlag(args);
      const username = (rest[0] || "").trim();
      if (!username)
        throw new Error(
          `usage: node admin.js ${cmd} <username> [password]${cmd === "admin-add" ? " [--role admin|moderator]" : ""}`
        );
      let password = rest[1];
      let generated = false;
      if (!password) {
        password = crypto.randomBytes(12).toString("base64url"); // ~16 chars, URL-safe
        generated = true;
      }
      if (password.length < 10) throw new Error("password must be at least 10 characters");
      const hash = hashPassword(password);
      if (cmd === "admin-add") {
        const role = roleFlag || "admin";
        if (role !== "admin" && role !== "moderator")
          throw new Error("role must be 'admin' or 'moderator'");
        const created = await race.createAdmin(username, hash, role);
        if (!created)
          throw new Error(`admin "${username}" already exists — use admin-passwd to reset it, or admin-role to change tier`);
        console.log(`Created ${role} #${created.id}: ${username}`);
      } else {
        if (roleFlag)
          throw new Error("admin-passwd does not take --role; change tiers with: node admin.js admin-role <username> <admin|moderator>");
        const n = await race.setAdminPassword(username, hash);
        if (!n) throw new Error(`no admin "${username}"`);
        // A password reset revokes every existing session for that admin.
        await race.pool.query(
          "DELETE FROM admin_session s USING admin_user a WHERE s.admin_id = a.id AND a.username = $1",
          [username]
        );
        console.log(`Password reset for "${username}" (existing sessions revoked).`);
      }
      if (generated) {
        console.log(`\n  password: ${password}\n`);
        console.log("Shown once (only its hash is stored). The user can change it at /admin/account.");
      }
      break;
    }
    case "admin-list": {
      const rows = await race.listAdmins();
      if (!rows.length) {
        console.log("No admins. Create one: node admin.js admin-add <username>");
        break;
      }
      console.log("id   username                      tier       created              last login");
      for (const a of rows) {
        console.log(
          `${String(a.id).padEnd(4)} ${a.username.padEnd(29)} ${String(a.role || "admin").padEnd(10)} ${fmtTime(a.created_at).padEnd(20)} ${fmtTime(a.last_login_at)}`
        );
      }
      break;
    }
    case "admin-role": {
      const username = (args[0] || "").trim();
      const role = (args[1] || "").trim();
      if (!username || (role !== "admin" && role !== "moderator"))
        throw new Error("usage: node admin.js admin-role <username> <admin|moderator>");
      const n = await race.setAdminRole(username, role);
      console.log(n ? `"${username}" now has the ${role} tier.` : `No admin "${username}".`);
      break;
    }
    case "admin-remove": {
      const username = (args[0] || "").trim();
      if (!username) throw new Error("usage: node admin.js admin-remove <username>");
      const n = await race.removeAdmin(username);
      console.log(n ? `Removed admin "${username}" (sessions revoked).` : `No admin "${username}".`);
      break;
    }

    // --- Map review flags ---
    case "flags": {
      const status = (args[0] || "open").toLowerCase();
      if (status === "open") {
        const groups = await race.openFlagSummary();
        if (!groups.length) {
          console.log("No open flags.");
          break;
        }
        for (const g of groups) {
          const reasons = Object.entries(g.reasons)
            .map(([r, c]) => `${r}×${c}`)
            .join(", ");
          console.log(`map #${g.mapId}  ${g.name}`);
          console.log(`   ${g.openCount} open (${reasons}) · last ${fmtTime(g.lastAt)}`);
          if (g.latestNote) console.log(`   note: ${g.latestNote}`);
        }
        console.log(`\nClose with: node admin.js resolve <flagId> | resolve-map <mapId>`);
      } else {
        const rows = await race.listFlags({ status, limit: 500 });
        if (!rows.length) {
          console.log(`No ${status} flags.`);
          break;
        }
        console.log("id    map                    reason       status      note");
        for (const f of rows) {
          console.log(
            `${String(f.id).padEnd(5)} ${String(f.name).slice(0, 22).padEnd(22)} ${f.reason.padEnd(12)} ${f.status.padEnd(11)} ${f.note ? f.note.slice(0, 40) : ""}`
          );
        }
      }
      break;
    }
    case "resolve":
    case "dismiss": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error(`usage: node admin.js ${cmd} <flagId>`);
      const status = cmd === "resolve" ? "resolved" : "dismissed";
      const n = await race.setFlagStatus(id, status, "cli");
      console.log(n ? `Flag #${id} -> ${status}` : `No open flag #${id}.`);
      break;
    }
    case "resolve-map":
    case "dismiss-map": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error(`usage: node admin.js ${cmd} <mapId>`);
      const status = cmd === "resolve-map" ? "resolved" : "dismissed";
      const n = await race.resolveMapFlags(id, status, "cli");
      console.log(`${status === "resolved" ? "Resolved" : "Dismissed"} ${n} open flag(s) on map #${id}.`);
      break;
    }
    case "block-map": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error("usage: node admin.js block-map <mapId> [reason]");
      const reason = args.slice(1).join(" ").trim() || null;
      const r = await race.blockMap(id, reason, "cli");
      if (!r.ok) throw new Error(`no map #${id}`);
      console.log(`Blocked map #${id} (closed ${r.resolvedFlags} open flag(s)). Drops from rotation on the game servers' next restart.`);
      break;
    }
    case "unblock-map": {
      const id = parseInt(args[0], 10);
      if (Number.isNaN(id)) throw new Error("usage: node admin.js unblock-map <mapId>");
      const n = await race.unblockMap(id);
      console.log(n ? `Unblocked map #${id}. Returns to rotation on the next restart.` : `Map #${id} was not blocked.`);
      break;
    }
    case "blocked": {
      const rows = await race.blockedMaps();
      if (!rows.length) {
        console.log("No blocked maps.");
        break;
      }
      console.log("mapId  name                       blocked              by");
      for (const m of rows) {
        console.log(
          `${String(m.map_id).padEnd(6)} ${String(m.name).slice(0, 26).padEnd(26)} ${fmtTime(m.blocked_at).padEnd(20)} ${m.blocked_by || ""}`
        );
      }
      break;
    }

    default:
      console.log(
        "commands:\n" +
          "  enroll <name> | list | address <id> <host:port|-> | revoke <id> | trust <id>\n" +
          "  rcon <id> <password|-> | broadcast \"msg\" | maintenance <on|off> [msg] | logs [serverId|all] [n]\n" +
          "  delete-map <id> | rebuild-canonical\n" +
          "  admin-add <user> [pw] | admin-list | admin-passwd <user> [pw] | admin-remove <user>\n" +
          "  flags [open|all|resolved|dismissed] | resolve <flagId> | dismiss <flagId>\n" +
          "  resolve-map <mapId> | dismiss-map <mapId>\n" +
          "  block-map <mapId> [reason] | unblock-map <mapId> | blocked"
      );
  }
} finally {
  await race.close();
}
