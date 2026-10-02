// Test drive: run a course in the map editor before it is built.
//
// TrackMania's editor is built around one loop: place a piece, drive it, place
// the next. This module is the "drive it": a port of the movement code the race
// servers run (DenMSC/racemod_2.1, gameshared/gs_pmove.c, branch race-demos,
// the tree server/Dockerfile builds) and of the box-against-brush trace it
// moves through (qcommon/cm_trace.c), over the brushes mapgen-course.js laid
// out. Slick ice, ramps, steps, gaps, dashes and wall jumps behave as they do
// in game because they are the same code:
//
//   PM_Friction      gs_pmove.c:462   no ground friction on SURF_SLICK (ice)
//   PM_Accelerate    gs_pmove.c:516   ground and strafe-jump acceleration
//   PM_AirAccelerate gs_pmove.c:533   forward bunny (PMFEAT_FWDBUNNY)
//   PM_Aircontrol    gs_pmove.c:587   +strafe air control
//   PM_Move          gs_pmove.c:716   the race branch (every PMFEAT on)
//   PM_SlideMove / PM_StepSlideMove   gs_pmove.c:232 / :374
//   PM_CheckJump / PM_CheckDash / PM_CheckWallJump   :1030 / :1100 / :1191
//
// What is NOT the engine: brushes have their axial bevels but not the edge
// bevels q3map2 adds between two slanted faces, so a box can catch a hair early
// on the outside corner between two turn wedges; the origin is not snapped to
// the network's 1/8 unit; there is no crouch, water, ladder or knockback. It is
// a test drive, not the record: the map's real times come from the servers.
//
// Pure (no DOM): test/mapgen-drive.test.js drives it under node.

export const FRAME_MSEC = 8;                 // 125 fps, the usual race client rate
const GRAVITY = 850;
const GRAVITY_COMPENSATE = GRAVITY / 800;
const MAX_SPEED = 320;                        // DEFAULT_PLAYERSPEED_RACE
const JUMP_SPEED = 280 * GRAVITY_COMPENSATE;  // stats[JUMPSPEED] * GRAVITY_COMPENSATE (Pmove)
const DASH_SPEED = 451;
const SPEEDKEY = 500;
const STEPSIZE = 18;
const PM_FRICTION = 8;
const PM_ACCELERATE = 12;
const PM_DECELERATE = 12;
const PM_AIRACCELERATE = 1;
const PM_AIRDECELERATE = 2;
const PM_AIRCONTROL = 150;
const PM_STRAFEBUNNYACCEL = 70;
const PM_WISHSPEED = 30;
const PM_DASHUPSPEED = 174 * GRAVITY_COMPENSATE;
const PM_WJUPSPEED = 330 * GRAVITY_COMPENSATE;
const PM_WJBOUNCEFACTOR = 0.3;
const PM_WJMINSPEED = (160 + MAX_SPEED) * 0.5;   // (maxWalkSpeed + maxPlayerSpeed) / 2
const PM_DASHJUMP_TIMEDELAY = 1000;
const PM_WALLJUMP_TIMEDELAY = 1300;
const PM_AIRCONTROL_BOUNCE_DELAY = 200;
const PM_OVERBOUNCE = 1.01;
const SLIDE_EPS = 0.05;                       // SLIDEMOVE_PLANEINTERACT_EPSILON
const MAX_CLIP_PLANES = 5;
const DIST_EPSILON = 1 / 32;                  // cm_trace.c
export const MINS = [-16, -16, -24];
export const MAXS = [16, 16, 40];
export const VIEWHEIGHT = 30;
const SURF_SLICK = 0x2;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const walkable = (n) => n[2] >= 0.7;          // ISWALKABLEPLANE

function clipVelocity(v, n, overbounce) {     // GS_ClipVelocity
  let backoff = dot(v, n);
  backoff = backoff <= 0 ? backoff * overbounce : backoff / overbounce;
  return [v[0] - n[0] * backoff, v[1] - n[1] * backoff, v[2] - n[2] * backoff];
}
const normalize = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l) { v[0] /= l; v[1] /= l; v[2] /= l; }
  return l;
};
const normalize2D = (v) => {
  const l = Math.hypot(v[0], v[1]);
  if (l) { v[0] /= l; v[1] /= l; }
  return l;
};

