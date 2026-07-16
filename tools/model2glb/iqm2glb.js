#!/usr/bin/env node
"use strict";
// iqm2glb — convert the Warsow Pig (padpork) IQM v2 skeletal model into a
// skinned glTF/GLB with named animation clips for the three.js viewer.
//
// Produces web/public/assets/models/padpork.glb:
//   * a SkinnedMesh: skeleton (joint node hierarchy), inverse bind matrices,
//     JOINTS_0 / WEIGHTS_0 skin attributes, POSITION/NORMAL/TEXCOORD_0
//   * baseColorTexture referencing padpork_diff.png (embedded as a bufferView
//     image so the .glb is self-contained)
//   * named animation clips sampled from animation.cfg frame ranges:
//     idle, run, run_back, run_left, run_right, jump, walljump, dash,
//     crouch, shoot  (each = joint TRS keyframes over its frame range @ fps)
//
// Also writes padpork.meta.json (tag_weapon attach data, clip names, height).
//
// Coordinates are left in NATIVE Quake axes (Z-up). The viewer applies the
// Quake->glTF (x,y,z)->(x,z,-y) swap itself, so we do NOT pre-rotate.
//
// IQM v2 layout & channel decoding per the format spec (see README.md).
//
// Usage: node iqm2glb.js
const fs = require("node:fs");
const path = require("node:path");
const { GlbBuilder, validateGlb, COMPONENT, TARGET } = require("./glb.js");

const PADPORK_DIR = path.resolve(__dirname, "../wsw-assets/models/players/padpork");
const OUT_DIR = path.resolve(__dirname, "../../web/public/assets/models");
const IQM_PATH = path.join(PADPORK_DIR, "tris.iqm");
const CFG_PATH = path.join(PADPORK_DIR, "animation.cfg");
const DIFF_PNG = path.join(OUT_DIR, "padpork_diff.png");

// Animation clips we export. name -> substring key in animation.cfg comment.
// (first/last are 1-based frame indices into the IQM frame array.)
const CLIP_KEYS = [
  ["idle", "LEGS_STAND_IDLE"],
  ["run", "LEGS_RUN_FORWARD"],
  ["run_back", "LEGS_RUN_BACK"],
  ["run_left", "LEGS_RUN_LEFT"],
  ["run_right", "LEGS_RUN_RIGHT"],
  ["jump", "LEGS_JUMP_NEUTRAL"],
  ["walljump", "LEGS_WALLJUMP"],
  ["dash", "LEGS_DASH"],
  ["crouch", "LEGS_CROUCH_WALK"],
  ["shoot", "TORSO_SHOOT_LIGHTGUN"],
];

// ---------------------------------------------------------------------------
// tiny quaternion / matrix helpers (all row-major-agnostic; glTF wants
// column-major MAT4 written column-by-column). Quaternions are xyzw.

function quatNormalize(q) {
  const [x, y, z, w] = q;
  let l = Math.hypot(x, y, z, w);
  if (l === 0) return [0, 0, 0, 1];
  return [x / l, y / l, z / l, w / l];
}

