// Verifies web/demo-replay.mjs — the SERVER-autorecord demo replayer that
// recovers a run's map/runner/time AND recomputes its air-strafe quality from
// the recorded snapshots.
//
// Two things are load-bearing here and each is tested separately:
//
//  1. The sampler port. strafeQuality() must be gate-for-gate Player.sampleStrafe()
//     (hrace/player.as), because the number it produces is written to
//     finish.strafe_quality alongside values the LIVE sampler produced — if the
//     port drifts, demo-derived and live-derived rows stop meaning the same
//     thing. These tests drive it with hand-built sample series, one per gate.
//
//  2. The wire decode. A mis-ordered or mis-sized playerstate field does not
//     throw, it silently yields plausible-but-wrong velocities, so the fixture
//     test asserts against values the demo states about ITSELF through an
//     independent channel: the scoreboard's max speed and the mod's printed
//     start speed and finish time.
//
// The fixture is a real server autorecord (multipov, ~720 KB). It is optional:
// when absent, the fixture test skips and the unit tests still run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import {
  replayDemo,
  strafeQuality,
  strafeQualityBasisPoints,
  idealGain,
  idealGainSingleStep,
  tokenize,
} from "../../web/demo-replay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "hrace_line_auto2472.wdz20");

// Keys the sampler reads (KEYICON_* bits): forward | left | right.
const FWD = 1 << 0, LEFT = 1 << 2, RIGHT = 1 << 3;

// Build a sample series at a fixed period. `over` patches individual frames.
function series(n, base, over = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: i * 16, vx: base.speed, vy: 0, vz: 0, yaw: 0,
      keys: base.keys, pm_flags: 0, pm_type: 0, maxspeed: 320,
      ...(over[i] || {}),
    });
  }
  return out;
}
const noGround = () => false;
const bpOf = (samples) => strafeQualityBasisPoints(strafeQuality(samples, { groundFn: noGround }));

test("idealGain: sub-stepping is the concavity correction", () => {
  const base = 320, prev = 1000;
  // One 16 ms step IS a game frame, so both denominators must agree exactly.
  assert.equal(idealGain(prev, base, 0.016, 16), idealGainSingleStep(prev, base, 0.016));
  // Across a 50 ms snapshot gap, three chained game frames reach FURTHER than a
  // single lumped step — which is exactly why scoring a 50 ms gain against the
  // single-step denominator reads high.
  const sub = idealGain(prev, base, 0.05, 16);
  const single = idealGainSingleStep(prev, base, 0.05);
  assert.ok(sub > single, `sub-stepped ${sub} should exceed single-step ${single}`);
  // ...and the gap is real but modest (a couple of percent), not a rewrite.
  assert.ok(sub / single > 1.005 && sub / single < 1.10, `ratio ${sub / single}`);
});

test("strafeQuality: a perfect strafer scores ~100%, a still mouse scores nothing", () => {
  // Gain exactly the ideal each frame, mouse turning into the held side key.
  const n = 40, base = 320, dt = 0.016;
  const s = [];
  let v = 1000, yaw = 0;
  for (let i = 0; i < n; i++) {
    s.push({ t: i * 16, vx: v, vy: 0, vz: 0, yaw, keys: FWD | RIGHT, pm_flags: 0, pm_type: 0, maxspeed: base });
    v += idealGain(v, base, dt, 16);
    yaw -= 0.5;                     // turning RIGHT decreases yaw
  }
  const bp = bpOf(s);
  assert.ok(bp >= 9900, `perfect strafe should be ~100%, got ${bp}`);

  // Same speeds, but the mouse never moves: the yaw gate rejects every frame.
  const still = s.map((x) => ({ ...x, yaw: 0 }));
  assert.equal(bpOf(still), -1, "no sampled frames leaves the -1 sentinel");
});