/* ------------------------------ the world ------------------------------- */

// Every solid prism as a convex brush: its top plane (sloped on a ramp), its
// bottom, one side per footprint edge, and the axial bevels q3map2 adds.
function brushOf(p) {
  const planes = [];
  const tl = Math.hypot(p.gx, p.gy, 1);
  planes.push({ n: [-p.gx / tl, -p.gy / tl, 1 / tl], d: p.top0 / tl, surf: p.tex === "ice" ? SURF_SLICK : 0 });
  planes.push({ n: [0, 0, -1], d: -p.zmin, surf: 0 });
  const k = p.poly.length;
  for (let i = 0; i < k; i++) {
    const [ax, ay] = p.poly[i], [bx, by] = p.poly[(i + 1) % k];
    const L = Math.hypot(by - ay, bx - ax);
    if (L < 1e-6) continue;
    const n = [(by - ay) / L, -(bx - ax) / L, 0];
    planes.push({ n, d: n[0] * ax + n[1] * ay, surf: 0 });
  }
  const xs = p.poly.map((q) => q[0]), ys = p.poly.map((q) => q[1]);
  const lo = [Math.min(...xs), Math.min(...ys), p.zmin];
  const hi = [Math.max(...xs), Math.max(...ys), p.zmax()];
  for (let a = 0; a < 2; a++) {
    const n = [0, 0, 0];
    n[a] = 1;
    planes.push({ n, d: hi[a], surf: 0, bevel: true });
    const m = [0, 0, 0];
    m[a] = -1;
    planes.push({ n: m, d: -lo[a], surf: 0, bevel: true });
  }
  return { planes, lo, hi };
}

// The course as something to move through: solid brushes, plus the trigger
// volumes the race reads (start, checkpoints, finish, and the pit).
export function makeWorld(course) {
  const brushes = course.world.filter((p) => p.tex !== "trigger").map(brushOf);
  const named = new Map(course.entities.filter(([e]) => e.targetname).map(([e]) => [e.targetname, e.classname]));
  const triggers = [];
  for (const [e, bs] of course.entities) {
    if (!bs.length) continue;
    const kind = e.classname === "trigger_hurt" ? "hurt"
      : { target_starttimer: "start", target_stoptimer: "finish", target_checkpoint: "cp" }[named.get(e.target)];
    if (!kind) continue;
    for (const b of bs) triggers.push({ kind, id: e.target || "hurt", poly: b.poly, zlo: b.zmin, zhi: b.zmax() });
  }
  // Checkpoints in course order: the order their landmarks were laid.
  const order = triggers.filter((t) => t.kind === "cp").map((t) => t.id);
  const spawnEnt = course.entities.find(([e]) => e.classname === "info_player_deathmatch")[0];
  return { brushes, triggers, cpOrder: [...new Set(order)], spawn: spawnEnt.origin, spawnYaw: spawnEnt.angle, route: course.route };
}

