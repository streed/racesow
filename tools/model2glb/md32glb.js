#!/usr/bin/env node
"use strict";
// md32glb — convert Warsow/Quake3 MD3 weapon viewmodels into static .glb
// geometry for the three.js FPS viewer. No textures: the viewer draws these
// with a flat greybox material, so we emit POSITION + NORMAL + indices only
// (TEXCOORD is parsed but skipped — kept here in case the viewer wants it).
//
// Note on _hand.md3: in these assets the `<weapon>_hand.md3` files contain
// numSurfaces=0 — they are pure positioning rigs that only carry the
// `tag_weapon` tag (where the weapon attaches to the player's hand) plus a
// 60-frame animation. The actual weapon geometry lives in `<weapon>.md3`.
// So we take GEOMETRY from `<weapon>.md3` and read the tag_weapon offset from
// `<weapon>_hand.md3` (frame 0), writing it into the .glb as an extra node so
// the viewer can position the muzzle/attach point. All surfaces are included.
//
// MD3 vertex coords are int16 scaled by 1/64 -> Quake units. Normals are
// lat/lng encoded (2 bytes). Coordinates are left in native Quake axes (Z-up);
// the viewer applies the Quake->glTF swap itself (see coordinate note in meta).
//
// Usage:
//   node md32glb.js                         (convert the 3 race weapons)
//   node md32glb.js <weapon.md3> <out.glb>  (single file)
const fs = require("node:fs");
const path = require("node:path");
const { GlbBuilder, validateGlb, COMPONENT, TARGET } = require("./glb.js");

const ASSETS = path.resolve(__dirname, "../wsw-assets/models/weapons");
const OUT_DIR = path.resolve(__dirname, "../../web/public/assets/models");
const WEAPONS = ["gunblade", "rlauncher", "plasmagun"];

function readCStr(buf, off, max) {
  let e = off;
  while (e < off + max && buf[e] !== 0) e++;
  return buf.toString("latin1", off, e);
}

// Decode MD3 lat/lng packed normal (2 bytes) into a unit vector (Quake axes).
function decodeNormal(lat, lng) {
  const latR = (lat * 2 * Math.PI) / 255;
  const lngR = (lng * 2 * Math.PI) / 255;
  return [
    Math.cos(latR) * Math.sin(lngR),
    Math.sin(latR) * Math.sin(lngR),
    Math.cos(lngR),
  ];
}

// Parse an MD3 into { surfaces:[{name,positions,normals,uvs,indices}], tags:[{name,origin,axis}] }.
function parseMd3(buf) {
  const magic = readCStr(buf, 0, 4);
  const version = buf.readInt32LE(4);
  if (magic !== "IDP3") throw new Error(`bad MD3 magic ${JSON.stringify(magic)}`);
  if (version !== 15) throw new Error(`unsupported MD3 version ${version}`);

  let o = 72; // after magic(4)+version(4)+name(64)
  const flags = buf.readInt32LE(o); o += 4;
  const numFrames = buf.readInt32LE(o); o += 4;
  const numTags = buf.readInt32LE(o); o += 4;
  const numSurfaces = buf.readInt32LE(o); o += 4;
  const numSkins = buf.readInt32LE(o); o += 4;
  const ofsFrames = buf.readInt32LE(o); o += 4;
  const ofsTags = buf.readInt32LE(o); o += 4;
  const ofsSurfaces = buf.readInt32LE(o); o += 4;
  const ofsEnd = buf.readInt32LE(o); o += 4;

  // Tags for frame 0 only (tags are stored per-frame: numFrames*numTags).
  const tags = [];
  for (let t = 0; t < numTags; t++) {
    const to = ofsTags + t * 112; // frame 0 block
    const name = readCStr(buf, to, 64);
    const origin = [buf.readFloatLE(to + 64), buf.readFloatLE(to + 68), buf.readFloatLE(to + 72)];
    const axis = [];
    for (let i = 0; i < 9; i++) axis.push(buf.readFloatLE(to + 76 + i * 4));
    tags.push({ name, origin, axis });
  }

  const surfaces = [];
  let so = ofsSurfaces;
  for (let s = 0; s < numSurfaces; s++) {
    const sName = readCStr(buf, so + 4, 64);
    let p = so + 68; // after magic(4)+name(64)
    const sFlags = buf.readInt32LE(p); p += 4;
    const sFrames = buf.readInt32LE(p); p += 4;
    const sShaders = buf.readInt32LE(p); p += 4;
    const sVerts = buf.readInt32LE(p); p += 4;
    const sTris = buf.readInt32LE(p); p += 4;
    const oTris = buf.readInt32LE(p); p += 4;
    const oShaders = buf.readInt32LE(p); p += 4;
    const oST = buf.readInt32LE(p); p += 4;
    const oXYZ = buf.readInt32LE(p); p += 4;
    const oEnd = buf.readInt32LE(p); p += 4;

    // Triangle indices (3 int32 each).
    const indices = new Uint32Array(sTris * 3);
    for (let i = 0; i < sTris * 3; i++) {
      indices[i] = buf.readInt32LE(so + oTris + i * 4);
    }

    // ST (uv): float2 per vert.
    const uvs = new Float32Array(sVerts * 2);
    for (let i = 0; i < sVerts; i++) {
      uvs[i * 2] = buf.readFloatLE(so + oST + i * 8);
      uvs[i * 2 + 1] = buf.readFloatLE(so + oST + i * 8 + 4);
    }

    // XYZNormal for frame 0: int16 x,y,z (1/64 units) + 2-byte lat/lng normal = 8 bytes/vert.
    const positions = new Float32Array(sVerts * 3);
    const normals = new Float32Array(sVerts * 3);
    const frameBase = so + oXYZ; // frame 0
    for (let i = 0; i < sVerts; i++) {
      const vo = frameBase + i * 8;
      positions[i * 3] = buf.readInt16LE(vo) / 64;
      positions[i * 3 + 1] = buf.readInt16LE(vo + 2) / 64;
      positions[i * 3 + 2] = buf.readInt16LE(vo + 4) / 64;
      const lat = buf.readUInt8(vo + 6);
      const lng = buf.readUInt8(vo + 7);
      const n = decodeNormal(lat, lng);
      normals[i * 3] = n[0];
      normals[i * 3 + 1] = n[1];
      normals[i * 3 + 2] = n[2];
    }

    surfaces.push({ name: sName, positions, normals, uvs, indices, verts: sVerts, tris: sTris });
    so += oEnd;
  }

  return { magic, version, numFrames, numTags, numSurfaces, tags, surfaces };
}

