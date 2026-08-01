// Replay a Warsow/Warfork SERVER autorecord demo (.wd / .wdz20) to recover the
// runs it contains — and, crucially, to RECOMPUTE the per-run air-strafe quality
// that the live pipeline measures in AngelScript but never writes into the file.
//
// Why this exists alongside web/demo-meta.mjs:
//   * demo-meta.mjs reads the demo METADATA BLOCK (matchname / matchscore). That
//     is written by SV_Demo_Stop for a per-run CLIENT demo, so a client upload
//     names its runner and time in a few hundred bytes.
//   * A server autorecord ("<date>_<gametype>_<map>_auto<NNNN>.wdz20", multipov)
//     has NO matchname/matchscore — configstrings 22/23 are never set — so
//     parseDemoMeta() rejects it outright. Everything about the runs is instead
//     spread through the recorded network stream.
// This module therefore decodes the stream itself: the container framing, the
// configstrings (player names), the gamecommands (starts, finishes, times,
// awards) and the per-frame playerstates (velocity, view yaw, pressed keys,
// pmove flags) that the strafe sampler needs.
//
// Wire format is a literal port of the engine this project builds against
// (github.com/DenMSC/racemod_2.1, branch race-demos):
//   qcommon/snap_demos.c   — 4-byte LE length-prefixed messages, -1 = EOF
//   qcommon/snap_read.c    — SNAP_ParseFrame / ParsePlayerstate / ParsePacketEntities
//   qcommon/msg.c          — MSG_Read* primitives and the delta field tables
//   client/cl_parse.c      — the svc_* dispatch
// The field ORDER in a playerstate deliberately differs from the flag-bit order
// in two places (pm_flags right after pm_time; gravity after viewangles) and the
// trailing stats block is unconditional — get any of those wrong and the walk
// desyncs silently rather than erroring, so parseFrame() asserts the body ends
// exactly where the frame header said it would.
//
// FIDELITY — read this before trusting a recomputed strafe number:
//   * velocity, view yaw and pressed keys are recovered EXACTLY. pmove snaps
//     velocity to 1/16 in memory (gs_pmove.c PM_SnapPosition) and the wire uses
//     that same 1/16, so the bytes here are bit-identical to the `ent.velocity`
//     the AngelScript sampler read. Yaw already lives on the 16-bit angle
//     lattice. plrkeys is only ever refreshed at snapshot rate anyway, so the
//     62.5 Hz sampler was reading exactly the mask we see.
//   * SAMPLE RATE is the real loss. sampleStrafe() runs every game frame
//     (WORLDFRAMETIME = 16 ms); a demo carries one sample per snapshot
//     (snapFrameTime = 1000/sv_pps — 50 ms in demos recorded at sv_pps 20,
//     25 ms at the current sv_pps 40). Every demo sample IS a real sampler
//     frame, just a subset of them. Averaging efficiency over a coarser window
//     scores HIGHER, because the ideal-gain curve is concave in dt and because
//     the per-frame [0,1] clamp does not commute with lumping frames together.
//     idealGain() below removes the concavity term analytically; the clamp term
//     is not reconstructible and leaves a small residual inflation.
//   * onStrafeGround() is an 8-unit downward box trace against the BSP, which is
//     also true while HOVERING within 8 units of the floor. We only have
//     PMF_ON_GROUND ("standing"), so frames straddling ground contact are
//     scored where the live sampler skipped them. Negligible on air maps, more
//     on ground-heavy ones — replayDemo reports the spread so a caller can see it.
//
// CLI:
//   node demo-replay.mjs <demo.wdz20>            -> JSON summary of every run
//   node demo-replay.mjs --best <demo.wdz20>     -> JSON for the fastest run only
//   node demo-replay.mjs --frames <demo.wdz20>   -> parser stats, for debugging

import fs from "node:fs";
import zlib from "node:zlib";

// --- engine constants -------------------------------------------------------
// svc_* opcodes — qcommon/qcommon.h enum svc_ops_e, in declaration order.
const SVC = {
  bad: 0, nop: 1, servercmd: 2, serverdata: 3, spawnbaseline: 4, download: 5,
  playerinfo: 6, packetentities: 7, gamecommands: 8, match: 9, clcack: 10,
  servercs: 11, frame: 12, demoinfo: 13, extension: 14,
};

const PM_VECTOR_SNAP = 16;                 // gameshared/q_comref.h
const MAX_EDICTS = 1024;
const MAX_ITEMS = 64;
const PS_MAX_STATS = 64;
const PM_STAT_SIZE = 16;
const SNAP_STATS_LONGS = (PS_MAX_STATS + 31) >> 5;
const SNAP_INVENTORY_LONGS = (MAX_ITEMS + 31) >> 5;
const UPDATE_BACKUP = 32, UPDATE_MASK = UPDATE_BACKUP - 1;
const SNAP_MAX_DEMO_META_DATA_SIZE = 16 * 1024;
const MAX_MSGLEN = 32768;

// player_state_t delta flags (qcommon/qcommon.h). MOREBITS chain the header out
// to 4 bytes; a field absent from the flags keeps its previous (delta) value.
const PS_M_TYPE = 1 << 0, PS_M_ORIGIN0 = 1 << 1, PS_M_ORIGIN1 = 1 << 2, PS_M_ORIGIN2 = 1 << 3;
const PS_M_VELOCITY0 = 1 << 4, PS_M_VELOCITY1 = 1 << 5, PS_M_VELOCITY2 = 1 << 6, PS_MOREBITS1 = 1 << 7;
const PS_M_TIME = 1 << 8, PS_EVENT = 1 << 9, PS_EVENT2 = 1 << 10, PS_WEAPONSTATE = 1 << 11;
const PS_INVENTORY = 1 << 12, PS_FOV = 1 << 13, PS_VIEWANGLES = 1 << 14, PS_MOREBITS2 = 1 << 15;
const PS_POVNUM = 1 << 16, PS_VIEWHEIGHT = 1 << 17, PS_PMOVESTATS = 1 << 18;
const PS_M_FLAGS = 1 << 19, PS_PLRKEYS = 1 << 20, PS_MOREBITS3 = 1 << 23;
const PS_M_GRAVITY = 1 << 24, PS_M_DELTA_ANGLES0 = 1 << 25, PS_M_DELTA_ANGLES1 = 1 << 26;
const PS_M_DELTA_ANGLES2 = 1 << 27, PS_PLAYERNUM = 1 << 28;