test("strafeQuality: the key gates match the AngelScript net-intent rules", () => {
  const mk = (keys) => {
    const s = [];
    let v = 1000, yaw = 0;
    for (let i = 0; i < 20; i++) {
      s.push({ t: i * 16, vx: v, vy: 0, vz: 0, yaw, keys, pm_flags: 0, pm_type: 0, maxspeed: 320 });
      v += idealGain(v, 320, 0.016, 16);
      yaw -= 0.5;
    }
    return s;
  };
  assert.ok(bpOf(mk(FWD | RIGHT)) > 9000, "forward + one side key strafes");
  assert.equal(bpOf(mk(RIGHT)), -1, "no forward => not strafing");
  assert.equal(bpOf(mk(FWD)), -1, "no side key => not strafing");
  assert.equal(bpOf(mk(FWD | LEFT | RIGHT)), -1, "both sides cancel to no net input");
  // Holding LEFT while turning right (yaw decreasing) is the wrong pairing.
  assert.equal(bpOf(mk(FWD | LEFT)), -1, "mouse must turn INTO the held side key");
});

test("strafeQuality: below STRAFE_MIN_SPEED nothing is sampled", () => {
  const s = series(20, { speed: 400, keys: FWD | RIGHT });
  for (let i = 0; i < s.length; i++) { s[i].vx = 400 + i * 2; s[i].yaw = -0.5 * i; }
  assert.equal(bpOf(s), -1, "the 600ups floor keeps the metric to real strafing speed");
});

test("strafeQuality: ground frames and external impulses are excluded", () => {
  const build = (patch) => {
    const s = [];
    let v = 1000, yaw = 0;
    for (let i = 0; i < 20; i++) {
      s.push({ t: i * 16, vx: v, vy: 0, vz: 0, yaw, keys: FWD | RIGHT, pm_flags: 0, pm_type: 0, maxspeed: 320 });
      v += idealGain(v, 320, 0.016, 16);
      yaw -= 0.5;
    }
    patch(s);
    return s;
  };
  // A jump pad mid-run: a gain far past the strafe max must not be scored as a
  // brilliant strafe (STRAFE_IMPULSE_FACTOR).
  const impulsed = build((s) => { for (let i = 10; i < s.length; i++) s[i].vx += 500; });
  const acc = strafeQuality(impulsed, { groundFn: noGround });
  assert.equal(acc.rejected.impulse, 1, "exactly the frame carrying the kick is rejected");

  // PMF_ON_GROUND frames are skipped: air accel is the strafe regime.
  const grounded = build((s) => { for (const x of s) x.pm_flags = 1 << 2; });
  assert.equal(bpOf(grounded) > 0, true, "the ground rule is the caller's, not baked in");
  const withGround = strafeQuality(grounded, { groundFn: (a, i) => (a[i].pm_flags & (1 << 2)) !== 0 });
  assert.equal(strafeQualityBasisPoints(withGround), -1, "all-ground run samples nothing");
});

test("strafeQuality: losing speed while strafing floors at 0, never negative", () => {
  const s = [];
  let v = 2000, yaw = 0;
  for (let i = 0; i < 20; i++) {
    s.push({ t: i * 16, vx: v, vy: 0, vz: 0, yaw, keys: FWD | RIGHT, pm_flags: 0, pm_type: 0, maxspeed: 320 });
    v -= 5;                         // bleeding speed
    yaw -= 0.5;
  }
  assert.equal(bpOf(s), 0, "pointing wrong while strafing is 0%, not a negative score");
});

test("strafeQuality: the key mask is read from the PREVIOUS snapshot", () => {
  // ps.plrkeys is written in G_ClientEndSnapFrame, which runs after that
  // interval's game frames — so snapshot k's mask gated the NEXT interval.
  // Build a series where the mask flips exactly once and check which interval
  // the flip gates.
  const s = [];
  let v = 1000, yaw = 0;
  for (let i = 0; i < 6; i++) {
    // Frames 0-2 carry a strafing mask, 3-5 carry a non-strafing one.
    s.push({ t: i * 16, vx: v, vy: 0, vz: 0, yaw, keys: i < 3 ? (FWD | RIGHT) : FWD,
             pm_flags: 0, pm_type: 0, maxspeed: 320 });
    v += idealGain(v, 320, 0.016, 16);
    yaw -= 0.5;
  }
  const lag1 = strafeQuality(s, { groundFn: noGround, keyLag: 1 });
  const lag0 = strafeQuality(s, { groundFn: noGround, keyLag: 0 });
  // With the faithful lag the strafing mask covers intervals 1..3; with the
  // naive one it covers 1..2. One extra interval is scored, and that offset is
  // exactly the defect the phase fix removes.
  assert.equal(lag1.sampled, 3);
  assert.equal(lag0.sampled, 2);
});