// Build a static, textureless GLB from a set of surfaces. Optionally add an
// empty child node marking the tag_weapon attach point.
function buildGlb(surfaces, tagWeapon, outPath, generatorNote) {
  const gb = new GlbBuilder();
  const meshPrimitives = [];
  for (const surf of surfaces) {
    if (surf.tris === 0) continue;
    const posAcc = gb.addAccessor(surf.positions, {
      type: "VEC3", componentType: COMPONENT.FLOAT, target: TARGET.ARRAY_BUFFER, computeMinMax: true,
    });
    const normAcc = gb.addAccessor(surf.normals, {
      type: "VEC3", componentType: COMPONENT.FLOAT, target: TARGET.ARRAY_BUFFER,
    });
    const idxAcc = gb.addAccessor(surf.indices, {
      type: "SCALAR", componentType: COMPONENT.UNSIGNED_INT, target: TARGET.ELEMENT_ARRAY_BUFFER,
    });
    meshPrimitives.push({
      attributes: { POSITION: posAcc, NORMAL: normAcc },
      indices: idxAcc,
      mode: 4,
    });
  }

  const nodes = [{ name: "weapon", mesh: 0 }];
  const sceneNodes = [0];
  if (tagWeapon) {
    // Empty node at the tag_weapon origin (Quake axes) so the viewer can read
    // the attach transform via node.translation.
    nodes.push({ name: "tag_weapon", translation: tagWeapon.origin });
    sceneNodes.push(nodes.length - 1);
  }

  const gltf = {
    asset: { version: "2.0", generator: generatorNote || "md32glb" },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [{ name: "weapon", primitives: meshPrimitives }],
  };
  return gb.write(gltf, outPath);
}

function convertWeapon(weapon) {
  const mainPath = path.join(ASSETS, weapon, `${weapon}.md3`);
  const handPath = path.join(ASSETS, weapon, `${weapon}_hand.md3`);
  const main = parseMd3(fs.readFileSync(mainPath));

  let tagWeapon = null;
  if (fs.existsSync(handPath)) {
    const hand = parseMd3(fs.readFileSync(handPath));
    tagWeapon = hand.tags.find((t) => t.name === "tag_weapon") || hand.tags[0] || null;
  }

  const outPath = path.join(OUT_DIR, `weapon-${weapon}.glb`);
  const totalTris = main.surfaces.reduce((a, s) => a + s.tris, 0);
  const bytes = buildGlb(main.surfaces, tagWeapon, outPath, `md32glb:${weapon}`);

  const v = validateGlb(outPath);
  return {
    weapon, outPath, bytes,
    surfaces: main.surfaces.map((s) => `${s.name}(${s.verts}v/${s.tris}t)`),
    totalTris,
    tagWeapon,
    valid: v.summary,
  };
}

function main() {
  const argv = process.argv.slice(2);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (argv.length === 2) {
    const main = parseMd3(fs.readFileSync(argv[0]));
    const bytes = buildGlb(main.surfaces, null, argv[1], "md32glb");
    const v = validateGlb(argv[1]);
    console.log(`${argv[0]} -> ${argv[1]}: ${(bytes / 1024).toFixed(1)}KB, surfaces=${main.numSurfaces}`);
    console.log("  validate:", JSON.stringify(v.summary));
    return;
  }

  for (const w of WEAPONS) {
    const r = convertWeapon(w);
    console.log(`OK  weapon-${w}.glb  ${(r.bytes / 1024).toFixed(1)}KB  ${r.totalTris} tris  surfaces=[${r.surfaces.join(", ")}]`);
    console.log(`    tag_weapon origin=[${r.tagWeapon ? r.tagWeapon.origin.map((x) => +x.toFixed(3)).join(", ") : "none"}]`);
    console.log(`    validate: accessors=${r.valid.accessors} meshes=${r.valid.meshes} bytes=${r.valid.bytes}`);
  }
}

if (require.main === module) main();

module.exports = { parseMd3, buildGlb, decodeNormal };