// cm_trace.c: sweep the player box from start to end against every brush.
export function trace(world, start, end, mins = MINS, maxs = MAXS) {
  const tr = { fraction: 1, endpos: end.slice(), plane: null, surf: 0, startsolid: false, allsolid: false };
  const lo = [0, 1, 2].map((i) => Math.min(start[i], end[i]) + mins[i] - 1);
  const hi = [0, 1, 2].map((i) => Math.max(start[i], end[i]) + maxs[i] + 1);
  for (const b of world.brushes) {
    if (b.lo[0] > hi[0] || b.hi[0] < lo[0] || b.lo[1] > hi[1] || b.hi[1] < lo[1] || b.lo[2] > hi[2] || b.hi[2] < lo[2]) continue;
    let enter = -1, leave = 1, clip = null, startout = false, getout = false, out = false;
    for (const pl of b.planes) {
      const n = pl.n;
      const off = (n[0] < 0 ? maxs[0] : mins[0]) * n[0] + (n[1] < 0 ? maxs[1] : mins[1]) * n[1] + (n[2] < 0 ? maxs[2] : mins[2]) * n[2];
      const dist = pl.d - off;
      const d1 = dot(start, n) - dist, d2 = dot(end, n) - dist;
      if (d2 > 0) getout = true;
      if (d1 > 0) startout = true;
      if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) { out = true; break; }
      if (d1 <= 0 && d2 <= 0) continue;
      if (d1 > d2) {
        const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
        if (f > enter) { enter = f; clip = pl; }
      } else {
        const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
        if (f < leave) leave = f;
      }
    }
    if (out) continue;
    if (!startout) {
      tr.startsolid = true;
      if (!getout) { tr.allsolid = true; tr.fraction = 0; tr.endpos = start.slice(); return tr; }
      continue;
    }
    if (enter < leave && enter > -1 && enter < tr.fraction) {
      tr.fraction = Math.max(0, enter);
      tr.plane = clip;
      tr.surf = clip.surf;
    }
  }
  if (tr.fraction < 1) tr.endpos = [0, 1, 2].map((i) => start[i] + tr.fraction * (end[i] - start[i]));
  return tr;
}

/* ------------------------------- pmove ---------------------------------- */

export function makePlayer(world) {
  const o = world.spawn;
  const p = {
    origin: [o[0], o[1], o[2]], velocity: [0, 0, 0], yaw: world.spawnYaw, pitch: 0,
    ground: false, groundPlane: null, groundSurf: 0,
    jumpHeld: false, specialHeld: false, dashing: false, walljumping: false, wjCount: false,
    dashTime: 0, wjTime: 0,
  };
  // The engine drops a spawn point to the floor under it.
  const down = trace(world, p.origin, [o[0], o[1], o[2] - 256]);
  if (!down.allsolid) p.origin = down.endpos;
  return p;
}

function angleVectors(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180, pt = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pt);
  const forward = [cp * Math.cos(y), cp * Math.sin(y), -Math.sin(pt)];
  const right = [Math.sin(y), -Math.cos(y), 0];
  return { forward, right };
}

function categorize(w, p) {           // PM_CategorizePosition
  if (p.velocity[2] > 180) { p.ground = false; return; }
  const tr = trace(w, p.origin, [p.origin[0], p.origin[1], p.origin[2] - 0.25]);
  p.groundPlane = tr.plane ? tr.plane.n : null;
  p.groundSurf = tr.surf;
  p.ground = !(tr.fraction === 1 || (!walkable(tr.plane.n) && !tr.startsolid));
}

function slideMove(w, p, frametime) {  // PM_SlideMove
  const planes = [];
  let remaining = frametime;
  let blocked = 0;
  if (p.ground && p.groundPlane && p.groundPlane[2] === 1 && p.velocity[2] < 0) p.velocity[2] = 0;
  for (let moves = 0; moves < 4; moves++) {
    const end = [0, 1, 2].map((i) => p.origin[i] + remaining * p.velocity[i]);
    const tr = trace(w, p.origin, end);
    if (tr.allsolid) return 4;
    if (tr.fraction > 0) p.origin = tr.endpos;
    if (tr.fraction === 1) break;
    blocked |= 1;
    if (tr.plane.n[2] < SLIDE_EPS) blocked |= 2;
    remaining -= tr.fraction * remaining;
    const n = tr.plane.n;
    if (planes.some((q) => dot(n, q) > 1 - SLIDE_EPS)) {
      p.velocity = [p.velocity[0] + n[0], p.velocity[1] + n[1], p.velocity[2] + n[2]];
      continue;
    }
    if (planes.length >= MAX_CLIP_PLANES) { p.velocity = [0, 0, 0]; return 4; }
    planes.push(n);
    for (let i = 0; i < planes.length; i++) {
      if (dot(p.velocity, planes[i]) >= SLIDE_EPS) continue;
      p.velocity = clipVelocity(p.velocity, planes[i], PM_OVERBOUNCE);
      for (let j = 0; j < planes.length; j++) {
        if (j === i || dot(p.velocity, planes[j]) >= SLIDE_EPS) continue;
        p.velocity = clipVelocity(p.velocity, planes[j], PM_OVERBOUNCE);
        if (dot(p.velocity, planes[i]) >= SLIDE_EPS) continue;
        const a = planes[i], b = planes[j];
        const dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        normalize(dir);
        const v = dot(dir, p.velocity);
        p.velocity = [dir[0] * v, dir[1] * v, dir[2] * v];
        for (let k = 0; k < planes.length; k++) {
          if (k === i || k === j || dot(p.velocity, planes[k]) >= SLIDE_EPS) continue;
          p.velocity = [0, 0, 0];
          break;
        }
      }
    }
  }
  return blocked;
}