test("tokenize: quoted groups survive, as in Cmd_TokenizeString", () => {
  assert.deepEqual(tokenize('aw "^5Race Finished!"'), ["aw", "^5Race Finished!"]);
  assert.deepEqual(tokenize("scb  &t 1 0 24"), ["scb", "&t", "1", "0", "24"]);
  assert.deepEqual(tokenize(""), []);
});

// The fixture test. Every assertion is against something the demo asserts about
// itself through a channel INDEPENDENT of the playerstate decode.
test("replayDemo: recovers the run and its metric from a real server autorecord", { skip: !fs.existsSync(FIXTURE) && "fixture not present" }, () => {
  const r = replayDemo(FIXTURE);

  assert.equal(r.map, "line");
  assert.equal(r.gametype, "hrace");
  assert.equal(r.multipov, true);
  // A server autorecord has no matchname/matchscore — the whole reason
  // web/demo-meta.mjs cannot read this file.
  assert.equal(r.matchname, null);
  assert.equal(r.matchscore, null);

  // The walk must consume the entire decompressed stream: a desync would leave
  // it short, and short-but-plausible is the failure mode that matters.
  assert.equal(r.stats.walkEnd, r.stats.rawBytes, "parser must reach exactly EOF");
  assert.equal(r.stats.frames, 22658);
  assert.equal(r.stats.snapPeriodMs, 50);

  // Four finishes, all by the one connected client.
  assert.equal(r.runs.length, 4);
  assert.deepEqual(r.runs.map((x) => x.timeMs), [58805, 58900, 58955, 59024]);

  const best = r.best;
  assert.equal(best.timeMs, 58805);                            // cp "Current: 00:58.805"
  // The configstring holds the raw netname; the mod reports client.name, which
  // the AngelScript accessor suffixes with S_COLOR_WHITE — and THAT is the form
  // the database stores, so it is what `player` must carry.
  assert.equal(best.playerRawName, "^7*^1<^7|Yes^1!^0stal^1.");
  assert.equal(best.player, "^7*^1<^7|Yes^1!^0stal^1.^7");
  assert.ok(best.awards.includes("Personal record!"));
  assert.ok(best.awards.includes("livesow.net record!"));

  // Independent cross-checks on the DECODED velocity series:
  //   the scoreboard reports this run's max speed as 3188,
  //   the mod printed "Starting speed: 629" at the start trigger.
  assert.equal(best.maxSpeed, 3188);
  assert.equal(best.startSpeed, 629);

  // The metric itself. Pinned to catch a silent drift in the port: this exact
  // value was reproduced by two independently-written reimplementations.
  assert.equal(best.strafeQualityBp, 8551);
  // Key phase is the single biggest modelling choice, so pin its direction too:
  // pairing the mask with the WRONG interval stops rejecting the frames at
  // direction switches (where quality is genuinely poor), so it reads LOWER.
  assert.equal(best.provenance.bpKeyLag0, 8365);
  assert.ok(best.provenance.bpKeyLag0 < best.strafeQualityBp);
  // The rejection tallies are the mechanism behind that gap — pin them so a
  // regression in the gates is visible as more than one moved number.
  assert.equal(best.provenance.strafeSampledFrames, 1025);
  assert.equal(best.provenance.rejected.yaw, 119);

  // Dated from the demo's own clock: 2025-12-27, not import day.
  assert.equal(new Date(best.finishedAt * 1000).toISOString().slice(0, 10), "2025-12-27");
});
