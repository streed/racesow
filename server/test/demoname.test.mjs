// Verifies the AngelScript WR-demo filename reconstruction (hrace/demos.as
// RACE_DemoCleanName / RACE_DemoTimeString / RACE_DemoRelPath) matches the
// engine's SV_CleanDemoName / SV_UintToTimeString byte-for-byte — the load-
// bearing invariant of Phase 1: the path the mod reports to the web must equal
// the file the engine's demoStop actually wrote. Two INDEPENDENT ports (one of
// the C source in server/sv_demos.c, one of the .as source) are compared over
// tricky inputs; a divergence means a real filename mismatch in production.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- faithful port of the engine C (server/sv_demos.c SV_CleanDemoName) -----
// char is SIGNED on x86-64 Linux, so `*in < 0x1F` also drops bytes >= 0x80.
function engineClean(bytes) {
  const JUNK = new Set([0x22, 0x2a, 0x2f, 0x3a, 0x3f, 0x5c, 0x2e, 0x7c, 0x20]); // " * / : ? \ . | space
  const out = [];
  for (const b of bytes) {
    const signed = b < 128 ? b : b - 256;
    if (signed < 0x1f || b === 0x7f) continue; // skip
    else if (JUNK.has(b)) out.push(0x5f); // -> _
    else if (b === 0x3c) out.push(0x28); // < -> (
    else if (b === 0x3e) out.push(0x29); // > -> )
    else out.push(b);
  }
  return Buffer.from(out).toString("latin1");
}
function engineTime(ms) {
  const min = Math.floor(ms / 60000);
  ms -= min * 60000;
  const sec = Math.floor(ms / 1000);
  ms -= sec * 1000;
  const p = (v, w) => String(v).padStart(w, "0");
  return `${p(min, 2)}-${p(sec, 2)}-${p(ms, 3)}`;
}

// ---- faithful port of the AngelScript (hrace/demos.as RACE_DemoCleanName) ---
// Keep [A-Za-z0-9_-]; other printable ASCII -> '_'; control/non-ASCII dropped;
// empty -> "player".
function asClean(bytes) {
  const out = [];
  const A = "A".charCodeAt(0), Z = "Z".charCodeAt(0), a = "a".charCodeAt(0), z = "z".charCodeAt(0);
  const n0 = "0".charCodeAt(0), n9 = "9".charCodeAt(0);
  for (const c of bytes) {
    if ((c >= n0 && c <= n9) || (c >= A && c <= Z) || (c >= a && c <= z) || c === 0x5f || c === 0x2d)
      out.push(c);
    else if (c >= 0x20 && c < 0x7f) out.push(0x5f);
    // control / DEL / >=0x80: dropped
  }
  if (out.length === 0) return "player";
  return Buffer.from(out).toString("latin1");
}
function asPad(v, w) {
  let s = "" + v;
  while (s.length < w) s = "0" + s;
  return s;
}
function asTime(ms) {
  const mins = Math.floor(ms / 60000);
  ms -= mins * 60000;
  const secs = Math.floor(ms / 1000);
  ms -= secs * 1000;
  return `${asPad(mins, 2)}-${asPad(secs, 2)}-${asPad(ms, 3)}`;
}

// removeColorTokens() strips ^0-^9 before either cleaner runs.
function stripColors(s) {
  return s.replace(/\^[0-9]/g, "");
}

// The load-bearing invariant: the name the mod hands to demoStop is asClean(raw),
// and the engine writes SV_CleanDemoName(that). The reported path uses asClean(raw).
// They match for ALL names iff asClean's output is a FIXED POINT of the engine
// cleaner — engineClean(asClean(raw)) === asClean(raw).
test("mod's cleaned name is a fixed point of the engine cleaner (paths match)", () => {
  const names = [
    "Nova",
    "^1No^7va", // colour codes (stripped first)
    "El Chupa", // space -> _
    'a"b*c/d:e?f\\g.h|i', // full junk set -> _
    "<html>", // < > -> ( )
    "n.o.v.a",
    "UPPER_lower-123",
    "café", // non-ASCII (é = 0xC3 0xA9 in UTF-8) -> dropped
    "☺nick☺", // multibyte non-ASCII -> dropped
    "tab\tnewline\nbell", // control chars: \t and space-ish dropped/mapped
    "trailing ", // trailing space -> _
    "()[]{}!@#$%^&+=~", // brackets/symbols kept as-is (not in junk set)
    "", // empty
  ];
  const WEB_SEG = /^[A-Za-z0-9_.-]+$/; // must equal server.js DEMO_SEG
  for (const raw of names) {
    const bytes = Buffer.from(stripColors(raw), "utf8");
    const cleaned = asClean(bytes);
    const engineOut = engineClean(Buffer.from(cleaned, "latin1"));
    assert.equal(engineOut, cleaned, `not a fixed point for ${JSON.stringify(raw)}: cleaned=${JSON.stringify(cleaned)} engine=${JSON.stringify(engineOut)}`);
    assert.match(cleaned, WEB_SEG, `web-unsafe cleaned name ${JSON.stringify(cleaned)}`);
  }
});

test("time-string port matches the engine (MM-SS-mmm)", () => {
  for (const ms of [0, 1, 999, 1000, 12360, 59999, 60000, 61500, 599999, 3599999, 12345678]) {
    assert.equal(asTime(ms), engineTime(ms), `time mismatch at ${ms}`);
  }
  assert.equal(asTime(12360), "00-12-360");
  assert.equal(asTime(92560), "01-32-560");
});

test("full relative path shape matches demoStop output", () => {
  const map = "100m";
  const clean = asClean(Buffer.from(stripColors("^2Runner"), "utf8"));
  const rel = `${map}/${map}_${clean}_${asTime(12360)}.wdz20`;
  assert.equal(rel, "100m/100m_Runner_00-12-360.wdz20");
  // two segments, .wdz20, no traversal — exactly what the web validDemoPath wants
  assert.equal(rel.split("/").length, 2);
  assert.match(rel, /\.wdz20$/);
});
