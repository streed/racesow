// Remote console (RCON) over the Warsow (qfusion / Quake3-style) connectionless
// UDP protocol — the same OOB transport live.js uses for `getstatus`, and the
// same one scripts/pre-deploy-notify.sh already uses to `say` a deploy notice.
//
// Wire format (one datagram):   \xff\xff\xff\xff rcon <password> <command>\n
// The server replies (best effort) with one or more print datagrams:
//                               \xff\xff\xff\xff print\n<output>
//
// This module is transport-only: callers resolve a server's host/port/password
// from the DB (server.address + server.rcon_password) and pass them in. It never
// reads the DB and never throws — every path resolves to a result object so a
// broadcast over many servers can report per-server success/failure.
import dgram from "node:dgram";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// A game server never sends a legitimate rcon command longer than this, and the
// whole thing rides in one UDP datagram; cap defensively.
const MAX_COMMAND_LEN = 480;

// The command is interpolated straight into the connectionless line, so strip
// anything that could split the datagram into a second command or smuggle
// control bytes: newlines/returns/NULs and other C0 control chars. Quotes and
// spaces are legal (e.g. `say "hi there"`) and pass through.
export function sanitizeCommand(command) {
  return String(command == null ? "" : command)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, MAX_COMMAND_LEN);
}

// Build a safe `say "<text>"` command from operator free text: drop the
// characters that would break the quoted argument or chain a second command
// (double-quote, backslash, semicolon) and any control bytes, but keep Warsow
// ^colour codes. sanitizeCommand() re-guards the whole line before it is sent.
export function sayCommand(text) {
  const clean = String(text == null ? "" : text)
    .replace(/["\\;]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 300);
  return `say "${clean}"`;
}

function parsePrint(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || !buf.subarray(0, 4).equals(OOB)) return null;
  const text = buf.subarray(4).toString("latin1");
  if (!text.startsWith("print")) return null;
  // "print" is followed by a newline before the payload on qfusion; tolerate a
  // missing/space separator too.
  return text.slice(5).replace(/^[\s]/, "");
}

// One rcon round-trip. Resolves (never rejects) to:
//   { ok, replied, authFailed, reply, error }
// - replied:    a print datagram came back (many commands, e.g. `say`, may not echo)
// - authFailed: the reply was the engine's "Bad rcon_password." refusal
// - ok:         no socket error and not an auth failure (a non-echoing command
//               that simply produced no reply is still considered ok)
// The socket gathers replies for `gatherMs` after the FIRST print (status-style
// output can span multiple datagrams), bounded by `timeoutMs` overall.
export function sendRcon(host, port, password, command, { timeoutMs = 3000, gatherMs = 500 } = {}) {
  const cmd = sanitizeCommand(command);
  return new Promise((resolve) => {
    if (!cmd) return resolve({ ok: false, replied: false, authFailed: false, reply: "", error: "empty command" });
    if (!password) return resolve({ ok: false, replied: false, authFailed: false, reply: "", error: "no rcon password" });

    const sock = dgram.createSocket("udp4");
    let done = false;
    let reply = "";
    let replied = false;
    let gatherTimer = null;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(gatherTimer);
      try { sock.close(); } catch { /* already closed */ }
      const authFailed = /bad rcon_?password/i.test(reply);
      resolve({ ok: !error && !authFailed, replied, authFailed, reply: reply.replace(/\s+$/, ""), error: error || null });
    };
    // No reply within the window is NOT a hard error: many commands (say,
    // set, map) don't echo, and UDP gives no delivery signal — so a silent
    // server resolves ok with replied=false. Only a socket/send error or an
    // auth refusal makes ok=false.
    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on("error", (e) => finish(e.message || "socket error"));
    sock.on("message", (msg) => {
      const printed = parsePrint(msg);
      if (printed == null) return; // stray datagram
      reply += printed;
      if (!replied) {
        replied = true;
        // Got the first line of output; wait a short window for the rest, then
        // resolve early rather than sitting out the full timeout.
        gatherTimer = setTimeout(() => finish(null), gatherMs);
      }
    });

    const packet = Buffer.concat([OOB, Buffer.from(`rcon ${password} ${cmd}\n`, "latin1")]);
    sock.send(packet, port, host, (err) => {
      if (err) finish(err.message || "send failed");
    });
  });
}

// Fan a single command out to many servers concurrently. `targets` is a list of
// { id, name, address, password }; addr is split with the provided parser
// (live.js parseAddress) so host[:port] and [IPv6] forms both work. Returns a
// per-target result array (order preserved) — never throws.
export async function broadcastRcon(targets, command, { parseAddress, timeoutMs = 3000, gatherMs = 400 } = {}) {
  return Promise.all(
    (targets || []).map(async (t) => {
      const parsed = parseAddress ? parseAddress(t.address) : null;
      if (!parsed) return { id: t.id, name: t.name, ok: false, error: "bad address", reply: "" };
      const r = await sendRcon(parsed.host, parsed.port, t.password, command, { timeoutMs, gatherMs });
      return { id: t.id, name: t.name, ...r };
    })
  );
}
