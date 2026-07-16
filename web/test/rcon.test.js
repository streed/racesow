// Unit tests for the RCON transport (web/rcon.js). No real game server is
// contacted — an in-process UDP socket stands in for one, exactly as
// live.test.js does for getstatus. Covers the print-reply parse, the
// bad-password path, the no-reply-is-not-a-failure semantics, command/say
// sanitization, and the broadcast fan-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { sendRcon, broadcastRcon, sanitizeCommand, sayCommand } from "../rcon.js";
import { parseAddress } from "../live.js";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// A fake rcon server: replies to `rcon <pass> <cmd>` with a print datagram —
// the command output when the password matches, or the engine's refusal when
// it doesn't. reply() lets a test shape the echoed output.
function fakeRconServer(t, { password = "secret", reply = (cmd) => `ran: ${cmd}` } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    t.after(() => {
      try { sock.close(); } catch { /* already closed */ }
    });
    sock.on("message", (msg, rinfo) => {
      if (!msg.subarray(0, 4).equals(OOB)) return;
      const m = msg.subarray(4).toString("latin1").match(/^rcon (\S+) ([\s\S]*)$/);
      if (!m) return;
      const cmd = m[2].replace(/\n$/, "");
      const body = m[1] === password ? "print\n" + reply(cmd) : "print\nBad rcon_password.\n";
      sock.send(Buffer.concat([OOB, Buffer.from(body, "latin1")]), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve({ port: sock.address().port }));
  });
}

// A bound-but-silent UDP server: it never replies, so sendRcon must time out.
function silentServer(t) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    t.after(() => {
      try { sock.close(); } catch { /* already closed */ }
    });
    sock.bind(0, "127.0.0.1", () => resolve({ port: sock.address().port }));
  });
}

test("sendRcon returns the print reply on a correct password", async (t) => {
  const { port } = await fakeRconServer(t, { password: "pw", reply: (c) => `output for ${c}` });
  const r = await sendRcon("127.0.0.1", port, "pw", "status", { timeoutMs: 1500, gatherMs: 150 });
  assert.equal(r.ok, true);
  assert.equal(r.replied, true);
  assert.equal(r.authFailed, false);
  assert.match(r.reply, /output for status/);
});

test("sendRcon flags a bad rcon password (ok=false, authFailed=true)", async (t) => {
  const { port } = await fakeRconServer(t, { password: "right" });
  const r = await sendRcon("127.0.0.1", port, "wrong", "status", { timeoutMs: 1500, gatherMs: 150 });
  assert.equal(r.authFailed, true);
  assert.equal(r.ok, false);
});

test("sendRcon: no reply is not a failure (say-style commands don't echo)", async (t) => {
  const { port } = await silentServer(t);
  const r = await sendRcon("127.0.0.1", port, "pw", 'say "hi"', { timeoutMs: 300, gatherMs: 100 });
  assert.equal(r.replied, false);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
});

test("sendRcon rejects empty command / missing password without sending", async () => {
  assert.equal((await sendRcon("127.0.0.1", 44400, "pw", "")).ok, false);
  assert.equal((await sendRcon("127.0.0.1", 44400, "", "status")).ok, false);
});

test("sanitizeCommand strips newlines + control chars and caps length", () => {
  assert.equal(sanitizeCommand("say hi\nquit"), "say hi quit");
  assert.equal(sanitizeCommand("\tstatus\r"), "status");
  assert.equal(sanitizeCommand("  trim  "), "trim");
  assert.ok(sanitizeCommand("x".repeat(9000)).length <= 480);
});

test("sayCommand quotes safely (drops \" ; \\) and keeps ^colour codes", () => {
  assert.equal(sayCommand('hello "there"; quit'), 'say "hello there quit"');
  assert.equal(sayCommand("^1red ^7white"), 'say "^1red ^7white"');
});

test("broadcastRcon fans out with parseAddress and preserves target identity", async (t) => {
  const { port } = await fakeRconServer(t, { password: "pw", reply: () => "ok" });
  const results = await broadcastRcon(
    [
      { id: 7, name: "eu", address: `127.0.0.1:${port}`, password: "pw" },
      { id: 8, name: "bad", address: "", password: "pw" }, // parseAddress -> null
    ],
    sayCommand("hi"),
    { parseAddress, timeoutMs: 1500, gatherMs: 150 }
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 7);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].id, 8);
  assert.equal(results[1].ok, false); // unparseable address never sends
  assert.equal(results[1].error, "bad address");
});