function stepSlideMove(w, p, frametime) {  // PM_StepSlideMove
  const startO = p.origin.slice(), startV = p.velocity.slice();
  slideMove(w, p, frametime);
  const downO = p.origin.slice(), downV = p.velocity.slice();
  const up = [startO[0], startO[1], startO[2] + STEPSIZE];
  let tr = trace(w, up, up);
  if (tr.allsolid) return;
  p.origin = up;
  p.velocity = startV.slice();
  slideMove(w, p, frametime);
  const down = [p.origin[0], p.origin[1], p.origin[2] - STEPSIZE];
  tr = trace(w, p.origin, down);
  if (!tr.allsolid) p.origin = tr.endpos;
  const upO = p.origin.slice();
  const dd = (downO[0] - startO[0]) ** 2 + (downO[1] - startO[1]) ** 2;
  const ud = (upO[0] - startO[0]) ** 2 + (upO[1] - startO[1]) ** 2;
  if (dd >= ud || tr.allsolid || (tr.fraction !== 1 && !walkable(tr.plane.n))) {
    p.origin = downO;
    p.velocity = downV;
    return;
  }
  const hspeed = Math.hypot(startV[0], startV[1]);
  if (hspeed && tr.plane && walkable(tr.plane.n)) {
    if (tr.plane.n[2] >= 1 - SLIDE_EPS) {
      p.velocity = startV.slice();
    } else {
      normalize2D(p.velocity);
      p.velocity[0] *= hspeed;
      p.velocity[1] *= hspeed;
    }
  }
  p.velocity[2] = downV[2];
}

function friction(p, frametime) {        // PM_Friction
  const v = p.velocity;
  let speed = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (speed < 1) { v[0] = 0; v[1] = 0; return; }
  speed = Math.sqrt(speed);
  let drop = 0;
  if (p.ground && !(p.groundSurf & SURF_SLICK)) {
    const control = speed < PM_DECELERATE ? PM_DECELERATE : speed;
    drop += control * PM_FRICTION * frametime;
  }
  let ns = speed - drop;
  if (ns <= 0) { p.velocity = [0, 0, 0]; return; }
  ns /= speed;
  p.velocity = [v[0] * ns, v[1] * ns, v[2] * ns];
}

function accelerate(p, wishdir, wishspeed, accel, frametime) {  // PM_Accelerate
  const add = wishspeed - dot(p.velocity, wishdir);
  if (add <= 0) return;
  const a = Math.min(add, accel * frametime * wishspeed);
  for (let i = 0; i < 3; i++) p.velocity[i] += a * wishdir[i];
}

function airAccelerate(p, wishdir, wishspeed, frametime) {      // PM_AirAccelerate
  if (!wishspeed) return;
  const curvel = [p.velocity[0], p.velocity[1], 0];
  const curspeed = Math.hypot(curvel[0], curvel[1]);
  if (wishspeed > curspeed * 1.01) {
    wishspeed = Math.min(wishspeed, curspeed + 1.00001 * MAX_SPEED * frametime);
  } else {
    const f = Math.max(0, (925 - curspeed) / (925 - MAX_SPEED));
    wishspeed = Math.max(curspeed, MAX_SPEED) + 0.1593 * f * MAX_SPEED * frametime;
  }
  const acceldir = [wishdir[0] * wishspeed - curvel[0], wishdir[1] * wishspeed - curvel[1], wishdir[2] * wishspeed];
  const addspeed = normalize(acceldir);
  const a = Math.min(addspeed, 4 * MAX_SPEED * frametime);
  const curdir = curvel.slice();
  normalize(curdir);
  const d = dot(acceldir, curdir);
  if (d < 0) for (let i = 0; i < 3; i++) acceldir[i] += -(1 - 0.8) * d * curdir[i];
  for (let i = 0; i < 3; i++) p.velocity[i] += a * acceldir[i];
}