// Compose a column-major 4x4 (Float array length 16) from T, R(quat xyzw), S.
function composeMat4(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[3] = 0;
  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[7] = 0;
  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[11] = 0;
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

// column-major 4x4 * 4x4
function mulMat4(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// Invert a column-major 4x4 (general inverse).
function invertMat4(m) {
  const inv = new Float64Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) throw new Error("singular matrix");
  det = 1.0 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return inv;
}

// ---------------------------------------------------------------------------
// IQM parsing

function parseIqm(buf) {
  const magic = buf.toString("latin1", 0, 16);
  if (magic !== "INTERQUAKEMODEL\0") throw new Error(`bad IQM magic ${JSON.stringify(magic)}`);
  let o = 16;
  const u = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const version = u();
  if (version !== 2) throw new Error(`unsupported IQM version ${version}`);
  const filesize = u();
  const flags = u();
  const h = {};
  for (const f of [
    "num_text", "ofs_text", "num_meshes", "ofs_meshes",
    "num_vertexarrays", "num_vertexes", "ofs_vertexarrays",
    "num_triangles", "ofs_triangles", "ofs_adjacency",
    "num_joints", "ofs_joints", "num_poses", "ofs_poses",
    "num_anims", "ofs_anims", "num_frames", "num_framechannels",
    "ofs_frames", "ofs_bounds", "num_comment", "ofs_comment",
    "num_extensions", "ofs_extensions",
  ]) h[f] = u();

  const str = (off) => {
    let e = h.ofs_text + off;
    while (buf[e] !== 0) e++;
    return buf.toString("latin1", h.ofs_text + off, e);
  };

  // vertex arrays
  const arrays = {};
  for (let i = 0; i < h.num_vertexarrays; i++) {
    const b = h.ofs_vertexarrays + i * 20;
    arrays[buf.readUInt32LE(b)] = {
      type: buf.readUInt32LE(b),
      format: buf.readUInt32LE(b + 8),
      size: buf.readUInt32LE(b + 12),
      offset: buf.readUInt32LE(b + 16),
    };
  }
  const nv = h.num_vertexes;
  const readFloatArray = (va, comps) => {
    const out = new Float32Array(nv * comps);
    for (let i = 0; i < nv * comps; i++) out[i] = buf.readFloatLE(va.offset + i * 4);
    return out;
  };
  const readUByteArray = (va, comps) => {
    const out = new Uint8Array(nv * comps);
    for (let i = 0; i < nv * comps; i++) out[i] = buf.readUInt8(va.offset + i);
    return out;
  };

  const positions = readFloatArray(arrays[0], 3);
  const texcoords = arrays[1] ? readFloatArray(arrays[1], 2) : new Float32Array(nv * 2);
  const normals = arrays[2] ? readFloatArray(arrays[2], 3) : new Float32Array(nv * 3);
  const blendIndexes = arrays[4] ? readUByteArray(arrays[4], 4) : new Uint8Array(nv * 4);
  const blendWeights = arrays[5] ? readUByteArray(arrays[5], 4) : new Uint8Array(nv * 4);

  // triangles (uint32 x3). IQM winding -> reverse to match glTF CCW like the
  // viewer's other assets? Keep native winding; the viewer handles culling.
  const indices = new Uint32Array(h.num_triangles * 3);
  for (let i = 0; i < h.num_triangles * 3; i++) {
    indices[i] = buf.readUInt32LE(h.ofs_triangles + i * 4);
  }

  // joints: name(uint), parent(int), translate(3f), rotate(4f), scale(3f) => 48 bytes
  const joints = [];
  for (let i = 0; i < h.num_joints; i++) {
    const b = h.ofs_joints + i * 48;
    joints.push({
      name: str(buf.readUInt32LE(b)),
      parent: buf.readInt32LE(b + 4),
      translate: [buf.readFloatLE(b + 8), buf.readFloatLE(b + 12), buf.readFloatLE(b + 16)],
      rotate: quatNormalize([
        buf.readFloatLE(b + 20), buf.readFloatLE(b + 24),
        buf.readFloatLE(b + 28), buf.readFloatLE(b + 32),
      ]),
      scale: [buf.readFloatLE(b + 36), buf.readFloatLE(b + 40), buf.readFloatLE(b + 44)],
    });
  }

  // poses: parent(int), channelmask(uint), channeloffset[10], channelscale[10] => 88 bytes
  const poses = [];
  for (let i = 0; i < h.num_poses; i++) {
    const b = h.ofs_poses + i * 88;
    const channeloffset = [], channelscale = [];
    for (let c = 0; c < 10; c++) channeloffset.push(buf.readFloatLE(b + 8 + c * 4));
    for (let c = 0; c < 10; c++) channelscale.push(buf.readFloatLE(b + 48 + c * 4));
    poses.push({
      parent: buf.readInt32LE(b),
      mask: buf.readUInt32LE(b + 4),
      channeloffset, channelscale,
    });
  }

  // frames: ushort framedata array of length num_frames*num_framechannels
  // decode into per-frame per-pose 10-channel values -> local TRS.
  // channel order: 0-2 translate, 3-6 rotate(quat xyzw), 7-9 scale.
  const framesTRS = []; // framesTRS[frame][pose] = { t:[3], r:[4], s:[3] }
  let fp = h.ofs_frames;
  for (let f = 0; f < h.num_frames; f++) {
    const frame = [];
    for (let p = 0; p < h.num_poses; p++) {
      const pose = poses[p];
      const v = new Array(10);
      for (let c = 0; c < 10; c++) {
        let val = pose.channeloffset[c];
        if (pose.mask & (1 << c)) {
          val += buf.readUInt16LE(fp) * pose.channelscale[c];
          fp += 2;
        }
        v[c] = val;
      }
      frame.push({
        t: [v[0], v[1], v[2]],
        r: quatNormalize([v[3], v[4], v[5], v[6]]),
        s: [v[7], v[8], v[9]],
      });
    }
    framesTRS.push(frame);
  }

  const mesh = {
    name: str(buf.readUInt32LE(h.ofs_meshes)),
    material: str(buf.readUInt32LE(h.ofs_meshes + 4)),
    first_vertex: buf.readUInt32LE(h.ofs_meshes + 8),
    num_vertexes: buf.readUInt32LE(h.ofs_meshes + 12),
    first_triangle: buf.readUInt32LE(h.ofs_meshes + 16),
    num_triangles: buf.readUInt32LE(h.ofs_meshes + 20),
  };

  return {
    h, mesh, joints, poses, framesTRS,
    positions, texcoords, normals, blendIndexes, blendWeights, indices,
  };
}

// ---------------------------------------------------------------------------
// animation.cfg parser: pull "firstframe lastframe loop fps // NAME" lines.
function parseAnimCfg(text) {
  const clips = {}; // NAME -> {first,last,loop,fps}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\/\/\s*(\S+)/);
    if (!m) continue;
    const name = m[5];
    if (!(name in clips)) {
      clips[name] = {
        first: parseInt(m[1], 10),
        last: parseInt(m[2], 10),
        loop: parseInt(m[3], 10),
        fps: parseInt(m[4], 10),
      };
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// Build bind-pose global matrices from the joints' base TRS up the parent chain.
function computeBindMatrices(joints) {
  const local = joints.map((j) => composeMat4(j.translate, j.rotate, j.scale));
  const global = new Array(joints.length);
  for (let i = 0; i < joints.length; i++) {
    global[i] = joints[i].parent >= 0 ? mulMat4(global[joints[i].parent], local[i]) : local[i];
  }
  const inverseBind = global.map(invertMat4);
  return { local, global, inverseBind };
}

// ---------------------------------------------------------------------------
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const iqm = parseIqm(fs.readFileSync(IQM_PATH));
  const cfg = parseAnimCfg(fs.readFileSync(CFG_PATH, "utf8"));
  const nJoints = iqm.joints.length;
  const { inverseBind } = computeBindMatrices(iqm.joints);

  const gb = new GlbBuilder();

  // --- geometry accessors (native Quake axes) ---
  const posAcc = gb.addAccessor(iqm.positions, {
    type: "VEC3", componentType: COMPONENT.FLOAT, target: TARGET.ARRAY_BUFFER, computeMinMax: true,
  });
  const normAcc = gb.addAccessor(iqm.normals, {
    type: "VEC3", componentType: COMPONENT.FLOAT, target: TARGET.ARRAY_BUFFER,
  });
  const uvAcc = gb.addAccessor(iqm.texcoords, {
    type: "VEC2", componentType: COMPONENT.FLOAT, target: TARGET.ARRAY_BUFFER,
  });
  const jointsAcc = gb.addAccessor(iqm.blendIndexes, {
    type: "VEC4", componentType: COMPONENT.UNSIGNED_BYTE, target: TARGET.ARRAY_BUFFER,
  });
  // Normalize blend weights (ubyte /255) — glTF requires per-vertex weights sum
  // ~1. IQM stores them as ubyte4; use normalized accessor. Fix any all-zero
  // vertex (rigid to joint 0) to weight (255,0,0,0).
  const weights = Uint8Array.from(iqm.blendWeights);
  for (let v = 0; v < iqm.h.num_vertexes; v++) {
    const b = v * 4;
    if (weights[b] + weights[b + 1] + weights[b + 2] + weights[b + 3] === 0) weights[b] = 255;
  }
  const weightsAcc = gb.addAccessor(weights, {
    type: "VEC4", componentType: COMPONENT.UNSIGNED_BYTE, target: TARGET.ARRAY_BUFFER, normalized: true,
  });
  const idxAcc = gb.addAccessor(iqm.indices, {
    type: "SCALAR", componentType: COMPONENT.UNSIGNED_INT, target: TARGET.ELEMENT_ARRAY_BUFFER,
  });

  // --- inverse bind matrices accessor (MAT4, column-major, 16 floats each) ---
  const ibm = new Float32Array(nJoints * 16);
  for (let i = 0; i < nJoints; i++) ibm.set(inverseBind[i], i * 16);
  const ibmAcc = gb.addAccessor(ibm, {
    type: "MAT4", componentType: COMPONENT.FLOAT,
  });

  // --- embed diffuse PNG as an image bufferView ---
  let materialIndex, imageBvIndex, images, textures, samplers, materials;
  if (fs.existsSync(DIFF_PNG)) {
    const png = fs.readFileSync(DIFF_PNG);
    imageBvIndex = gb.addBufferView(png); // no target for image data
    images = [{ bufferView: imageBvIndex, mimeType: "image/png", name: "padpork_diff" }];
    samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    textures = [{ sampler: 0, source: 0 }];
    materials = [{
      name: "padpork",
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    }];
    materialIndex = 0;
  }

  // --- animation samplers: for each clip, sample joint local TRS over frames ---
  // glTF nodes: joints are nodes 0..nJoints-1, mesh node is nJoints, skeleton
  // root scene node references the joint roots + mesh node.
  const nodes = [];
  for (let i = 0; i < nJoints; i++) {
    const j = iqm.joints[i];
    const node = {
      name: j.name,
      translation: j.translate,
      rotation: j.rotate,
      scale: j.scale,
    };
    nodes.push(node);
  }
  // attach children
  const rootJoints = [];
  for (let i = 0; i < nJoints; i++) {
    if (iqm.joints[i].parent >= 0) {
      const parent = nodes[iqm.joints[i].parent];
      (parent.children = parent.children || []).push(i);
    } else {
      rootJoints.push(i);
    }
  }

  const meshNodeIndex = nodes.length;
  nodes.push({ name: "padpork_mesh", mesh: 0, skin: 0 });

  const animations = [];
  const clipMeta = [];
  for (const [clipName, key] of CLIP_KEYS) {
    const c = cfg[key];
    if (!c) { clipMeta.push({ name: clipName, missing: key }); continue; }
    // frames are 1-based inclusive; clamp into [0, num_frames-1]
    const f0 = Math.max(0, c.first - 1);
    const f1 = Math.min(iqm.h.num_frames - 1, c.last - 1);
    const nFrames = f1 - f0 + 1;
    if (nFrames <= 0) { clipMeta.push({ name: clipName, missing: `empty range ${key}` }); continue; }
    const fps = c.fps || 30;

    // shared time input accessor for this clip
    const times = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) times[f] = f / fps;
    const inputAcc = gb.addAccessor(times, {
      type: "SCALAR", componentType: COMPONENT.FLOAT, computeMinMax: true,
    });

    const channels = [];
    const samplers2 = [];
    // Emit a sampler+channel for a joint path (translation/rotation/scale) only
    // if it VARIES within this clip OR its constant value differs from the
    // node's default TRS (= the IQM bind pose that the inverse-bind matrices are
    // built from). Channels that are constant AND equal the node default are
    // dropped: glTF leaves such joints at their default, which is exactly right.
    // This is safe (never changes the sampled pose) and drops all scale + most
    // translation channels, shrinking the .glb ~3x. Thresholds are per-unit for
    // translation (~1/1000 unit) and per-quaternion-component for rotation.
    const EPS_T = 1e-3, EPS_R = 1e-3;
    for (let j = 0; j < nJoints; j++) {
      const jd = iqm.joints[j]; // node default TRS
      const first = iqm.framesTRS[f0][j];
      const tOut = new Float32Array(nFrames * 3);
      const rOut = new Float32Array(nFrames * 4);
      const sOut = new Float32Array(nFrames * 3);
      let tVary = false, rVary = false, sVary = false;
      for (let f = 0; f < nFrames; f++) {
        const trs = iqm.framesTRS[f0 + f][j];
        tOut.set(trs.t, f * 3);
        rOut.set(trs.r, f * 4);
        sOut.set(trs.s, f * 3);
        if (!tVary && (Math.abs(trs.t[0] - first.t[0]) > 1e-4 || Math.abs(trs.t[1] - first.t[1]) > 1e-4 || Math.abs(trs.t[2] - first.t[2]) > 1e-4)) tVary = true;
        if (!rVary && (Math.abs(trs.r[0] - first.r[0]) > 1e-5 || Math.abs(trs.r[1] - first.r[1]) > 1e-5 || Math.abs(trs.r[2] - first.r[2]) > 1e-5 || Math.abs(trs.r[3] - first.r[3]) > 1e-5)) rVary = true;
        if (!sVary && (Math.abs(trs.s[0] - first.s[0]) > 1e-4 || Math.abs(trs.s[1] - first.s[1]) > 1e-4 || Math.abs(trs.s[2] - first.s[2]) > 1e-4)) sVary = true;
      }
      const tDiff = Math.max(Math.abs(first.t[0] - jd.translate[0]), Math.abs(first.t[1] - jd.translate[1]), Math.abs(first.t[2] - jd.translate[2]));
      const rDiff = Math.max(Math.abs(first.r[0] - jd.rotate[0]), Math.abs(first.r[1] - jd.rotate[1]), Math.abs(first.r[2] - jd.rotate[2]), Math.abs(first.r[3] - jd.rotate[3]));
      const sDiff = Math.max(Math.abs(first.s[0] - jd.scale[0]), Math.abs(first.s[1] - jd.scale[1]), Math.abs(first.s[2] - jd.scale[2]));
      if (tVary || tDiff > EPS_T) {
        const acc = gb.addAccessor(tOut, { type: "VEC3", componentType: COMPONENT.FLOAT });
        const s = samplers2.push({ input: inputAcc, output: acc, interpolation: "LINEAR" }) - 1;
        channels.push({ sampler: s, target: { node: j, path: "translation" } });
      }
      if (rVary || rDiff > EPS_R) {
        const acc = gb.addAccessor(rOut, { type: "VEC4", componentType: COMPONENT.FLOAT });
        const s = samplers2.push({ input: inputAcc, output: acc, interpolation: "LINEAR" }) - 1;
        channels.push({ sampler: s, target: { node: j, path: "rotation" } });
      }
      if (sVary || sDiff > EPS_T) {
        const acc = gb.addAccessor(sOut, { type: "VEC3", componentType: COMPONENT.FLOAT });
        const s = samplers2.push({ input: inputAcc, output: acc, interpolation: "LINEAR" }) - 1;
        channels.push({ sampler: s, target: { node: j, path: "scale" } });
      }
    }
    animations.push({ name: clipName, samplers: samplers2, channels });
    clipMeta.push({ name: clipName, key, frames: nFrames, fps, duration: +(nFrames / fps).toFixed(3), channels: channels.length });
  }

  // --- mesh primitive ---
  const attributes = {
    POSITION: posAcc,
    NORMAL: normAcc,
    TEXCOORD_0: uvAcc,
    JOINTS_0: jointsAcc,
    WEIGHTS_0: weightsAcc,
  };
  const primitive = { attributes, indices: idxAcc, mode: 4 };
  if (materialIndex !== undefined) primitive.material = materialIndex;

  const gltf = {
    asset: { version: "2.0", generator: "iqm2glb (padpork)" },
    scene: 0,
    scenes: [{ nodes: [...rootJoints, meshNodeIndex] }],
    nodes,
    meshes: [{ name: iqm.mesh.name, primitives: [primitive] }],
    skins: [{
      inverseBindMatrices: ibmAcc,
      joints: Array.from({ length: nJoints }, (_, i) => i),
      skeleton: rootJoints[0],
    }],
  };
  if (materials) { gltf.materials = materials; gltf.textures = textures; gltf.images = images; gltf.samplers = samplers; }
  if (animations.length) gltf.animations = animations;

  const outPath = path.join(OUT_DIR, "padpork.glb");
  const bytes = gb.write(gltf, outPath);

  // --- model height: bind-pose bbox extent along Quake Z (up) ---
  let minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < iqm.h.num_vertexes; v++) {
    const z = iqm.positions[v * 3 + 2];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const modelHeight = +(maxZ - minZ).toFixed(3);

  // --- meta sidecar ---
  const tagWeapon = {
    bone: "Bip01 R Hand",
    tag: "tag_weapon",
    // from animation.cfg: offset forward,right,up  angles pitch,yaw,roll
    offset: { forward: 6, right: 3, up: -1 },
    angles: { pitch: -14, yaw: -21, roll: -1 },
  };
  const meta = {
    model: "padpork",
    source: "tools/wsw-assets/models/players/padpork/tris.iqm (IQM v2)",
    axes: "native Quake (Z-up, X forward, Y left); viewer applies (x,y,z)->(x,z,-y)",
    diffuseTexture: "padpork_diff.png (grayscale fullbright diffuse; embedded in glb)",
    joints: nJoints,
    tag_weapon: tagWeapon,
    animationClips: clipMeta.filter((c) => !c.missing).map((c) => c.name),
    clipDetails: clipMeta,
    modelHeightUnits: modelHeight,
    playerBBoxHeightUnits: 44,
    recommendedScale: +(44 / modelHeight).toFixed(4),
  };
  const metaPath = path.join(OUT_DIR, "padpork.meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // --- validate ---
  const v = validateGlb(outPath);
  console.log(`OK  padpork.glb  ${(bytes / 1024).toFixed(1)}KB`);
  console.log(`    joints=${nJoints}  verts=${iqm.h.num_vertexes}  tris=${iqm.h.num_triangles}`);
  console.log(`    accessors=${v.summary.accessors}  bufferViews=${v.summary.bufferViews}  images=${v.summary.images}  skins=${v.summary.skins}`);
  console.log(`    clips: ${v.summary.animations.join(", ")}`);
  const missing = clipMeta.filter((c) => c.missing);
  if (missing.length) console.log(`    MISSING clips: ${missing.map((c) => `${c.name}(${c.missing})`).join(", ")}`);
  console.log(`    model height (Quake Z): ${modelHeight} units -> recommendedScale ${meta.recommendedScale}`);
  console.log(`    meta -> ${metaPath}`);
  const posAccObj = v.doc.accessors[posAcc];
  console.log(`    POSITION min=[${posAccObj.min.map((x) => x.toFixed(2))}] max=[${posAccObj.max.map((x) => x.toFixed(2))}]`);
}

if (require.main === module) main();

module.exports = { parseIqm, parseAnimCfg, computeBindMatrices, composeMat4, mulMat4, invertMat4 };