// entity_state_t delta flags (qcommon/msg.c).
const U_ORIGIN1 = 1 << 0, U_ORIGIN2 = 1 << 1, U_ORIGIN3 = 1 << 2, U_ANGLE1 = 1 << 3;
const U_ANGLE2 = 1 << 4, U_EVENT = 1 << 5, U_REMOVE = 1 << 6, U_MOREBITS1 = 1 << 7;
const U_NUMBER16 = 1 << 8, U_FRAME8 = 1 << 9, U_SVFLAGS = 1 << 10, U_MODEL = 1 << 11;
const U_TYPE = 1 << 12, U_OTHERORIGIN = 1 << 13, U_SKIN8 = 1 << 14, U_MOREBITS2 = 1 << 15;
const U_EFFECTS8 = 1 << 16, U_WEAPON = 1 << 17, U_SOUND = 1 << 18, U_MODEL2 = 1 << 19;
const U_LIGHT = 1 << 20, U_SOLID = 1 << 21, U_EVENT2 = 1 << 22, U_MOREBITS3 = 1 << 23;
const U_SKIN16 = 1 << 24, U_ANGLE3 = 1 << 25, U_ATTENUATION = 1 << 26, U_EFFECTS16 = 1 << 27;
const U_FRAME16 = 1 << 29, U_TEAM = 1 << 30;
const ET_INVERSE = 128, EV_INVERSE = 128, SOLID_BMODEL = 31;

const FRAMESNAP_FLAG_DELTA = 1 << 0, FRAMESNAP_FLAG_MULTIPOV = 1 << 2;
const SV_BITFLAGS_RELIABLE = 1 << 1, SV_BITFLAGS_HTTP = 1 << 3, SV_BITFLAGS_HTTP_BASEURL = 1 << 4;

const PMF_ON_GROUND = 1 << 2;
const PM_STAT_MAXSPEED = 9;                // index into pmove.stats

// plrkeys bits (KEYICON_*, gameshared/q_comref.h). Built from the SIGN of the
// usercmd's forwardmove/sidemove in p_client.cpp ClientMakePlrkeys — the same
// net-intent encoding sampleStrafe()'s Key_* tests rely on.
const Key_Forward = 1 << 0, Key_Left = 1 << 2, Key_Right = 1 << 3;

// Configstring bases for this build, derived from the MAX_* sizes in
// gameshared/q_shared.h + q_comref.h.
const CS_HOSTNAME = 0, CS_MAPNAME = 6, CS_GAMETYPENAME = 12;
const CS_SCB_PLAYERTAB_LAYOUT = 16, CS_SCB_PLAYERTAB_TITLES = 17;
const CS_MATCHNAME = 22, CS_MATCHSCORE = 23;
const CS_PLAYERINFOS = 2912, MAX_CLIENTS_CS = 256;

// hrace/player.as sampleStrafe() constants — keep in lockstep with the mod.
const STRAFE_MIN_SPEED = 600;
const STRAFE_IMPULSE_FACTOR = 3;
// server/sv_main.c: the fixed game-frame period the live sampler runs at.
const WORLDFRAMETIME = 16;

const SHORT2ANGLE = (x) => x * (360.0 / 65536);
// AngelScript's float is 32-bit; Math.fround keeps the arithmetic on the same
// lattice so a port doesn't drift from the mod in the last digits.
const f32 = Math.fround;

// --- msg.c primitives -------------------------------------------------------
// Little-endian throughout. Signedness matters: MSG_ReadShort casts to (short),
// which is what makes the -1 gamecommand terminator work.
class Msg {
  constructor(buf) { this.b = buf; this.p = 0; }
  get left() { return this.b.length - this.p; }
  need(n) { if (this.p + n > this.b.length) throw new Error(`msg overrun at ${this.p}+${n}/${this.b.length}`); }
  byte() { this.need(1); return this.b[this.p++]; }
  char() { this.need(1); return this.b.readInt8(this.p++); }
  short() { this.need(2); const v = this.b.readInt16LE(this.p); this.p += 2; return v; }
  ushort() { return this.short() & 0xffff; }
  long() { this.need(4); const v = this.b.readInt32LE(this.p); this.p += 4; return v; }
  int3() {                                  // MSG_ReadInt3, sign-extended 24-bit
    this.need(3);
    const b = this.b, p = this.p; this.p += 3;
    let v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    if (b[p + 2] & 0x80) v |= ~0xffffff;
    return v;
  }
  string() {                                // MSG_ReadString: NUL-terminated, capped
    let s = "";
    for (let i = 0; i < 2047 && this.p < this.b.length; i++) {
      const c = this.b[this.p++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  skip(n) { this.p += n; }
  coord() { return this.int3() / PM_VECTOR_SNAP; }      // MSG_ReadCoord
  angle() { return this.byte() * (360.0 / 256); }       // MSG_ReadAngle
  angle16() { return SHORT2ANGLE(this.short()); }       // MSG_ReadAngle16
  pos() { return [this.coord(), this.coord(), this.coord()]; }
}

// --- player_state_t ---------------------------------------------------------
function newPlayerState() {
  return {
    pm_type: 0, origin: [0, 0, 0], velocity: [0, 0, 0], pm_time: 0, pm_flags: 0,
    delta_angles: [0, 0, 0], gravity: 0, pmstats: new Int16Array(PM_STAT_SIZE),
    viewangles: [0, 0, 0], event: [0, 0], eventParm: [0, 0],
    POVnum: 0, playerNum: 0, viewheight: 0, fov: 0, weaponState: 0,
    inventory: new Int32Array(MAX_ITEMS), stats: new Int16Array(PS_MAX_STATS), plrkeys: 0,
  };
}
function clonePlayerState(s) {
  return {
    ...s, origin: s.origin.slice(), velocity: s.velocity.slice(),
    delta_angles: s.delta_angles.slice(), viewangles: s.viewangles.slice(),
    event: s.event.slice(), eventParm: s.eventParm.slice(),
    pmstats: s.pmstats.slice(), inventory: s.inventory.slice(), stats: s.stats.slice(),
  };
}

// SNAP_ParsePlayerstate (qcommon/snap_read.c). See the header note about the
// two out-of-bit-order fields and the unconditional trailing stats block.
function parsePlayerstate(m, old) {
  const st = old ? clonePlayerState(old) : newPlayerState();

  let flags = m.byte();
  if (flags & PS_MOREBITS1) flags |= m.byte() << 8;
  if (flags & PS_MOREBITS2) flags |= m.byte() << 16;
  if (flags & PS_MOREBITS3) flags |= m.byte() << 24;
  flags = flags >>> 0;

  if (flags & PS_M_TYPE) st.pm_type = m.byte();
  if (flags & PS_M_ORIGIN0) st.origin[0] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_ORIGIN1) st.origin[1] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_ORIGIN2) st.origin[2] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_VELOCITY0) st.velocity[0] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_VELOCITY1) st.velocity[1] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_VELOCITY2) st.velocity[2] = m.int3() / PM_VECTOR_SNAP;
  if (flags & PS_M_TIME) st.pm_time = m.byte();
  if (flags & PS_M_FLAGS) st.pm_flags = m.short();
  if (flags & PS_M_DELTA_ANGLES0) st.delta_angles[0] = m.short();
  if (flags & PS_M_DELTA_ANGLES1) st.delta_angles[1] = m.short();
  if (flags & PS_M_DELTA_ANGLES2) st.delta_angles[2] = m.short();

  if (flags & PS_EVENT) {
    const e = m.byte();
    st.eventParm[0] = (e & EV_INVERSE) ? m.byte() : 0;
    st.event[0] = e & ~EV_INVERSE;
  } else { st.event[0] = 0; st.eventParm[0] = 0; }
  if (flags & PS_EVENT2) {
    const e = m.byte();
    st.eventParm[1] = (e & EV_INVERSE) ? m.byte() : 0;
    st.event[1] = e & ~EV_INVERSE;
  } else { st.event[1] = 0; st.eventParm[1] = 0; }

  if (flags & PS_VIEWANGLES) {              // all-or-none, 3 x MSG_ReadAngle16
    st.viewangles[0] = m.angle16();
    st.viewangles[1] = m.angle16();
    st.viewangles[2] = m.angle16();
  }

  if (flags & PS_M_GRAVITY) st.gravity = m.short();
  if (flags & PS_WEAPONSTATE) st.weaponState = m.byte();
  if (flags & PS_FOV) st.fov = m.byte();
  if (flags & PS_POVNUM) st.POVnum = m.byte();
  if (flags & PS_PLAYERNUM) st.playerNum = m.byte();
  if (flags & PS_VIEWHEIGHT) st.viewheight = m.char();

  if (flags & PS_PMOVESTATS) {
    const bits = m.ushort();
    for (let i = 0; i < PM_STAT_SIZE; i++) if (bits & (1 << i)) st.pmstats[i] = m.short();
  }
  if (flags & PS_INVENTORY) {
    const inv = [];
    for (let i = 0; i < SNAP_INVENTORY_LONGS; i++) inv.push(m.long());
    for (let i = 0; i < MAX_ITEMS; i++) if (inv[i >> 5] & (1 << (i & 31))) st.inventory[i] = m.byte();
  }
  if (flags & PS_PLRKEYS) st.plrkeys = m.byte();

  const sb = [];
  for (let i = 0; i < SNAP_STATS_LONGS; i++) sb.push(m.long());
  for (let i = 0; i < PS_MAX_STATS; i++) if (sb[i >> 5] & (1 << (i & 31))) st.stats[i] = m.short();

  return st;
}