function airControl(p, wishdir, wishspeed, smove, frametime) {  // PM_Aircontrol
  if (smove || wishspeed === 0) return;
  const z = p.velocity[2];
  const v = [p.velocity[0], p.velocity[1], 0];
  const speed = normalize(v);
  const d = dot(v, wishdir);
  const k = 32 * PM_AIRCONTROL * d * d * frametime;
  if (d > 0) {
    v[0] = v[0] * speed + wishdir[0] * k;
    v[1] = v[1] * speed + wishdir[1] * k;
    normalize(v);
  }
  p.velocity = [v[0] * speed, v[1] * speed, z];
}

function touchWall(w, p) {               // PlayerTouchWall(12, 0.3)
  let best = 1, normal = null;
  for (let i = 0; i < 12; i++) {
    const a = (2 * Math.PI / 12) * i;
    const end = [p.origin[0] + (MAXS[0] * Math.cos(a) + p.velocity[0] * 0.015),
      p.origin[1] + (MAXS[1] * Math.sin(a) + p.velocity[1] * 0.015), p.origin[2]];
    const tr = trace(w, p.origin, end, [MINS[0], MINS[1], 0], [MAXS[0], MAXS[1], 0]);
    if (tr.allsolid) return null;
    if (tr.fraction === 1) continue;
    if (tr.fraction > 0 && best > tr.fraction && Math.abs(tr.plane.n[2]) < 0.3) {
      best = tr.fraction;
      normal = tr.plane.n;
    }
  }
  return normal;
}

