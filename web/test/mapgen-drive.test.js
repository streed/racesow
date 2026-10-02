// The map editor's test drive (public/assets/js/mapgen-drive.js): the race
// servers' movement code, ported, over the brushes the generator lays out.
// Driven here with scripted input, against the promises the generator makes
// in tools/mapgen/physics.py: run speed is reached on any run-up (ice
// included), every gap it builds is cleared from run speed, walls hold, and an
// example course can be finished, every checkpoint crossed in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mg from "../public/assets/js/mapgen-course.js";
import { makeWorld, makePlayer, pmove, trace, Run, autopilot, medals, fmtMs, FRAME_MSEC } from "../public/assets/js/mapgen-drive.js";

const S = (length, k = {}) => ({ type: "straight", length, ...k });
const lay = (width, ...segments) => mg.build({ name: "gen_drive", title: "Drive", width, segments }).course;
const speed = (p) => Math.hypot(p.velocity[0], p.velocity[1]);
const example = (n) => JSON.parse(readFileSync(new URL(`../../tools/mapgen/examples/${n}.json`, import.meta.url)));

test("the spawn point drops to the floor, as the engine drops it", () => {
  const p = makePlayer(makeWorld(lay(384, S(1024))));
  assert.ok(Math.abs(p.origin[2] - 24) < 0.1, `origin z ${p.origin[2]} (floor 0, box mins -24)`);
});

test("running reaches 320 ups within a quarter second and holds it", () => {
  const w = makeWorld(lay(384, S(2048)));
  const p = makePlayer(w);
  let at = null;
  for (let i = 0; i < 200; i++) {
    pmove(w, p, { forward: 1, yaw: 0 });
    if (at === null && speed(p) > 315) at = (i + 1) * FRAME_MSEC;
  }
  assert.ok(at !== null && at <= 250, `315 ups after ${at} ms`);
  assert.ok(Math.abs(speed(p) - 320) < 0.5);
  assert.ok(p.ground);
});

test("grip brakes; ice keeps every bit of speed", () => {
  for (const ice of [false, true]) {
    const w = makeWorld(lay(384, S(4096, { ice })));
    const p = makePlayer(w);
    for (let i = 0; i < 250; i++) pmove(w, p, { forward: 1, yaw: 0 });
    assert.equal(p.groundSurf, ice ? 2 : 0, "SURF_SLICK from the ice texture");
    for (let i = 0; i < 125; i++) pmove(w, p, { yaw: 0 });
    if (ice) assert.ok(speed(p) > 319, `ice coasts: ${speed(p)}`);
    else assert.equal(speed(p), 0);
  }
});

test("walls hold the player box", () => {
  const w = makeWorld(lay(384, S(2048)));
  const p = makePlayer(w);
  for (let i = 0; i < 300; i++) pmove(w, p, { forward: 1, yaw: 90 });
  assert.ok(Math.abs(p.origin[1] - (192 - 16)) < 0.1, `y ${p.origin[1]}`);
  const tr = trace(w, p.origin, [p.origin[0], p.origin[1] + 100, p.origin[2]]);
  assert.ok(tr.fraction < 0.01 && tr.plane.n[1] < -0.99, "the wall is right there, facing back");
});

test("every gap the generator allows is cleared by a run-speed jump", () => {
  for (const drop of [-36, 0, 64, 256, 512]) {
    const length = Math.floor(mg.maxGap(drop));
    const c = lay(384, S(1024), { type: "gap", length, drop }, S(1024));
    const w = makeWorld(c);
    const lip = c.landmarks.find(([k]) => k === "gap")[1][0];
    const p = makePlayer(w);
    let jumped = false;
    for (let i = 0; i < 900; i++) {
      const jump = !jumped && p.origin[0] > lip - 16;
      jumped ||= jump;
      pmove(w, p, { forward: 1, yaw: 0, jump });
    }
    assert.ok(p.origin[0] > lip + length + 200, `drop ${drop}: stopped at x ${p.origin[0]}`);
    assert.ok(Math.abs(p.origin[2] - (24 - drop)) < 1, `drop ${drop}: on the landing, z ${p.origin[2]}`);
  }
});

test("an example course is finished, every checkpoint in order, near par", () => {
  for (const name of ["gen_first_light", "gen_serpent_cut"]) {
    const c = mg.build(example(name)).course;
    const w = makeWorld(c);
    const run = new Run(w);
    const drive = autopilot(c);
    for (let i = 0; i < 125 * 120 && run.finished === null; i++) run.step(drive(run));
    assert.ok(run.finished !== null, `${name}: not finished`);
    assert.equal(run.splits.length, w.cpOrder.length, `${name}: checkpoints`);
    assert.ok(run.splits.every((t, i) => i === 0 || t > run.splits[i - 1]), "splits in order");
    const par = (c.length / 320) * 1000;
    assert.ok(run.finished > par * 0.8 && run.finished < par * 1.1, `${name}: ${fmtMs(run.finished)} vs par ${fmtMs(par)}`);
    assert.equal(run.respawns, 0);
    assert.ok(run.trail.length > 100, "a ghost to race next time");
  }
});

test("the clock waits for the start line, and a fall puts you back on the last checkpoint", () => {
  // A checkpoint, then an open straight to fall off.
  const c = lay(384, S(1600), { type: "checkpoint" }, S(600), S(1600, { open: true }));
  const w = makeWorld(c);
  const run = new Run(w);
  for (let i = 0; i < 20; i++) run.step({ yaw: 0 });
  assert.equal(run.running, false, "standing in the start room");
  for (let i = 0; i < 125 * 30 && run.splits.length === 0; i++) run.step({ forward: 1, yaw: 0 });
  assert.equal(run.running, true);
  assert.equal(run.splits.length, 1);
  const cpX = run.lastCp.origin[0];
  for (let i = 0; i < 125 * 8 && run.respawns === 0; i++) run.step({ forward: 1, yaw: 30 });
  assert.equal(run.respawns, 1, "fell off the open straight into the pit");
  assert.ok(Math.abs(run.p.origin[0] - cpX) < 1, "back on the checkpoint");
  assert.ok(run.running && run.time > 0, "with the clock still running");
});

test("medals follow the author time, TrackMania's way", () => {
  assert.deepEqual(medals(30000), { author: 30000, gold: 31800, silver: 36000, bronze: 45000 });
  assert.equal(medals(12345).gold, 13100);
  assert.equal(fmtMs(83456), "1:23.456");
  assert.equal(fmtMs(9870), "9.870");
});