// --- entity_state_t ---------------------------------------------------------
// Entities are parsed only to keep the frame walk in sync — nothing in this
// module reads them. (The engine does smuggle player velocity through origin2
// for spectated players, but playerstate velocity is authoritative, so we let
// that channel lie unused.)
function newEntityState(number = 0) {
  return {
    number, svflags: 0, type: 0, linearMovement: false, linearMovementVelocity: [0, 0, 0],
    origin: [0, 0, 0], angles: [0, 0, 0], origin2: [0, 0, 0], modelindex: 0, modelindex2: 0,
    frame: 0, skinnum: 0, attenuation: 0, weapon: 0, teleported: false, effects: 0,
    solid: 0, sound: 0, events: [0, 0], eventParms: [0, 0], light: 0,
    linearMovementTimeStamp: 0, team: 0,
  };
}
function cloneEntityState(s) {
  return {
    ...s, linearMovementVelocity: s.linearMovementVelocity.slice(), origin: s.origin.slice(),
    angles: s.angles.slice(), origin2: s.origin2.slice(), events: s.events.slice(),
    eventParms: s.eventParms.slice(),
  };
}

function readEntityBits(m) {                // MSG_ReadEntityBits
  let total = m.byte();
  if (total & U_MOREBITS1) total |= (m.byte() << 8) & 0x0000ff00;
  if (total & U_MOREBITS2) total |= (m.byte() << 16) & 0x00ff0000;
  if (total & U_MOREBITS3) total |= (m.byte() << 24) & 0xff000000;
  total = total >>> 0;
  const number = (total & U_NUMBER16) ? m.short() : m.byte();
  return { number, bits: total };
}

// MSG_ReadDeltaEntity. Field order differs from bit order; SOLID must be read
// before ANGLE* (SOLID_BMODEL selects 16-bit angles), and U_LIGHT doubles as
// linearMovementTimeStamp when U_TYPE carried ET_INVERSE.
function readDeltaEntity(m, from, number, bits) {
  const to = cloneEntityState(from);
  to.number = number;

  if (bits & U_TYPE) { const t = m.byte(); to.type = t & ~ET_INVERSE; to.linearMovement = !!(t & ET_INVERSE); }
  if (bits & U_SOLID) to.solid = m.short();
  if (bits & U_MODEL) to.modelindex = m.short();
  if (bits & U_MODEL2) to.modelindex2 = m.short();
  if (bits & U_FRAME8) to.frame = m.byte();
  if (bits & U_FRAME16) to.frame = m.short();

  if ((bits & U_SKIN8) && (bits & U_SKIN16)) to.skinnum = m.long();
  else if (bits & U_SKIN8) to.skinnum = m.byte();
  else if (bits & U_SKIN16) to.skinnum = m.short();

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) to.effects = m.long();
  else if (bits & U_EFFECTS8) to.effects = m.byte();
  else if (bits & U_EFFECTS16) to.effects = m.short();

  if (to.linearMovement) {
    if (bits & U_ORIGIN1) to.linearMovementVelocity[0] = m.coord();
    if (bits & U_ORIGIN2) to.linearMovementVelocity[1] = m.coord();
    if (bits & U_ORIGIN3) to.linearMovementVelocity[2] = m.coord();
  } else {
    if (bits & U_ORIGIN1) to.origin[0] = m.coord();
    if (bits & U_ORIGIN2) to.origin[1] = m.coord();
    if (bits & U_ORIGIN3) to.origin[2] = m.coord();
  }

  if (bits & U_ANGLE1) to.angles[0] = to.solid === SOLID_BMODEL ? m.angle16() : m.angle();
  if (bits & U_ANGLE2) to.angles[1] = to.solid === SOLID_BMODEL ? m.angle16() : m.angle();
  if (bits & U_ANGLE3) to.angles[2] = to.solid === SOLID_BMODEL ? m.angle16() : m.angle();

  if (bits & U_OTHERORIGIN) to.origin2 = m.pos();
  if (bits & U_SOUND) to.sound = m.short();

  if (bits & U_EVENT) {
    const e = m.byte();
    to.eventParms[0] = (e & EV_INVERSE) ? m.byte() : 0;
    to.events[0] = e & ~EV_INVERSE;
  } else { to.events[0] = 0; to.eventParms[0] = 0; }
  if (bits & U_EVENT2) {
    const e = m.byte();
    to.eventParms[1] = (e & EV_INVERSE) ? m.byte() : 0;
    to.events[1] = e & ~EV_INVERSE;
  } else { to.events[1] = 0; to.eventParms[1] = 0; }

  if (bits & U_ATTENUATION) to.attenuation = m.byte() / 16.0;
  if (bits & U_WEAPON) { const w = m.byte(); to.weapon = w & ~0x80; to.teleported = !!(w & 0x80); }
  if (bits & U_SVFLAGS) to.svflags = m.short();
  if (bits & U_LIGHT) { if (to.linearMovement) to.linearMovementTimeStamp = m.long() >>> 0; else to.light = m.long(); }
  if (bits & U_TEAM) to.team = m.byte();

  return to;
}