// One player frame (Pmove): cmd = { forward, side: -1..1, jump, special: bool,
// yaw, pitch: degrees }.
export function pmove(w, p, cmd, msec = FRAME_MSEC) {
  const frametime = msec * 0.001;
  p.yaw = cmd.yaw ?? p.yaw;
  p.pitch = cmd.pitch ?? p.pitch;
  p.dashTime = Math.max(0, p.dashTime - msec);
  p.wjTime = Math.max(0, p.wjTime - msec);
  const fmove = (cmd.forward || 0) * SPEEDKEY, smove = (cmd.side || 0) * SPEEDKEY, up = cmd.jump ? SPEEDKEY : 0;
  categorize(w, p);
  const { forward, right } = angleVectors(p.yaw, p.pitch / 3);
  const flat = [forward[0], forward[1], 0];
  normalize(flat);

  // PM_CheckJump (continuous jump: holding it bunny-hops)
  if (up >= 10 && p.ground) {
    p.ground = false;
    if (p.groundPlane && p.groundPlane[2] > 0 && p.velocity[2] < 0
        && p.groundPlane[0] * p.velocity[0] + p.groundPlane[1] * p.velocity[1] > 0) {
      p.velocity = clipVelocity(p.velocity, p.groundPlane, PM_OVERBOUNCE);
    }
    if (p.velocity[2] > 0) p.velocity[2] += JUMP_SPEED;
    else p.velocity[2] = JUMP_SPEED;
    p.dashing = false;
    p.walljumping = false; p.wjCount = false; p.wjTime = 0;
  }
  // PM_CheckDash
  if (!cmd.special) p.specialHeld = false;
  if (p.dashTime <= 0) {
    if (cmd.special && p.ground) {
      if (!p.specialHeld) {
        p.walljumping = false; p.wjCount = false; p.wjTime = 0;
        p.dashing = true;
        p.specialHeld = true;
        p.ground = false;
        if (p.groundPlane && p.groundPlane[2] > 0 && p.velocity[2] < 0
            && p.groundPlane[0] * p.velocity[0] + p.groundPlane[1] * p.velocity[1] > 0) {
          p.velocity = clipVelocity(p.velocity, p.groundPlane, PM_OVERBOUNCE);
        }
        const upspeed = p.velocity[2] <= 0 ? PM_DASHUPSPEED : PM_DASHUPSPEED + p.velocity[2];
        const dir = [flat[0] * fmove + right[0] * smove, flat[1] * fmove + right[1] * smove, 0];
        if (Math.hypot(dir[0], dir[1]) < 0.01) { dir[0] = flat[0]; dir[1] = flat[1]; }
        normalize(dir);
        const hv = [p.velocity[0], p.velocity[1], 0];
        const actual = normalize2D(hv);
        const s = actual <= DASH_SPEED ? DASH_SPEED : actual;
        p.velocity = [dir[0] * s, dir[1] * s, upspeed];
        p.dashTime = PM_DASHJUMP_TIMEDELAY;
      }
    } else if (!p.ground) {
      p.dashing = false;
    }
  }
  // PM_CheckWallJump
  if (p.ground) { p.walljumping = false; p.wjCount = false; }
  if (p.walljumping && p.velocity[2] < 0) p.walljumping = false;
  if (p.wjTime <= 0) p.wjCount = false;
  if (!(p.dashing && p.dashTime > PM_DASHJUMP_TIMEDELAY - 100)) {
    if (!p.ground && cmd.special && !p.wjCount && p.wjTime <= 0) {
      const hs = Math.hypot(p.velocity[0], p.velocity[1]);
      const tr = trace(w, p.origin, [p.origin[0], p.origin[1], p.origin[2] - STEPSIZE]);
      if (up >= 10 || (hs > DASH_SPEED && p.velocity[2] > 8) || tr.fraction === 1 || (!walkable(tr.plane.n) && !tr.startsolid)) {
        const normal = touchWall(w, p);
        if (normal && !p.specialHeld && !p.walljumping) {
          const old = p.velocity[2];
          p.velocity[2] = 0;
          let h = normalize2D(p.velocity);
          p.velocity = clipVelocity(p.velocity, normal, 1.0005);
          for (let i = 0; i < 3; i++) p.velocity[i] += PM_WJBOUNCEFACTOR * normal[i];
          if (h < PM_WJMINSPEED) h = PM_WJMINSPEED;
          normalize(p.velocity);
          p.velocity = [p.velocity[0] * h, p.velocity[1] * h, old > PM_WJUPSPEED ? old : PM_WJUPSPEED];
          p.dashing = false;
          p.walljumping = true; p.specialHeld = true; p.wjCount = true;
          p.wjTime = PM_WALLJUMP_TIMEDELAY;
        }
      }
    } else {
      p.walljumping = false;
    }
  }
  friction(p, frametime);

  // PM_Move
  const wishvel = [forward[0] * fmove + right[0] * smove, forward[1] * fmove + right[1] * smove, 0];
  const wishdir = wishvel.slice();
  let wishspeed = normalize(wishdir);
  if (wishspeed > MAX_SPEED) wishspeed = MAX_SPEED;
  if (p.ground) {
    if (p.velocity[2] > 0) p.velocity[2] = 0;
    accelerate(p, wishdir, wishspeed, PM_ACCELERATE, frametime);
    if (p.velocity[2] > 0) p.velocity[2] = 0;
    if (p.velocity[0] || p.velocity[1]) stepSlideMove(w, p, frametime);
  } else {
    const accelerating = dot(p.velocity, wishdir) > 0, decelerating = dot(p.velocity, wishdir) < 0;
    // (PM_STAT_FWDTIME never inhibits: PM_FORWARD_ACCEL_TIMEDELAY is 0.)
    const inhibit = (p.walljumping && p.wjTime >= PM_WALLJUMP_TIMEDELAY - PM_AIRCONTROL_BOUNCE_DELAY)
      || (p.dashing && p.dashTime >= PM_DASHJUMP_TIMEDELAY - PM_AIRCONTROL_BOUNCE_DELAY);
    if (accelerating && !inhibit && !smove && fmove) {
      airAccelerate(p, wishdir, wishspeed, frametime);
    } else {
      let aircontrol = true;
      let accel = decelerating && !p.walljumping ? PM_AIRDECELERATE : PM_AIRACCELERATE;
      if (p.walljumping) { accel = 0; aircontrol = false; }
      if (p.dashing && p.dashTime >= PM_DASHJUMP_TIMEDELAY - PM_AIRCONTROL_BOUNCE_DELAY) aircontrol = false;
      if (aircontrol && smove && !fmove) {
        const ws2 = wishspeed;
        accelerate(p, wishdir, Math.min(wishspeed, PM_WISHSPEED), PM_STRAFEBUNNYACCEL, frametime);
        airControl(p, wishdir, ws2, smove, frametime);
      } else {
        accelerate(p, wishdir, wishspeed, accel, frametime);
      }
    }
    p.velocity[2] -= GRAVITY * frametime;
    stepSlideMove(w, p, frametime);
  }
  categorize(w, p);
  if (p.ground) {
    if (p.dashTime < PM_DASHJUMP_TIMEDELAY - 50) p.dashing = false;
    if (p.wjTime < PM_WALLJUMP_TIMEDELAY - 50) { p.walljumping = false; p.wjCount = false; p.wjTime = 0; }
  }
  return p;
}

