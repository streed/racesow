"use strict";
// Shared minimal binary glTF 2.0 (GLB) writer + re-parse validator.
// Modeled on tools/bsp2gltf/bsp2gltf.js — single BIN chunk, JSON chunk.
//
// GlbBuilder accumulates typed accessors into one binary buffer, tracks
// bufferViews/accessors, and lets callers assemble the glTF JSON object
// (nodes/meshes/skins/animations/materials/images/textures/samplers).
const fs = require("node:fs");

const COMPONENT = {
  BYTE: 5120, UNSIGNED_BYTE: 5121, SHORT: 5122, UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125, FLOAT: 5126,
};
const TARGET = { ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

class GlbBuilder {
  constructor() {
    this.chunks = [];      // Buffer[] appended to the BIN blob
    this.byteLength = 0;   // running length of BIN blob
    this.bufferViews = [];
    this.accessors = [];
  }

  // Append raw bytes to the BIN blob, 4-byte aligned. Returns byteOffset.
  _append(buf) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.byteLength += pad; }
    const off = this.byteLength;
    this.chunks.push(buf);
    this.byteLength += buf.length;
    return off;
  }

  _bufferView(buf, target) {
    const byteOffset = this._append(buf);
    const idx = this.bufferViews.length;
    const bv = { buffer: 0, byteOffset, byteLength: buf.length };
    if (target !== undefined) bv.target = target;
    this.bufferViews.push(bv);
    return idx;
  }

  // Add a typed accessor. `data` is a TypedArray. Returns accessor index.
  // opts: { type, componentType, target, normalized, computeMinMax }
  addAccessor(data, opts) {
    const { type, componentType, target, normalized, computeMinMax } = opts;
    const comps = TYPE_COUNT[type];
    const count = data.length / comps;
    if (!Number.isInteger(count)) {
      throw new Error(`accessor length ${data.length} not divisible by ${comps} for ${type}`);
    }
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const bvIndex = this._bufferView(buf, target);
    const accessor = { bufferView: bvIndex, byteOffset: 0, componentType, count, type };
    if (normalized) accessor.normalized = true;
    if (computeMinMax) {
      const min = new Array(comps).fill(Infinity);
      const max = new Array(comps).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < comps; k++) {
          const v = data[i * comps + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  // Append arbitrary bytes (e.g. an embedded PNG) as a bufferView; returns index.
  addBufferView(buf, target) {
    return this._bufferView(buf, target);
  }

  // Assemble & write the .glb given a partially-filled glTF object.
  // `gltf` must NOT already contain buffers/bufferViews/accessors — we merge.
  write(gltf, outPath) {
    const bin = Buffer.concat(this.chunks);
    const doc = Object.assign({}, gltf);
    doc.asset = doc.asset || { version: "2.0", generator: "model2glb" };
    doc.buffers = [{ byteLength: bin.length }];
    doc.bufferViews = this.bufferViews;
    doc.accessors = this.accessors;

    const jsonBuf = Buffer.from(JSON.stringify(doc), "utf8");
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
    const binPad = (4 - (bin.length % 4)) % 4;
    const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

    const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // "glTF"
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jsonHead = Buffer.alloc(8);
    jsonHead.writeUInt32LE(jsonChunk.length, 0);
    jsonHead.writeUInt32LE(0x4e4f534a, 4); // "JSON"
    const binHead = Buffer.alloc(8);
    binHead.writeUInt32LE(binChunk.length, 0);
    binHead.writeUInt32LE(0x004e4942, 4); // "BIN\0"

    fs.writeFileSync(outPath, Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]));
    return total;
  }
}

// Re-parse a .glb from disk: validate the 12-byte header, JSON + BIN chunks,
// and that every accessor's byte span fits inside its bufferView. Returns the
// parsed glTF doc plus a summary for logging.
function validateGlb(outPath) {
  const buf = fs.readFileSync(outPath);
  if (buf.length < 12) throw new Error("file too small");
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("bad magic (not glTF)");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`bad version ${version}`);
  const declaredTotal = buf.readUInt32LE(8);
  if (declaredTotal !== buf.length) {
    throw new Error(`header length ${declaredTotal} != file length ${buf.length}`);
  }

  let p = 12;
  let json = null;
  let binLen = 0;
  while (p < buf.length) {
    const chunkLen = buf.readUInt32LE(p);
    const chunkType = buf.readUInt32LE(p + 4);
    const start = p + 8;
    const end = start + chunkLen;
    if (end > buf.length) throw new Error("chunk overruns file");
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(buf.toString("utf8", start, end).replace(/\0+$/, "").trimEnd());
    } else if (chunkType === 0x004e4942) {
      binLen = chunkLen;
    }
    p = end;
  }
  if (!json) throw new Error("no JSON chunk");

  const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  for (let i = 0; i < (json.accessors || []).length; i++) {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const need = a.count * compCount[a.type] * compSize[a.componentType];
    const stride = bv.byteStride || 0;
    const spanFromStride = stride ? (a.count - 1) * stride + compCount[a.type] * compSize[a.componentType] : need;
    if ((a.byteOffset || 0) + spanFromStride > bv.byteLength) {
      throw new Error(`accessor ${i} (${a.type}) span ${spanFromStride} + off ${a.byteOffset || 0} > bufferView ${a.bufferView} len ${bv.byteLength}`);
    }
    if (bv.byteOffset + bv.byteLength > binLen && json.buffers[0].uri === undefined) {
      throw new Error(`bufferView ${a.bufferView} overruns BIN (${bv.byteOffset}+${bv.byteLength} > ${binLen})`);
    }
  }
  return {
    doc: json,
    summary: {
      bytes: buf.length,
      accessors: (json.accessors || []).length,
      bufferViews: (json.bufferViews || []).length,
      meshes: (json.meshes || []).length,
      skins: (json.skins || []).length,
      animations: (json.animations || []).map((a) => a.name),
      images: (json.images || []).length,
    },
  };
}

module.exports = { GlbBuilder, validateGlb, COMPONENT, TARGET };