// --- container walk ---------------------------------------------------------
// A .wdz20 is N concatenated gzip members (the engine flushes each demo write as
// its own member); gunzipSync consumes them all in one pass.
function gunzipAll(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;                                  // already-raw stream (tests)
}

// key\0value\0..., with the writer stripping the FINAL NUL
// (snap_demos.c: `if (realsize > 0) realsize--;`), so append a virtual one.
function parseMetaBlock(buf) {
  const parts = (buf.toString("latin1") + "\0").split("\0");
  const meta = {};
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) meta[parts[i]] = parts[i + 1];
  return meta;
}

// A reliable command is a raw console line; the only ones that matter in a demo
// are configstring assignments. RACE_UpdateHUDTopScores batches SIX assignments
// into one command ('cs 3744 "" 3744 "#1 ..." 3745 ...'), so match repeatedly
// rather than anchoring the regex at end-of-string.
function applyServerCommand(out, s) {
  if (!s.startsWith("cs ")) return;
  const re = /(\d+)\s+"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(s)) !== null) out.configstrings.set(Number(mm[1]), mm[2]);
}

// SNAP_ParseFrame / SNAP_ParseFrameHeader (qcommon/snap_read.c).
function parseFrame(m, out, backup, baselines) {
  const len = m.ushort();
  const end = m.p + len;

  const serverTime = m.long() >>> 0;
  const snapNum = m.long();
  const deltaFrameNum = m.long();
  m.long();                                    // ucmdExecuted
  const flags = m.byte();
  m.byte();                                    // suppressCount

  const delta = !!(flags & FRAMESNAP_FLAG_DELTA);
  const multipov = !!(flags & FRAMESNAP_FLAG_MULTIPOV);
  const deltaframe = delta && deltaFrameNum > 0 ? backup[deltaFrameNum & UPDATE_MASK] : null;

  const frame = { serverTime, snapNum, playerStates: [], entities: [] };

  // svc_gamecommands: { int16 framediff; string; [multipov: byte n + n bytes] }*
  let c = m.byte();
  if (c !== SVC.gamecommands) throw new Error(`frame ${snapNum}: expected svc_gamecommands, got ${c}`);
  for (;;) {
    const framediff = m.short();
    if (framediff === -1) break;
    const text = m.string();
    let targets = null;                        // null == broadcast (0 means everyone)
    if (multipov) {
      const nbytes = m.byte();
      if (nbytes) {
        targets = [];
        for (let i = 0; i < nbytes; i++) {
          const b = m.byte();
          for (let bit = 0; bit < 8; bit++) if (b & (1 << bit)) targets.push(i * 8 + bit);
        }
      }
    }
    const tok = tokenize(text);
    out.events.push({
      serverTime, snapNum, framediff, cmd: tok[0] || "", args: tok.slice(1), text, targets,
    });
  }

  const areabytes = m.byte();                  // areabits
  m.skip(areabytes);

  c = m.byte();                                // svc_match + delta gamestate
  if (c !== SVC.match) throw new Error(`frame ${snapNum}: expected svc_match, got ${c}`);
  const gsLongBits = m.byte();
  const gsStatBits = m.ushort();
  for (let i = 0; i < 8; i++) if (gsLongBits & (1 << i)) m.long();
  for (let i = 0; i < 16; i++) if (gsStatBits & (1 << i)) m.short();

  // One svc_playerinfo per POV, terminated by a 0 byte. Deltas are by ARRAY
  // INDEX, not by client slot: snap_write.c deltas from ps[i] when
  // `oldframe->numplayers > i`. (The stock reader uses `>=`, an off-by-one that
  // can only carry a stale VALUE, never shift a parse position — we implement
  // the writer's, which is the ground truth.) Identity comes from playerNum,
  // which the server stamps explicitly.
  let np = 0;
  for (;;) {
    c = m.byte();
    if (c === 0) break;
    if (c !== SVC.playerinfo) throw new Error(`frame ${snapNum}: expected svc_playerinfo, got ${c}`);
    const old = deltaframe && deltaframe.playerStates.length > np ? deltaframe.playerStates[np] : null;
    frame.playerStates.push(parsePlayerstate(m, old));
    np++;
  }

  c = m.byte();
  if (c !== SVC.packetentities) throw new Error(`frame ${snapNum}: expected svc_packetentities, got ${c}`);
  parsePacketEntities(m, deltaframe, frame, baselines);

  // The header's length is the desync tripwire: a mis-ordered or mis-sized
  // field lands us somewhere else entirely, and silently wrong samples are far
  // worse than a hard failure.
  if (m.p !== end) throw new Error(`frame ${snapNum}: body ended at ${m.p}, header said ${end}`);

  backup[snapNum & UPDATE_MASK] = frame;
  out.stats.frames++;

  // Compact per-player row: everything sampleStrafe needs, nothing else.
  out.frames.push({
    serverTime, snapNum,
    ps: frame.playerStates.map((s) => ({
      playerNum: s.playerNum, POVnum: s.POVnum,
      vx: s.velocity[0], vy: s.velocity[1], vz: s.velocity[2],
      yaw: s.viewangles[1],
      keys: s.plrkeys, pm_flags: s.pm_flags, pm_type: s.pm_type,
      maxspeed: s.pmstats[PM_STAT_MAXSPEED],
    })),
  });
}