/* -------------------------------- the race ------------------------------- */

function boxInTrigger(o, t) {
  const z0 = o[2] + MINS[2], z1 = o[2] + MAXS[2];
  if (z1 < t.zlo || z0 > t.zhi) return false;
  // Separating axes: the box's two and the footprint's edges.
  const box = [[o[0] + MINS[0], o[1] + MINS[1]], [o[0] + MAXS[0], o[1] + MINS[1]],
    [o[0] + MAXS[0], o[1] + MAXS[1]], [o[0] + MINS[0], o[1] + MAXS[1]]];
  for (const poly of [box, t.poly]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const ax = y2 - y1, ay = x1 - x2;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const [x, y] of box) { const q = x * ax + y * ay; amin = Math.min(amin, q); amax = Math.max(amax, q); }
      for (const [x, y] of t.poly) { const q = x * ax + y * ay; bmin = Math.min(bmin, q); bmax = Math.max(bmax, q); }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

// A test drive: the player, the clock and the splits. TrackMania's rules for
// a test: the clock starts as you leave the start line, every checkpoint must
// be crossed in order, and a fall puts you back on the last checkpoint you
// crossed with the clock still running (the game itself sends you to the start;
// Backspace does that here).
export class Run {
  constructor(world) {
    this.w = world;
    this.restart();
  }
  restart() {
    this.p = makePlayer(this.w);
    this.time = 0;             // ms since the start line
    this.running = false;
    this.inStart = false;      // inside the start trigger this frame
    this.splits = [];          // ms at each checkpoint, in order
    this.finished = null;      // ms, once the finish is crossed
    this.lastCp = null;        // { origin, yaw } to respawn at
    this.respawns = 0;
    this.trail = [];           // [ms, x, y, z] every 4th frame, for the ghost
    this.events = [];
  }
  respawn() {
    if (!this.lastCp) return this.restart();
    this.p = makePlayer({ ...this.w, spawn: this.lastCp.origin, spawnYaw: this.lastCp.yaw });
    this.respawns++;
  }
  step(cmd) {
    if (this.finished !== null) return;
    pmove(this.w, this.p, cmd);
    const o = this.p.origin;
    let inStart = false;
    for (const t of this.w.triggers) {
      if (!boxInTrigger(o, t)) continue;
      if (t.kind === "start") inStart = true;
      else if (t.kind === "hurt") { this.events.push({ kind: "fall", time: this.time }); this.respawn(); return; }
      else if (t.kind === "cp" && this.running) {
        const next = this.w.cpOrder[this.splits.length];
        if (t.id === next) {
          this.splits.push(this.time);
          this.lastCp = { origin: [o[0], o[1], o[2] + 2], yaw: this.p.yaw };
          this.events.push({ kind: "cp", time: this.time, n: this.splits.length });
        }
      } else if (t.kind === "finish" && this.running && this.splits.length === this.w.cpOrder.length) {
        this.finished = this.time;
        this.events.push({ kind: "finish", time: this.time });
        return;
      }
    }
    // The start line is a trigger across the end of the start room: the clock
    // starts as the player leaves it going forward, and touching it again (a
    // player who turned back) starts the run over.
    if (inStart) {
      if (this.running) { this.running = false; this.time = 0; this.splits = []; this.lastCp = null; this.trail = []; }
    } else if (this.inStart && !this.running) {
      this.running = true;
      this.time = 0;
    }
    this.inStart = inStart;
    if (this.running) {
      this.time += FRAME_MSEC;
      if ((this.time / FRAME_MSEC) % 4 === 0) this.trail.push([this.time, o[0], o[1], o[2]]);
    }
  }
  speed() { return Math.hypot(this.p.velocity[0], this.p.velocity[1]); }
}

// TrackMania's medals from the author time (the best validated run): gold
// within 6%, silver 20%, bronze 50%, each rounded up to a tenth.
export function medals(authorMs) {
  const up = (x) => Math.ceil(x / 100) * 100;
  return { author: authorMs, gold: up(authorMs * 1.06), silver: up(authorMs * 1.2), bronze: up(authorMs * 1.5) };
}

export function fmtMs(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(6, "0");
  return m ? `${m}:${rest}` : (s).toFixed(3);
}

// A driver that follows the centre line at run speed and jumps each gap from
// its lip: the editor's "Ride it" made physical, and the tests' proof that a
// course can be finished at all. It never strafe-jumps and never dashes or
// wall-jumps, so a course that needs those will (rightly) beat it.
export function autopilot(course, { ahead = 96 } = {}) {
  const route = course.route;
  const lips = course.landmarks.filter(([k]) => k === "gap").map(([, pos, h]) => ({ pos, h }));
  let k = 0;   // the centre-line segment the player is on (route[k] -> route[k + 1])
  return (run) => {
    const o = run.p.origin;
    // Move on to the next segment once the player is past this one's end,
    // measured along this one (a slalom's line zig-zags, so the next
    // segment's direction says nothing about whether this gate is cleared).
    let t = 0;
    for (;;) {
      const [ax, ay] = route[k], [bx, by] = route[Math.min(k + 1, route.length - 1)];
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
      t = L2 ? ((o[0] - ax) * (bx - ax) + (o[1] - ay) * (by - ay)) / L2 : 1;
      if (t >= 1 && k < route.length - 2) k++;
      else break;
    }
    // Aim `ahead` units further along the line from the player's place on it.
    const [ax, ay] = route[k], [bx, by] = route[Math.min(k + 1, route.length - 1)];
    const c = Math.max(0, Math.min(1, t));
    let px = ax + (bx - ax) * c, py = ay + (by - ay) * c;
    let left = ahead, tx = bx, ty = by;
    for (let j = k; j < route.length - 1 && left > 0; j++) {
      const [qx, qy] = route[j + 1];
      const seg = Math.hypot(qx - px, qy - py);
      if (seg >= left) { tx = px + ((qx - px) * left) / seg; ty = py + ((qy - py) * left) / seg; break; }
      left -= seg;
      [px, py] = [qx, qy];
      [tx, ty] = [qx, qy];
    }
    const yaw = (Math.atan2(ty - o[1], tx - o[0]) * 180) / Math.PI;
    // Jump at a lip: within 24 units before it, facing across it.
    const jump = run.p.ground && lips.some(({ pos, h }) => {
      const hr = (h * Math.PI) / 180;
      const d = (pos[0] - o[0]) * Math.cos(hr) + (pos[1] - o[1]) * Math.sin(hr);
      const side = Math.abs(-(pos[0] - o[0]) * Math.sin(hr) + (pos[1] - o[1]) * Math.cos(hr));
      return d > 0 && d < 28 && side < 400 && Math.abs(o[2] - 24 - pos[2]) < 40;
    });
    return { forward: 1, side: 0, yaw, pitch: 0, jump, special: false };
  };
}