// SNAP_ParsePacketEntities (qcommon/snap_read.c).
function parsePacketEntities(m, oldframe, newframe, baselines) {
  const oldEnts = oldframe ? oldframe.entities : [];
  let oldindex = 0;
  let oldstate = oldEnts.length ? oldEnts[0] : null;
  let oldnum = oldstate ? oldstate.number : 99999;
  const advance = () => {
    oldindex++;
    if (oldindex >= oldEnts.length) { oldnum = 99999; oldstate = null; }
    else { oldstate = oldEnts[oldindex]; oldnum = oldstate.number; }
  };

  for (;;) {
    const { number: newnum, bits } = readEntityBits(m);
    if (newnum >= MAX_EDICTS) throw new Error(`bad entity number ${newnum}`);
    if (!newnum) break;
    while (oldnum < newnum) { newframe.entities.push(readDeltaEntity(m, oldstate, oldnum, 0)); advance(); }
    if (oldnum > newnum) {
      if (bits & U_REMOVE) continue;
      newframe.entities.push(readDeltaEntity(m, baselines[newnum], newnum, bits));
      continue;
    }
    if (bits & U_REMOVE) { advance(); continue; }
    newframe.entities.push(readDeltaEntity(m, oldstate, newnum, bits));
    advance();
  }
  while (oldnum !== 99999) { newframe.entities.push(readDeltaEntity(m, oldstate, oldnum, 0)); advance(); }
}

// Walk the whole decompressed stream. Throws on anything it cannot account for
// — a demo we only half-understand must not silently yield half a run.
export function decodeDemo(rawBuf) {
  const raw = gunzipAll(rawBuf);

  const baselines = new Array(MAX_EDICTS);
  for (let i = 0; i < MAX_EDICTS; i++) baselines[i] = newEntityState(i);
  const backup = new Array(UPDATE_BACKUP).fill(null);   // delta ring, like cl.snapShots

  const out = {
    rawBytes: raw.length, meta: {}, serverdata: null,
    configstrings: new Map(),
    frames: [], events: [],
    stats: { messages: 0, frames: 0, sawEofMarker: false, walkEnd: 0 },
  };

  let reliable = true;                         // until svc_serverdata says otherwise
  let pos = 0;
  for (;;) {
    if (pos + 4 > raw.length) break;
    const msglen = raw.readInt32LE(pos);
    if (msglen === -1) { out.stats.sawEofMarker = true; pos += 4; break; }
    if (msglen <= 0 || msglen > MAX_MSGLEN) throw new Error(`bad msglen ${msglen} at ${pos}`);
    if (pos + 4 + msglen > raw.length) throw new Error(`truncated message at ${pos} (len ${msglen})`);
    const m = new Msg(raw.subarray(pos + 4, pos + 4 + msglen));
    pos += 4 + msglen;
    out.stats.messages++;

    while (m.left > 0) {
      const cmd = m.byte();
      switch (cmd) {
        case SVC.demoinfo: {
          m.long();                            // demoinfo length
          m.long();                            // meta_data_ofs (always 0)
          const realsize = m.long() >>> 0;
          const maxsize = m.long() >>> 0;
          const n = Math.min(realsize, maxsize, SNAP_MAX_DEMO_META_DATA_SIZE);
          out.meta = parseMetaBlock(m.b.subarray(m.p, m.p + n));
          m.skip(maxsize);
          break;
        }
        case SVC.serverdata: {
          const sd = {
            protocol: m.long(), spawncount: m.long(), snapFrameTime: m.ushort(),
            basegame: m.string(), game: m.string(), playernum: m.short(),
            levelname: m.string(), bitflags: m.byte(), pure: [],
          };
          reliable = !!(sd.bitflags & SV_BITFLAGS_RELIABLE);
          if (sd.bitflags & SV_BITFLAGS_HTTP) {
            if (sd.bitflags & SV_BITFLAGS_HTTP_BASEURL) sd.baseurl = m.string();
            else sd.httpPort = m.short();
          }
          const numpure = m.short();
          for (let i = 0; i < numpure; i++) sd.pure.push({ file: m.string(), checksum: m.long() });
          out.serverdata = sd;
          break;
        }
        case SVC.servercmd:
          if (!reliable) m.long();             // cmdNum, only when unreliable
          applyServerCommand(out, m.string());
          break;
        case SVC.servercs:                     // demo configstrings, never acknowledged
          applyServerCommand(out, m.string());
          break;
        case SVC.spawnbaseline: {
          const { number, bits } = readEntityBits(m);
          baselines[number] = readDeltaEntity(m, newEntityState(), number, bits);
          break;
        }
        case SVC.frame:
          parseFrame(m, out, backup, baselines);
          break;
        case SVC.nop:
          break;
        case SVC.clcack:
          m.long(); m.long();
          break;
        case SVC.extension: {
          m.byte(); m.byte(); const len = m.ushort(); m.skip(len);
          break;
        }
        default:
          throw new Error(`unhandled svc ${cmd} in message ${out.stats.messages}`);
      }
    }
    if (m.left !== 0) throw new Error(`message ${out.stats.messages} not fully consumed (${m.left} left)`);
  }
  out.stats.walkEnd = pos;
  return out;
}

// --- text helpers -----------------------------------------------------------
// Cmd_TokenizeString-ish: whitespace separated, double quotes group.
export function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] <= " ") i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) { out.push(s.slice(i + 1)); break; }
      out.push(s.slice(i + 1, j)); i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] > " ") j++;
      out.push(s.slice(i, j)); i = j;
    }
  }
  return out;
}
const stripColor = (s) => s.replace(/\^[0-9]/g, "");
function parseRaceTime(s) {                    // "MM:SS.mmm" -> ms
  const mm = /(\d+):(\d\d)\.(\d{1,3})/.exec(s);
  return mm ? Number(mm[1]) * 60000 + Number(mm[2]) * 1000 + Number(mm[3].padEnd(3, "0")) : null;
}

// --- the strafe sampler, ported ---------------------------------------------
// DIAGNOSTIC ONLY — not the stored value. See idealGainSingleStep.
//
// The closed form is concave in dt, so one 50 ms step yields less than three
// chained 16 ms steps; sub-stepping at WORLDFRAMETIME removes that one term.
// It is NOT used for the stored metric, because removing a single term of a
// multi-term bias is not a correction: a pmove-accurate simulation of the whole
// estimator (per-frame gates, the q<=1 clamp, and the concavity together) puts
// the lumped reading anywhere from 5 points low to 1 point high depending on
// strafing style, mean ~1 point LOW — the opposite direction from concavity
// alone. Reported alongside the metric so the spread stays visible.
export function idealGain(prev, base, dtSec, stepMs = WORLDFRAMETIME) {
  const step = stepMs / 1000;
  let v = prev;
  let remaining = dtSec;
  // Guard a pathological dt (a stalled server, a demo splice) from spinning.
  for (let i = 0; remaining > 1e-9 && i < 4096; i++) {
    const h = Math.min(step, remaining);
    const a = f32(base * h);
    v = f32(Math.sqrt(v * v + a * (2 * base - a)));
    remaining -= h;
  }
  return f32(v - prev);
}

// The stored metric's denominator: literally what sampleStrafe() evaluates,
// once, with dt = the interval between the two samples being compared. Chosen
// over any "correction" because it is the mod's own formula rather than a model
// of it — the residual sampling error is real but unbiased enough in sign that
// modelling it adds more error than it removes (see idealGain).
export function idealGainSingleStep(prev, base, dtSec) {
  const a = f32(base * dtSec);
  return f32(f32(Math.sqrt(prev * prev + a * (2 * base - a))) - prev);
}

// Port of Player.sampleStrafe() (hrace/player.as), gate for gate in the same
// order, over a run's demo samples. `groundFn(samples, i)` stands in for
// onStrafeGround(); `gainFn` selects the ideal-gain denominator.
export function strafeQuality(samples, { groundFn, gainFn = idealGainSingleStep, keyLag = 1 } = {}) {
  let sum = 0, weight = 0;                     // AS: double accumulators
  let have = false, prevSpeed = 0, prevYaw = 0;
  const rejected = { keys: 0, yaw: 0, slow: 0, ground: 0, impulse: 0, degenerate: 0 };
  let sampled = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dt = i === 0 ? 0 : f32((s.t - samples[i - 1].t) / 1000);
    const cur = f32(Math.sqrt(s.vx * s.vx + s.vy * s.vy));   // HorizontalSpeed(ent.velocity)
    const curYaw = f32(s.yaw);                               // ent.angles.y

    // AS returns early when frameTime <= 0; the first sample of a run only
    // seeds the baseline speed + yaw.
    if (dt <= 0 || !have) { prevSpeed = cur; prevYaw = curYaw; have = true; continue; }

    const prev = prevSpeed, pYaw = prevYaw;
    prevSpeed = cur; prevYaw = curYaw;         // baseline advances even on rejected frames

    // Forward held together with exactly one side key. These bits come from the
    // SIGN of forwardmove/sidemove, so they already encode net intent: holding
    // both sides zeroes sidemove and sets neither bit.
    //
    // KEY PHASE (keyLag): ps.plrkeys has exactly one per-frame assignment —
    // p_view.cpp:480, inside G_ClientEndSnapFrame, which runs from SnapFrame
    // AFTER that interval's game frames (sv_main.c: ge->RunFrame() then
    // ge->SnapFrame()). So the mask stored in snapshot k is the one the live
    // sampler read while running the game frames of (t_k, t_k+1] — i.e. the
    // mask belonging to THIS interval is the PREVIOUS snapshot's. Pairing
    // s.keys with the velocity delta that precedes it is off by one snapshot
    // and scores ~1.9 points high, because the frames at direction switches
    // (where quality is genuinely poor) stop being rejected.
    const kSrc = i - keyLag >= 0 ? samples[i - keyLag] : s;
    const k = kSrc.keys;
    const holdLeft = (k & Key_Left) !== 0, holdRight = (k & Key_Right) !== 0;
    if ((k & Key_Forward) === 0) { rejected.keys++; continue; }
    if (holdLeft === holdRight) { rejected.keys++; continue; }

    // ...and the mouse turning INTO that side key — that pairing IS the strafe.
    // Warsow yaw increases counter-clockwise, so strafing right wants a negative
    // shortest-arc delta and left a positive one; a still mouse is not strafing.
    let yawDelta = f32(curYaw - pYaw);
    while (yawDelta > 180) yawDelta = f32(yawDelta - 360);
    while (yawDelta < -180) yawDelta = f32(yawDelta + 360);
    if (holdRight && yawDelta >= 0) { rejected.yaw++; continue; }
    if (holdLeft && yawDelta <= 0) { rejected.yaw++; continue; }

    if (prev < STRAFE_MIN_SPEED) { rejected.slow++; continue; }
    if (groundFn(samples, i)) { rejected.ground++; continue; }

    const base = f32(s.maxspeed);              // client.pmoveMaxSpeed
    const maxGain = gainFn(prev, base, dt);
    if (maxGain <= 0.001) { rejected.degenerate++; continue; }

    const gain = f32(cur - prev);
    // A gain far past the strafe maximum is an external impulse (jump pad,
    // rocket jump, teleport), not a strafe measurement.
    if (gain > f32(maxGain * STRAFE_IMPULSE_FACTOR)) { rejected.impulse++; continue; }

    let q = f32(gain / maxGain);
    if (q < 0) q = 0;                          // bleeding speed while strafing = poor
    if (q > 1) q = 1;                          // cap residual over-unity

    sum += q * dt;                             // frame-time weighted
    weight += dt;
    sampled++;
  }
  return { sum, weight, sampled, rejected };
}

// Player.strafeQualityBasisPoints(): 0..10000, or -1 when nothing was sampled.
export function strafeQualityBasisPoints(acc) {
  if (acc.weight <= 0) return -1;
  let bp = Math.trunc((acc.sum / acc.weight) * 10000.0 + 0.5);   // AS int() truncates
  if (bp < 0) bp = 0;
  if (bp > 10000) bp = 10000;
  return bp;
}

// The ground predicates we can actually evaluate. `onground` is the closest
// stand-in for onStrafeGround(); the other two bracket the 8-unit trace halo we
// cannot reproduce, so replayDemo can report how much it could possibly matter.
const GROUND_RULES = {
  onground: (a, i) => (a[i].pm_flags & PMF_ON_GROUND) !== 0,
  halo: (a, i) => (a[i].pm_flags & PMF_ON_GROUND) !== 0
    || (i > 0 && (a[i - 1].pm_flags & PMF_ON_GROUND) !== 0)
    || (i + 1 < a.length && (a[i + 1].pm_flags & PMF_ON_GROUND) !== 0),
  none: () => false,
};

// --- run extraction ---------------------------------------------------------
// Configstring CS_PLAYERINFOS+i is client i's userinfo subset ("\name\...").
export function decodePlayers(cs) {
  const players = new Map();
  for (let i = 0; i < MAX_CLIENTS_CS; i++) {
    const v = cs.get(CS_PLAYERINFOS + i);
    if (!v) continue;
    const kv = {};
    const parts = v.split("\\");
    for (let j = 1; j + 1 <= parts.length; j += 2) if (parts[j]) kv[parts[j]] = parts[j + 1] ?? "";
    const name = kv.name ?? "";
    players.set(i, {
      clientNum: i,
      name,
      cleanName: stripColor(name),
      // What the GAME MODULE would have reported this player as. The
      // configstring carries the raw netname, but the AngelScript accessor
      // `client.name` appends S_COLOR_WHITE (g_ascript.cpp objectGameClient_getName),
      // and that is the string hrace/player.as puts in a RecordTimeIdent and
      // racelog.as POSTs verbatim — so it, not `name`, is what the database
      // holds for this player.
      reportedName: name + "^7",
    });
  }
  return players;
}

// A gamecommand with an explicit target bitmask names its clients. A broadcast
// one (numtargets 0 == everyone) does not, so it can only be attributed by
// elimination — which is sound exactly when one client is connected.
function attribute(ev, players) {
  if (ev.targets && ev.targets.length) return { clients: ev.targets, byBitmask: true };
  return { clients: [...players.keys()], byBitmask: false };
}

// Starts and finishes, read from the mod's own prints. Three independent
// channels agree on a finish (aw "Race Finished!", cp "Current: ...", pr
// "End: ..."), so they cross-check each other.
function extractEvents(demo, players) {
  const starts = [];
  const finishes = [];

  for (const ev of demo.events) {
    const who = attribute(ev, players);
    const body = ev.args[0] ?? "";

    if (ev.cmd === "pr") {
      // Upstream racemod prints "Starting speed: ^7633^8, height: ^73"; this
      // fork prints just the speed. Tolerate both.
      const ss = /Starting speed:\s*\^?\d?\s*(\d+)/.exec(body);
      if (ss) {
        starts.push({ serverTime: ev.serverTime, clients: who.clients, printedSpeed: Number(ss[1]) });
        continue;
      }
      // "End: ^700:58.805 ... / Speed: ^73188^8, max ^73188"
      if (/\bEnd:/.test(body)) {
        const t = parseRaceTime(body);
        const sp = /Speed:\s*\^?\d?\s*(\d+)/.exec(body);
        const mx = /max\s*\^?\d?\s*(\d+)/.exec(body);
        const last = finishes[finishes.length - 1];
        if (last && Math.abs(last.serverTime - ev.serverTime) <= 200) {
          if (t != null && last.timeMs == null) last.timeMs = t;
          if (sp) last.printedSpeed = Number(sp[1]);
          if (mx) last.printedMaxSpeed = Number(mx[1]);
        }
      }
      continue;
    }

    if (ev.cmd === "aw") {
      const clean = stripColor(body);
      if (clean === "Race Finished!") {
        finishes.push({
          serverTime: ev.serverTime, clients: who.clients, byBitmask: who.byBitmask,
          timeMs: null, awards: [clean], printedSpeed: null, printedMaxSpeed: null, boardPos: null,
        });
      } else {
        const last = finishes[finishes.length - 1];
        if (last && last.serverTime === ev.serverTime) last.awards.push(clean);
      }
      continue;
    }

    if (ev.cmd === "cp") {
      // "^7Current: ^700:58.805 (^2#1^7)"
      const clean = stripColor(body);
      if (clean.startsWith("Current:")) {
        const t = parseRaceTime(clean);
        const p = /\(#(\d+)\)/.exec(clean);
        const last = finishes[finishes.length - 1];
        if (last && last.serverTime === ev.serverTime && t != null) {
          if (last.timeMs == null) last.timeMs = t;
          if (p) last.boardPos = Number(p[1]);
        }
      }
    }
  }
  return { starts, finishes };
}

// --- public API -------------------------------------------------------------
// Replay a demo file into { map, gametype, recordedAt, players, runs, best }.
// Each run carries the recomputed strafe quality plus the provenance a caller
// needs to judge it. Throws (with a human reason) when the file is not a demo we
// can walk — callers treat a throw as "reject this file".
export function replayDemo(path) {
  const demo = decodeDemo(fs.readFileSync(path));
  if (!demo.frames.length) throw new Error("no snapshots in demo (not a recorded stream?)");

  const players = decodePlayers(demo.configstrings);
  if (!players.size) throw new Error("no player configstrings in demo");
  const { starts, finishes } = extractEvents(demo, players);

  const map = (demo.meta.mapname || demo.configstrings.get(CS_MAPNAME) || "").trim().toLowerCase();
  if (!map) throw new Error("no map name in demo");

  const snapPeriodMs = demo.serverdata ? demo.serverdata.snapFrameTime : 0;
  const firstT = demo.frames[0].serverTime;
  // `localtime` is time(NULL) at SV_Demo_Start_f, written immediately before the
  // first frame, so serverTime maps onto wall clock by a simple offset. That is
  // what lets an import backdate a run to when it was actually set.
  const localtime = Number(demo.meta.localtime || 0) || null;
  const wallOf = (t) => (localtime ? Math.round(localtime + (t - firstT) / 1000) : null);

  // Per-client sample series, in frame order.
  const series = new Map();
  for (const f of demo.frames) {
    for (const s of f.ps) {
      let a = series.get(s.playerNum);
      if (!a) { a = []; series.set(s.playerNum, a); }
      a.push({
        t: f.serverTime, vx: s.vx, vy: s.vy, vz: s.vz, yaw: s.yaw,
        keys: s.keys, pm_flags: s.pm_flags, pm_type: s.pm_type, maxspeed: s.maxspeed,
      });
    }
  }
  const hspeed = (s) => Math.sqrt(s.vx * s.vx + s.vy * s.vy);

  const runs = [];
  for (const fin of finishes) {
    if (fin.timeMs == null) continue;          // an award with no time bounds no window
    const finT = fin.serverTime;
    const nominalStart = finT - fin.timeMs;
    // Pair with the last "Starting speed" print at or before the finish — that
    // is the authoritative startRace() marker (where the mod's accumulators
    // reset). Fall back to the nominal window when the build prints nothing.
    for (const clientNum of fin.clients) {
      // Pair with the last "Starting speed" print at or before the finish — that
      // is the authoritative startRace() marker (where the mod's accumulators
      // reset). It MUST be filtered to this client: on a populated server another
      // racer's start print falls in the same window and would silently move the
      // measurement window (and the reported start speed) onto the wrong run.
      let pairedStart = null;
      for (const st of starts) {
        if (st.serverTime > finT) break;
        if (!st.clients.includes(clientNum)) continue;
        if (st.serverTime >= nominalStart - 200) pairedStart = st;
      }
      const winStart = pairedStart ? Math.max(pairedStart.serverTime, nominalStart) : nominalStart;

      const all = series.get(clientNum);
      if (!all) continue;
      const win = all.filter((s) => s.t >= winStart && s.t <= finT);
      if (win.length < 2) continue;

      const acc = strafeQuality(win, { groundFn: GROUND_RULES.onground });
      const bp = strafeQualityBasisPoints(acc);
      // Bracketing measurements, reported so a caller sees the modelling spread
      // rather than having to trust a single figure. Each isolates one choice
      // this reconstruction cannot make with certainty.
      const bpKeyLag0 = strafeQualityBasisPoints(
        strafeQuality(win, { groundFn: GROUND_RULES.onground, keyLag: 0 })
      );
      const bpSubStepped = strafeQualityBasisPoints(
        strafeQuality(win, { groundFn: GROUND_RULES.onground, gainFn: idealGain })
      );
      const bpHalo = strafeQualityBasisPoints(strafeQuality(win, { groundFn: GROUND_RULES.halo }));
      const bpNoGround = strafeQualityBasisPoints(strafeQuality(win, { groundFn: GROUND_RULES.none }));

      // AS updateMaxSpeed(): uint(HorizontalSpeed(...)) each in-race frame;
      // raceStartSpeed: int(HorizontalSpeed(...)) at the startRace() frame. The
      // mod PRINTS both, and its values were latched at the full game-frame rate
      // — so a printed value always beats our resampled one.
      let maxSpeedSampled = 0;
      for (const s of win) { const h = Math.trunc(hspeed(s)); if (h > maxSpeedSampled) maxSpeedSampled = h; }
      const startSpeedSampled = Math.trunc(hspeed(win[0]));

      const p = players.get(clientNum);
      runs.push({
        // `player` is what the DATABASE holds (the mod's reported form); the raw
        // configstring name is kept beside it for display/debugging.
        player: p ? p.reportedName : null,
        playerRawName: p ? p.name : null,
        playerClean: p ? p.cleanName : null,
        clientNum,
        map,
        timeMs: fin.timeMs,
        // The metric, and everything needed to judge it.
        strafeQualityBp: bp,
        maxSpeed: fin.printedMaxSpeed ?? maxSpeedSampled,
        startSpeed: pairedStart ? pairedStart.printedSpeed : startSpeedSampled,
        finishedAt: wallOf(finT),
        awards: fin.awards,
        boardPos: fin.boardPos,
        attributedByBitmask: !!fin.byBitmask,
        provenance: {
          strafeSource: "recomputed-from-demo",
          snapPeriodMs,
          gameFramePeriodMs: WORLDFRAMETIME,
          samples: win.length,
          strafeSampledFrames: acc.sampled,
          strafeWeightSec: Math.round(acc.weight * 1000) / 1000,
          rejected: acc.rejected,
          // What the number becomes under each assumption this reconstruction
          // cannot settle: the naive key phase, a sub-stepped ideal gain, and
          // the two ground-rule extremes. The stored value is the first column
          // of that spread, not a point estimate of truth.
          bpKeyLag0: bpKeyLag0,
          bpSubSteppedGain: bpSubStepped,
          bpGroundHalo: bpHalo,
          bpNoGround: bpNoGround,
          speedSource: {
            max: fin.printedMaxSpeed != null ? "printed" : "sampled",
            start: pairedStart ? "printed" : "sampled",
            maxSampled: maxSpeedSampled,
            startSampled: startSpeedSampled,
          },
        },
      });
    }
  }

  runs.sort((a, b) => a.timeMs - b.timeMs);
  return {
    file: path,
    map,
    gametype: (demo.meta.gametype || demo.configstrings.get(CS_GAMETYPENAME) || "").trim(),
    hostname: demo.configstrings.get(CS_HOSTNAME) || demo.meta.hostname || "",
    // Demo START (time(NULL) at SV_Demo_Start_f); each run carries its own
    // finishedAt, which is what an import should date the run by.
    recordedAt: localtime,
    multipov: demo.meta.multipov === "1",
    // A client per-run demo names its runner/time here; a server autorecord
    // leaves both unset, which is precisely why this module exists.
    matchname: demo.configstrings.get(CS_MATCHNAME) || demo.meta.matchname || null,
    matchscore: demo.configstrings.get(CS_MATCHSCORE) || demo.meta.matchscore || null,
    players: [...players.values()],
    runs,
    best: runs[0] ?? null,
    stats: {
      ...demo.stats, rawBytes: demo.rawBytes, snapPeriodMs,
      // The engine's mod directories — what an importer maps onto a leaderboard
      // version label ("racemod_2.1" -> "wsw 2.1").
      basegame: demo.serverdata ? demo.serverdata.basegame : "",
      game: demo.serverdata ? demo.serverdata.game : "",
      protocol: demo.serverdata ? demo.serverdata.protocol : 0,
    },
  };
}

// CLI
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node demo-replay.mjs [--best|--frames] <demo.wdz20>");
    process.exit(64);
  }
  try {
    const r = replayDemo(file);
    if (flags.has("--frames")) process.stdout.write(JSON.stringify(r.stats, null, 2) + "\n");
    else if (flags.has("--best")) process.stdout.write(JSON.stringify(r.best, null, 2) + "\n");
    else {
      const { players, runs, best, ...head } = r;
      process.stdout.write(JSON.stringify({ ...head, players, runs, best }, null, 2) + "\n");
    }
  } catch (e) {
    console.error("demo-replay: " + (e && e.message ? e.message : e));
    process.exit(2);
  }
}
