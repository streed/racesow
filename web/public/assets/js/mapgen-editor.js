// The map editor (/mapgen/editor): build a course spec by hand, see it in 3-D.
//
// The generator's input is a course SPEC (tools/mapgen/spec.py): the same
// small JSON the language model writes on /mapgen, a list of pieces laid end
// to end. This page builds that spec directly. Pick pieces from the palette,
// set their lengths, heights, angles and surface (grip or ice), and the course
// is laid out in the page by mapgen-course.js, the generator's own layout
// ported and pinned to it, so what you see is the brush set q3map2 will
// compile and the problems listed are the ones the generator would refuse it
// for. "Send for approval" puts the spec in the same queue a described map
// goes through, minus the language model: an admin approves it, then the
// worker compiles it.
//
// Lazily imported by app.js. mountEditor() returns a cleanup function that
// frees the WebGL context, the animation loop and every listener.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import * as mg from "./mapgen-course.js";
import * as tx from "./mapgen-textures.js";
import { PIECES, GROUPS, limits, fix, chipLabel, nudgeLabel, slug, STARTERS, adopt, HOTBAR, HOTKEYS, mirror, widthLimits } from "./mapgen-pieces.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// The rule tier a course built here is held to, and the two bands every
// control offers: see mapgen-pieces.js. The generator's band is what the
// sliders span and what new pieces are built from; the editor's is how far a
// number may be pushed by hand.
const RULES = "open";
const WIDTH_BAND = widthLimits(RULES);
const WIDTH_SOFT = widthLimits("strict");
const SEG_CAP = mg.tier(RULES).segments;
const BRUSH_CAP = mg.tier(RULES).brushes;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const secs = (u) => `${(u / mg.RUN_SPEED).toFixed(1)} s`;

/* ------------------------------ the pieces ------------------------------ */

const ICONS = {
  straight: '<path d="M7 3v18M17 3v18" /><path d="M12 5v3M12 11v3M12 17v2" stroke-dasharray="0" opacity=".6"/>',
  turn: '<path d="M6 21V12a6 6 0 0 1 6-6h9" /><path d="M10 21v-8a3 3 0 0 1 3-3h8" opacity=".55"/>',
  ramp: '<path d="M3 19h18L21 7z" /><path d="M8 19v-3" opacity=".55"/>',
  gap: '<path d="M2 12h7v8M22 12h-7v8" /><path d="M10 9c1-3 3-3 4 0" stroke-dasharray="2 2"/>',
  checkpoint: '<path d="M6 21V4" /><path d="M6 4h11l-3 4 3 4H6" />',
  slalom: '<path d="M3 6h9M12 12h9M3 18h9" /><path d="M18 3c-8 3 6 9-2 12s4 6 4 6" opacity=".55"/>',
  beam: '<path d="M11 3v18M13 3v18" /><path d="M4 3v18M20 3v18" opacity=".35" stroke-dasharray="2 3"/>',
  split: '<path d="M12 21v-6M12 15 6 9V3M12 15l6-6V3" />',
  wallclimb: '<path d="M3 20h8v-8h10" /><path d="M5 18l4-6 3 2" opacity=".55"/><path d="M21 4v8" />',
  wallgap: '<path d="M2 20h6M16 12h6v8" /><path d="M2 4h20" /><path d="M6 17c3-9 7-9 10-5" stroke-dasharray="2 2"/>',
  dash: '<path d="M3 12h13M12 7l5 5-5 5" /><path d="M3 7h5M3 17h5" opacity=".55"/>',
  ice: '<path d="M12 2v20M3.5 7l17 10M3.5 17l17-10" /><path d="M9 4l3 3 3-3M9 20l3-3 3 3" opacity=".7"/>',
  brush: '<path d="M14 4l6 6-8 8-6-6z" /><path d="M6 12l-2 6 6-2" /><path d="M4 21h5" opacity=".6"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5zM15 7l5 5-5 5z" />',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V6a2 2 0 0 1 2-2h10" />',
  combo: '<rect x="3" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /><rect x="15" y="9" width="6" height="6" rx="1" />',
};
const icon = (k) => `<svg class="mge-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ""}</svg>`;

/* ---------------------------- the 3-D view ------------------------------ */

// Quake is Z-up; three.js is Y-up. Same transform as replay.js.
const q2t = (x, y, z) => [x, z, -y];
const TEX_SCALE = 256;
// mapfile.brush_lines: only these wear the wall texture on their sides.
const SIDES_AS_WALL = new Set(["floor", "ice", "start", "finish", "edge", "trim", "checkpoint"]);
const TEXKIND = { platform: "edge", beam: "edge" };   // layout.TEX
// Quake's base texture axes: [normal, s, t] (q3map2 / textureAxisFromPlane).
const BASE_AXES = [
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
];

// Texture coordinates for a point on a face, the way q3map2 projects a
// brush face in the format mapfile.py writes: the base axes of the face's
// dominant direction, turned by `rot` degrees, mirrored where mapfile mirrors.
function texAxes(n, rot) {
  let best = 0, bestDot = -Infinity;
  BASE_AXES.forEach(([a], i) => {
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    if (d > bestDot) { bestDot = d; best = i; }
  });
  const [, s0, t0] = BASE_AXES[best];
  const sv = s0[0] ? 0 : s0[1] ? 1 : 2;
  const tv = t0[0] ? 0 : t0[1] ? 1 : 2;
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r), si = Math.sin(r);
  const turn = (v) => {
    const o = [...v];
    o[sv] = c * v[sv] - si * v[tv];
    o[tv] = si * v[sv] + c * v[tv];
    return o;
  };
  const s = turn(s0), t = turn(t0);
  // mapfile._mirrored: walls facing -X or +Y read mirror-image unflipped.
  const [nx, ny, nz] = n;
  const mirrored = Math.abs(nz) > Math.max(Math.abs(nx), Math.abs(ny)) ? false
    : Math.abs(nx) >= Math.abs(ny) ? nx < 0 : ny > 0;
  const sx = mirrored ? -1 : 1;
  return (p) => [sx * (p[0] * s[0] + p[1] * s[1] + p[2] * s[2]) / TEX_SCALE,
    (p[0] * t[0] + p[1] * t[1] + p[2] * t[2]) / TEX_SCALE];
}

class Bucket {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.seg = []; }
  tri(a, b, c, n, uvOf, seg) {
    for (const p of [a, b, c]) {
      this.pos.push(...q2t(...p));
      this.nrm.push(...q2t(...n));
      this.uv.push(...uvOf(p));
      this.seg.push(seg);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aSeg", new THREE.Float32BufferAttribute(this.seg, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function addPrism(buckets, p) {
  const kind = TEXKIND[p.tex] || p.tex;
  const sideKind = SIDES_AS_WALL.has(p.tex) ? "wall" : kind;
  const seg = p.seg === null ? -9 : p.seg;
  const bucket = (k) => buckets.get(k) || buckets.set(k, new Bucket()).get(k);
  // The brush's real corners: a rolled or pitched piece is not its footprint,
  // and a preview drawn from the footprint would show something the compiler
  // will not build — which makes the control a trap rather than a tool.
  const [bot, top] = p.corners();
  // Every normal turns with the brush, or the lighting lies about the shape.
  const turn = p.tilt ? (d) => mg.rotateDir(p.tilt[1], d) : (d) => d;
  const n = p.poly.length;
  // Top: the plane's own normal (sloped on a ramp).
  const tl = Math.hypot(p.gx, p.gy, 1);
  const tn = turn([-p.gx / tl, -p.gy / tl, 1 / tl]);
  const rot = p.heading === null ? 0 : p.heading - 90;
  let uv = texAxes(tn, rot);
  for (let i = 1; i < n - 1; i++) bucket(kind).tri(top[0], top[i], top[i + 1], tn, uv, seg);
  const bn = turn([0, 0, -1]);
  uv = texAxes(bn, 0);
  for (let i = 1; i < n - 1; i++) bucket(sideKind).tri(bot[0], bot[i + 1], bot[i], bn, uv, seg);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay] = p.poly[i], [bx, by] = p.poly[j];
    const L = Math.hypot(by - ay, bx - ax) || 1;
    const out = turn([(by - ay) / L, -(bx - ax) / L, 0]);
    uv = texAxes(out, 0);
    const b = bucket(sideKind);
    b.tri(bot[i], bot[j], top[j], out, uv, seg);
    b.tri(bot[i], top[j], top[i], out, uv, seg);
  }
}

class View {
  constructor(stage, { onPick, onHover }) {
    this.stage = stage;
    this.onPick = onPick;
    this.onHover = onHover;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 8, 200000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener("change", () => this.dirty());

    // q3map_sun 1 0.97 0.9 25 35 55 (assets.SHADER): warm, yaw 35, 55 up.
    const yaw = (35 * Math.PI) / 180, el = (55 * Math.PI) / 180;
    const sun = new THREE.DirectionalLight(0xfff7e6, 1.9);
    sun.position.set(...q2t(Math.cos(el) * Math.cos(yaw), Math.cos(el) * Math.sin(yaw), Math.sin(el)));
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xc9d6ff, 0x3a2a20, 1.25));

    this.uniforms = { uSelLo: { value: -100 }, uSelHi: { value: -100 }, uHover: { value: -100 },
      uBad: { value: new THREE.Vector4(-100, -100, -100, -100) } };
    this.materials = new Map();
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    for (const kind of tx.KINDS) {
      const t = new THREE.DataTexture(tx.rgba(kind), tx.SIZE, tx.SIZE, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = aniso;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      const m = new THREE.MeshLambertMaterial({ map: t });
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, this.uniforms);
        sh.vertexShader = "attribute float aSeg;\nvarying float vSeg;\n" +
          sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvSeg = aSeg;");
        sh.fragmentShader = "uniform float uSelLo;\nuniform float uSelHi;\nuniform float uHover;\nuniform vec4 uBad;\nvarying float vSeg;\n" +
          sh.fragmentShader.replace("#include <dithering_fragment>", `#include <dithering_fragment>
            vec3 hot = vec3(1.0, 0.42, 0.10);
            if (vSeg > uSelLo - 0.5 && vSeg < uSelHi + 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, hot, 0.38);
            else if (abs(vSeg - uHover) < 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, hot, 0.16);
            if (abs(vSeg - uBad.x) < 0.5 || abs(vSeg - uBad.y) < 0.5 || abs(vSeg - uBad.z) < 0.5 || abs(vSeg - uBad.w) < 0.5)
              gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.18, 0.18), 0.5);`);
      };
      this.materials.set(kind, m);
    }
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.extras = new THREE.Group();
    this.scene.add(this.extras);
    // The piece preview: what is about to be placed, see-through, where it
    // will go, and an arrow at the point the next piece attaches. Not called a
    // ghost: in racesow a ghost is a recorded run.
    this.previewGroup = new THREE.Group();
    this.scene.add(this.previewGroup);
    this.previewMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.32, depthWrite: false });
    this.cursor = new THREE.Group();
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(40, 110, 4), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    arrow.rotation.z = -Math.PI / 2;   // point along +x before the heading turns it
    arrow.position.set(40, 0, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(70, 6, 6, 24), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    ring.rotation.y = Math.PI / 2;
    this.cursor.add(arrow, ring);
    this.cursor.visible = false;
    this.scene.add(this.cursor);
    this.meshes = [];
    this.course = null;
    this.framed = false;

    this.ray = new THREE.Raycaster();
    this.ptr = new THREE.Vector2();
    const el2 = this.renderer.domElement;
    let down = null;
    this.onDown = (e) => { down = [e.clientX, e.clientY]; };
    this.onUp = (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      this.onPick(this.pick(e), e);
    };
    this.onMove = (e) => {
      if (e.buttons) return;
      const s = this.pick(e);
      if (s !== this.hovered) { this.hovered = s; this.onHover(s); }
    };
    el2.addEventListener("pointerdown", this.onDown);
    el2.addEventListener("pointerup", this.onUp);
    el2.addEventListener("pointermove", this.onMove);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(stage);
    this.resize();
    this.needs = true;
    this.last = performance.now();
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      const raw = Math.max(0, (t - this.last) / 1000);
      const dt = Math.min(0.1, raw);
      this.last = t;
      if (this.fly) this.stepFly(dt);
      if (this.controls.update() || this.needs || this.fly) {
        this.needs = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  dirty() { this.needs = true; }

  resize() {
    const w = this.stage.clientWidth || 1, h = this.stage.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty();
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    const hit = this.ray.intersectObjects(this.meshes, false)[0];
    if (!hit) return null;
    const s = hit.object.geometry.attributes.aSeg.getX(hit.face.a);
    return s < -1 ? null : s;
  }

  setCourse(course) {
    for (const m of this.meshes) m.geometry.dispose();
    this.group.clear();
    this.meshes = [];
    this.extras.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.lineMat) o.material.dispose?.(); });
    this.extras.clear();
    this.course = course;
    if (!course) { this.dirty(); return; }
    const buckets = new Map();
    for (const p of course.world) if (p.tex !== "sky" && p.tex !== "trigger") addPrism(buckets, p);
    for (const [kind, b] of buckets) {
      const mesh = new THREE.Mesh(b.geometry(), this.materials.get(kind) || this.materials.get("floor"));
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    // The centre line, a little above the floor.
    const pts = course.route.map(([x, y, z]) => new THREE.Vector3(...q2t(x, y, z + 6)));
    if (pts.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 48, gapSize: 32, transparent: true, opacity: 0.55 }));
      line.computeLineDistances();
      this.extras.add(line);
    }
    // A player, for scale: the 32 x 32 x 64 box at the spawn point.
    const spawn = course.entities.find(([e]) => e.classname === "info_player_deathmatch");
    if (spawn) {
      const [x, y, z] = spawn[0].origin;
      const box = new THREE.Mesh(new THREE.BoxGeometry(32, 64, 32),
        new THREE.MeshLambertMaterial({ color: 0xff6a1a, emissive: 0x401800 }));
      box.position.set(...q2t(x, y, z - 40 + 32));
      this.extras.add(box);
    }
    if (!this.framed) { this.frame(); this.framed = true; }
    this.dirty();
  }

  extent(seg = null) {
    const box = new THREE.Box3();
    if (!this.course) return box;
    for (const p of this.course.world) {
      if (p.tex === "sky" || p.tex === "trigger" || (seg !== null && p.seg !== seg)) continue;
      for (const ring of p.corners()) {
        for (const [x, y, z] of ring) box.expandByPoint(new THREE.Vector3(...q2t(x, y, z)));
      }
    }
    return box;
  }

  // Move the camera to look at a box, from the side it is on now (or from
  // above and behind the start on the first frame).
  flyTo(box, { top = false, instant = false } = {}) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z, size.y * 2, 600) * 0.5;
    const d = r / Math.tan((this.camera.fov * Math.PI) / 360) * 1.15;
    let dir;
    if (top) dir = new THREE.Vector3(0.0001, 1, 0.0001);
    else if (!this.framed) dir = new THREE.Vector3(-0.55, 0.75, 0.6);
    else dir = this.camera.position.clone().sub(this.controls.target);
    dir.normalize();
    if (dir.y < 0.25) { dir.y = 0.25; dir.normalize(); }
    const to = { target: c, pos: c.clone().add(dir.multiplyScalar(d)) };
    if (instant) {
      this.controls.target.copy(to.target);
      this.camera.position.copy(to.pos);
      this.dirty();
      return;
    }
    this.fly = { t: 0, from: { target: this.controls.target.clone(), pos: this.camera.position.clone() }, to };
  }

  stepFly(dt) {
    const f = this.fly;
    f.t = Math.min(1, f.t + dt / 0.45);
    const k = f.t * f.t * (3 - 2 * f.t);
    this.controls.target.lerpVectors(f.from.target, f.to.target, k);
    this.camera.position.lerpVectors(f.from.pos, f.to.pos, k);
    if (f.t >= 1) this.fly = null;
  }

  frame(top = false) { this.flyTo(this.extent(), { top, instant: !this.framed }); }
  focus(seg) { this.flyTo(this.extent(seg)); }

  highlight({ selected = null, range = null, bad = [] }) {
    const [lo, hi] = range || (selected === null ? [-100, -100] : [selected, selected]);
    this.uniforms.uSelLo.value = lo;
    this.uniforms.uSelHi.value = hi;
    const b = [...bad, -100, -100, -100, -100];
    this.uniforms.uBad.value.set(b[0], b[1], b[2], b[3]);
    this.dirty();
  }
  hover(seg) { this.uniforms.uHover.value = seg ?? -100; this.dirty(); }

  // The see-through preview of pieces about to be placed (prisms of a
  // preview layout), or nothing.
  setPreview(prisms) {
    for (const m of this.previewGroup.children) m.geometry.dispose();
    this.previewGroup.clear();
    if (prisms && prisms.length) {
      const buckets = new Map();
      for (const p of prisms) if (p.tex !== "trigger" && p.tex !== "sky") addPrism(buckets, p);
      for (const b of buckets.values()) this.previewGroup.add(new THREE.Mesh(b.geometry(), this.previewMat));
    }
    this.dirty();
  }

  // The arrow where the next piece attaches: { x, y, z, heading } or null.
  setCursor(pose) {
    this.cursor.visible = !!pose;
    if (pose) {
      this.cursor.position.set(...q2t(pose.x, pose.y, pose.z + 70));
      this.cursor.rotation.y = (pose.heading * Math.PI) / 180;
    }
    this.dirty();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointermove", this.onMove);
    this.setCourse(null);
    this.setPreview(null);
    this.previewMat.dispose();
    this.controls.dispose();
    for (const m of this.materials.values()) { m.map.dispose(); m.dispose(); }
    this.renderer.dispose();
    el.remove();
  }
}

/* ------------------------------ the editor ------------------------------ */

const DRAFT_KEY = "racesow.mapgen.editor.draft";
const loadDraft = () => {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
};
const saveDraft = (spec) => {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(spec)); } catch { /* private window: no draft */ }
};

// Per-browser conveniences, each read and written defensively: a private
// window or blocked storage just means they start empty.
const store = {
  get(key, dflt) { try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? dflt; } catch { return dflt; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } },
};
// A combo is a saved stretch of pieces, placed again from the palette. Its
// storage key and the mge-macro* class names keep the older spelling: renaming
// the key would drop what a browser has already saved, and the classes are
// style.css's.
const COMBOS_KEY = "racesow.mapgen.editor.macros";
const LIBRARY_KEY = "racesow.mapgen.editor.library";
const CLIP_KEY = "racesow.mapgen.editor.clipboard";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function mountEditor(root, { initial = null, initialNote = "", go = null, track = () => {} } = {}) {
  let spec;
  let notes = [];
  if (initial) {
    try { [spec, notes] = adopt(initial); } catch (e) { notes = [e.message]; }
  }
  if (!spec) spec = loadDraft() && (() => { try { return adopt(loadDraft())[0]; } catch { return null; } })();
  if (!spec) spec = structuredClone(STARTERS.first_light);

  // selected: the piece the inspector edits (and the anchor of a range);
  // rangeEnd: the other end of a shift-selected range, or null.
  const st = { spec, selected: null, rangeEnd: null, surface: "grip", paint: false, undo: [], redo: [], result: null, quota: null };

  root.innerHTML = `
    <div class="mge-bar panel">
      <label class="mge-field mge-title"><span>Title</span>
        <input id="mge-title" type="text" maxlength="40" autocomplete="off" spellcheck="false"></label>
      <label class="mge-field mge-width"><span>Corridor width <b id="mge-wv"></b></span>
        <span class="mge-wctl">
          <input id="mge-width" type="range" min="${mg.WIDTH_MIN}" max="${mg.WIDTH_MAX}" step="16">
          <input id="mge-widthn" type="number" min="${WIDTH_BAND[0]}" max="${WIDTH_BAND[1]}" step="16"
            aria-label="Corridor width in units"></span></label>
      <div class="mge-actions">
        <button type="button" class="btn mge-ib" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button type="button" class="btn mge-ib" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
        <details class="mge-menu"><summary class="btn">Course ▾</summary><div class="mge-pop panel">
          <button type="button" data-act="new">New blank course</button>
          <button type="button" class="mge-danger" data-act="clearall">Clear the whole course…</button>
          <div class="mge-sep">Start from</div>
          <button type="button" data-starter="first_light">First Light</button>
          <button type="button" data-starter="ice_run">Glacier Run (ice)</button>
          <button type="button" data-starter="tricks">Kick and Dash (wall jumps)</button>
          <div class="mge-sep">Spec JSON</div>
          <button type="button" data-act="import">Import / paste JSON…</button>
          <button type="button" data-act="download">Download spec.json</button>
          <button type="button" data-act="copy">Copy JSON</button>
          <div class="mge-sep">My courses (this browser)</div>
          <button type="button" data-act="save">Save this course</button>
          <div id="mge-lib"></div>
        </div></details>
        <button type="button" class="btn mg-submit mge-build" data-act="build">Send for approval</button>
      </div>
    </div>
    <aside class="mge-pal panel" aria-label="Pieces">
      <div class="mge-h">Add a piece</div>
      <div class="mge-surfrow">
        <div class="mge-surface" role="radiogroup" aria-label="Surface for new pieces and the paint brush">
          <button type="button" role="radio" data-surface="grip">Grip</button>
          <button type="button" role="radio" data-surface="ice">${icon("ice")} Ice</button>
        </div>
        <button type="button" class="mge-paint" data-act="paint" aria-pressed="false"
          title="Paint: click pieces to give them this surface (B)">${icon("brush")}</button>
      </div>
      ${GROUPS.map(([g, keys]) => `<div class="mge-group">${esc(g)}</div>` + keys.map((k) => `
        <button type="button" class="mge-piece" draggable="true" data-add="${k}" title="${esc(PIECES[k].hint)}">
          ${icon(k)}<span><b>${esc(PIECES[k].name)}</b><small>${esc(PIECES[k].hint)}</small></span>
          <kbd>${esc(HOTKEYS[HOTBAR.indexOf(k)])}</kbd></button>`).join("")).join("")}
      <div class="mge-group">My combos</div>
      <div id="mge-macros" class="mge-macros"></div>
    </aside>
    <section class="mge-view panel">
      <div class="mge-stage" id="mge-stage"></div>
      <div class="mge-vbar">
        <button type="button" class="rv-btn" data-act="frame" title="Fit the whole course (F)">Fit</button>
        <button type="button" class="rv-btn" data-act="top" title="Look straight down (T)">Top</button>
        <button type="button" class="rv-btn" data-act="focus" title="Look at the selected piece">Selected</button>
        <span class="mge-hint">Drag to orbit · right-drag to pan · scroll to zoom · click a piece to edit it</span>
      </div>
    </section>
    <aside class="mge-insp panel" id="mge-insp" aria-label="Selected piece"></aside>
    <section class="mge-strip panel" aria-label="Course">
      <div class="mge-h">Course <small>drag to reorder · Delete removes · ←/→ select</small></div>
      <ol class="mge-chips" id="mge-chips"></ol>
    </section>
    <section class="mge-report panel" id="mge-report" aria-live="polite"></section>
    <dialog class="mge-dlg panel mge-confirm" id="mge-clear">
      <form method="dialog">
        <div class="mge-h">Clear the whole course?</div>
        <p class="mge-note">This removes every piece and leaves one straight to start again from.
          The title and the corridor width are kept.</p>
        <p class="mge-note">Ctrl+Z puts it back if you change your mind.</p>
        <div class="mge-dlg-row">
          <span class="mge-grow"></span>
          <button type="button" class="btn" value="cancel" data-act="closeclear">Keep it</button>
          <button type="button" class="btn mge-del" data-act="doclear">Clear <b id="mge-clearn"></b></button>
        </div>
      </form>
    </dialog>
    <dialog class="mge-dlg panel" id="mge-dlg">
      <form method="dialog">
        <div class="mge-h">Import a course spec</div>
        <p class="mge-note">Paste the JSON the generator uses: a <code>{"title", "width", "segments": [...]}</code> object.
          A spec from a generated map, a downloaded <code>spec.json</code> or a model's reply all work.</p>
        <textarea id="mge-json" rows="12" spellcheck="false" placeholder='{"title": "My Course", "width": 384, "segments": [{"type": "straight", "length": 1024}]}'></textarea>
        <div class="mge-dlg-row">
          <label class="btn mge-file">Open a file…<input type="file" id="mge-file" accept=".json,application/json" hidden></label>
          <span class="flag-msg" id="mge-imsg"></span>
          <span class="mge-grow"></span>
          <button type="button" class="btn" value="cancel" data-act="close">Cancel</button>
          <button type="button" class="btn mg-submit" data-act="doimport">Load it</button>
        </div>
      </form>
    </dialog>`;

  const $ = (sel) => root.querySelector(sel);
  const titleIn = $("#mge-title"), widthIn = $("#mge-width"), widthV = $("#mge-wv");
  const widthN = $("#mge-widthn");
  const clearDlg = $("#mge-clear");
  const chipsEl = $("#mge-chips"), inspEl = $("#mge-insp"), reportEl = $("#mge-report");
  const dlg = $("#mge-dlg");

  const view = new View($("#mge-stage"), {
    onPick: (s, e) => {
      const n = st.spec.segments.length;
      const i = s !== null && s >= 0 && s < n ? s : null;
      if (st.paint) return i !== null && paint(i);
      select(i, { focus: false, extend: !!(e && e.shiftKey) });
    },
    onHover: (s) => view.hover(s !== null && s >= 0 && s < st.spec.segments.length ? s : null),
  });

  /* -- state ------------------------------------------------------------ */
  const fullSpec = (s = st.spec) => ({ name: slug(s.title), title: s.title, width: s.width, segments: s.segments });

  function commit(next, { select: sel = st.selected, record = true, keepRange = false } = {}) {
    if (record) {
      st.undo.push(JSON.stringify({ spec: st.spec, selected: st.selected }));
      if (st.undo.length > 200) st.undo.shift();
      st.redo = [];
    }
    st.spec = next;
    st.selected = sel !== null && sel >= 0 && sel < next.segments.length ? sel : null;
    if (!keepRange || st.rangeEnd === null || st.rangeEnd >= next.segments.length) st.rangeEnd = null;
    saveDraft(st.spec);
    refresh();
  }
  function travel(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify({ spec: st.spec, selected: st.selected }));
    const s = JSON.parse(from.pop());
    st.spec = s.spec;
    st.selected = s.selected;
    st.rangeEnd = null;
    saveDraft(st.spec);
    refresh();
  }
  const withSegs = (fn) => {
    const segs = st.spec.segments.map((s) => ({ ...s }));
    const r = fn(segs);
    return [{ ...st.spec, segments: segs }, r];
  };

  function addPiece(kind, at = null) {
    const p = PIECES[kind];
    const need = p.needs && p.needs(st.spec.width);
    if (need) return flash(`${p.name} ${need}: widen the corridor first.`);
    if (st.spec.segments.length >= SEG_CAP) return flash(`A course has at most ${SEG_CAP} pieces.`);
    let seg = p.make(st.spec.width);
    if (st.surface === "ice" && mg.ICEABLE.includes(kind)) seg.ice = true;
    seg = fix(seg, st.spec.width, RULES);
    const i = at ?? (st.selected === null ? st.spec.segments.length : st.selected + 1);
    const [next] = withSegs((segs) => segs.splice(i, 0, seg));
    commit(next, { select: i });
    track("Map editor add", { piece: kind });
  }
  function removePiece(i) {
    if (i === null) return;
    if (st.spec.segments.length <= 1) return flash("A course needs at least one piece.");
    const [next] = withSegs((segs) => segs.splice(i, 1));
    commit(next, { select: Math.min(i, next.segments.length - 1) });
  }
  function movePiece(i, to) {
    if (i === null || to < 0 || to >= st.spec.segments.length || to === i) return;
    const [next] = withSegs((segs) => { const [s] = segs.splice(i, 1); segs.splice(to, 0, s); });
    commit(next, { select: to });
  }
  function duplicate(i) {
    if (i === null || st.spec.segments.length >= SEG_CAP) return;
    const [next] = withSegs((segs) => segs.splice(i + 1, 0, { ...segs[i] }));
    commit(next, { select: i + 1 });
  }
  // Change fields of the selected piece. `live` edits (a slider being
  // dragged) replace the current state without an undo step; the change
  // event that ends the drag records one.
  let liveBase = null;
  function setFields(i, patch, { live = false } = {}) {
    if (live && !liveBase) liveBase = JSON.stringify({ spec: st.spec, selected: st.selected });
    const [next] = withSegs((segs) => { segs[i] = fix({ ...segs[i], ...patch }, st.spec.width, RULES); });
    if (live) {
      st.spec = next;
      scheduleRefresh();
      return;
    }
    if (liveBase) {
      st.undo.push(liveBase);
      st.redo = [];
      liveBase = null;
      st.spec = next;
      saveDraft(st.spec);
      refresh();
    } else {
      commit(next);
    }
  }
  function setWidth(w, live) {
    if (live && !liveBase) liveBase = JSON.stringify({ spec: st.spec, selected: st.selected });
    const segs = st.spec.segments.map((s) => fix(s, w, RULES));
    const next = { ...st.spec, width: w, segments: segs };
    if (live) { st.spec = next; scheduleRefresh(); return; }
    if (liveBase) { st.undo.push(liveBase); st.redo = []; liveBase = null; st.spec = next; saveDraft(next); refresh(); }
    else commit(next);
  }

  // The selection as an inclusive [first, last], or null.
  const selRange = () => {
    if (st.selected === null) return null;
    const b = st.rangeEnd === null ? st.selected : st.rangeEnd;
    return [Math.min(st.selected, b), Math.max(st.selected, b)];
  };

  /* -- piece tools: copy/paste, mirror, combos, paint ------------------- */
  function copySel({ cut = false } = {}) {
    const r = selRange();
    if (!r) return flash("Select pieces first (shift-click to select a stretch of them).");
    const clip = st.spec.segments.slice(r[0], r[1] + 1).map((x) => ({ ...x }));
    store.set(CLIP_KEY, clip);
    if (cut) {
      if (clip.length >= st.spec.segments.length) return flash("A course needs at least one piece.");
      const [next] = withSegs((segs) => segs.splice(r[0], clip.length));
      commit(next, { select: Math.min(r[0], next.segments.length - 1) });
    }
    flash(`${cut ? "Cut" : "Copied"} ${clip.length} piece${clip.length === 1 ? "" : "s"}. Ctrl+V pastes after the selection.`);
  }
  function insertPieces(pieces, at = null, label = "Pasted") {
    const segs0 = (pieces || []).filter((x) => x && PIECES[x.type]).map((x) => fix(x, st.spec.width, RULES));
    if (!segs0.length) return flash("Nothing to paste yet: copy some pieces with Ctrl+C.");
    if (st.spec.segments.length + segs0.length > SEG_CAP) return flash(`That would make more than ${SEG_CAP} pieces.`);
    const r = selRange();
    const i = at ?? (r ? r[1] + 1 : st.spec.segments.length);
    const [next] = withSegs((segs) => segs.splice(i, 0, ...segs0));
    st.rangeEnd = i + segs0.length - 1;
    commit(next, { select: i, keepRange: true });
    flash(`${label} ${segs0.length} piece${segs0.length === 1 ? "" : "s"}.`);
  }
  function mirrorSel() {
    const r = selRange() || [0, st.spec.segments.length - 1];
    const [next] = withSegs((segs) => { for (let i = r[0]; i <= r[1]; i++) segs[i] = mirror(segs[i]); });
    commit(next, { keepRange: true });
    flash(selRange() ? "Mirrored the selection." : "Mirrored the whole course.");
  }
  function surfaceSel(ice) {
    const r = selRange();
    if (!r) return;
    const [next] = withSegs((segs) => {
      for (let i = r[0]; i <= r[1]; i++) segs[i] = fix({ ...segs[i], ice }, st.spec.width, RULES);
    });
    commit(next, { keepRange: true });
  }
  function paint(i) {
    const s = st.spec.segments[i];
    if (!mg.ICEABLE.includes(s.type)) return flash(`${PIECES[s.type].name} keeps its grip: only ${mg.ICEABLE.join(", ")} take ice.`);
    const ice = st.surface === "ice";
    if (!!s.ice === ice) return;
    setFields(i, { ice });
  }
  const combos = () => store.get(COMBOS_KEY, []).filter((m) => m && Array.isArray(m.segments));
  function saveCombo() {
    const r = selRange();
    if (!r) return flash("Select the pieces to save first (shift-click a stretch of them).");
    const name = (window.prompt("Name this combo:", `${PIECES[st.spec.segments[r[0]].type].name} combo`) || "").trim().slice(0, 40);
    if (!name) return;
    const list = [{ name, segments: st.spec.segments.slice(r[0], r[1] + 1) }, ...combos()].slice(0, 30);
    if (!store.set(COMBOS_KEY, list)) return flash("This browser won't store combos (private window?).");
    renderCombos();
    flash(`Saved "${name}" to My combos.`);
  }
  function renderCombos() {
    const el = $("#mge-macros");
    const list = combos();
    el.innerHTML = list.length ? list.map((m, k) => `<div class="mge-macro">
        <button type="button" class="mge-piece" data-combo="${k}" title="Insert ${esc(m.name)}">${icon("combo")}
          <span><b>${esc(m.name)}</b><small>${m.segments.length} piece${m.segments.length === 1 ? "" : "s"}</small></span></button>
        <button type="button" class="mge-x" data-delcombo="${k}" aria-label="Delete ${esc(m.name)}">×</button></div>`).join("")
      : `<p class="mge-note">Select a stretch of pieces (shift-click) and save it as a combo to place again.</p>`;
  }
  const library = () => store.get(LIBRARY_KEY, []).filter((c) => c && c.spec && Array.isArray(c.spec.segments));
  function saveToLibrary() {
    const list = library().filter((c) => c.spec.title !== st.spec.title);
    list.unshift({ spec: st.spec, savedAt: Date.now() });
    if (!store.set(LIBRARY_KEY, list.slice(0, 30))) return flash("This browser won't store courses (private window?).");
    renderLibrary();
    flash(`Saved "${st.spec.title}" to My courses.`);
  }
  function renderLibrary() {
    const list = library();
    $("#mge-lib").innerHTML = list.length ? list.map((c, k) => `<div class="mge-libitem">
        <button type="button" data-lib="${k}">${esc(c.spec.title)} <small>${c.spec.segments.length} pieces</small></button>
        <button type="button" class="mge-x" data-dellib="${k}" aria-label="Delete ${esc(c.spec.title)}">×</button></div>`).join("")
      : `<p class="mge-note">Nothing saved yet.</p>`;
  }

  // The piece preview: what pieces would be placed, see-through, where.
  function showPreview(pieces) {
    if (!pieces) return view.setPreview(null);
    const r = selRange();
    const i = r ? r[1] + 1 : st.spec.segments.length;
    const segs = [...st.spec.segments];
    segs.splice(i, 0, ...pieces.map((x) => fix(x, st.spec.width, RULES)));
    const g = mg.preview({ ...fullSpec(), segments: segs.slice(0, mg.tier(RULES).segments) }, RULES);
    if (!g.course) return view.setPreview(null);
    view.setPreview(g.course.world.filter((p) => p.seg !== null && p.seg >= i && p.seg < i + pieces.length));
  }
  function updateCursor() {
    const c = st.result && st.result.course;
    const r = selRange();
    const at = r ? r[1] + 1 : st.spec.segments.length;
    view.setCursor(c && c.segStart[at] ? c.segStart[at] : null);
  }

  function select(i, { focus = true, extend = false } = {}) {
    if (extend && st.selected !== null && i !== null) {
      st.rangeEnd = i === st.selected ? null : i;
    } else {
      st.selected = i;
      st.rangeEnd = null;
    }
    renderChips();
    renderInspector();
    view.highlight({ range: selRange(), bad: badSegs() });
    updateCursor();
    if (focus && i !== null && !extend) view.focus(i);
    const chip = chipsEl.querySelector(`[data-i="${i}"]`);
    if (chip) chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  let msgTimer = null;
  function flash(text) {
    const el = $(".mge-flash") || Object.assign(document.createElement("div"), { className: "mge-flash" });
    el.textContent = text;
    $(".mge-view").appendChild(el);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => el.remove(), 3200);
  }

  /* -- layout + render ---------------------------------------------------- */
  let rafPending = false;
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; refresh({ inspector: false }); });
  }

  function badSegs() {
    const r = st.result;
    if (!r) return [];
    if (r.course && r.course.collision) return r.course.collision;
    const out = new Set();
    for (const p of r.problems) for (const m of p.matchAll(/segment (\d+)/g)) out.add(Number(m[1]));
    return [...out].slice(0, 4);
  }

  function refresh({ inspector = true } = {}) {
    const full = fullSpec();
    const geo = mg.preview(full, RULES);
    const words = mg.validate(full, RULES).filter((p) => p.startsWith("name ") || p.startsWith("title "));
    // The open tier keeps the pieces-fit-together findings as notes instead
    // of refusing over them; the report shows them as advice.
    st.result = { problems: [...words, ...geo.problems], course: geo.course, notes: geo.notes || [] };
    if (geo.course) view.setCourse(geo.course);
    view.highlight({ range: selRange(), bad: badSegs() });
    updateCursor();
    const pb = $('[data-act="paint"]');
    pb.setAttribute("aria-pressed", String(st.paint));
    $("#mge-stage").classList.toggle("painting", st.paint);
    if (document.activeElement !== titleIn) titleIn.value = st.spec.title;
    titleIn.classList.toggle("bad", !mg.TITLE_RE.test(st.spec.title) || st.spec.title.includes("  "));
    widthIn.value = st.spec.width;
    // The slider spans the suggested band, stretched to hold a width that is
    // already outside it; the number box spans everything allowed.
    widthIn.min = Math.min(WIDTH_SOFT[0], st.spec.width);
    widthIn.max = Math.max(WIDTH_SOFT[1], st.spec.width);
    if (document.activeElement !== widthN) widthN.value = st.spec.width;
    widthV.textContent = `${st.spec.width}`;
    root.querySelectorAll("[data-surface]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.surface === st.surface)));
    root.querySelectorAll("[data-add]").forEach((b) => {
      const need = PIECES[b.dataset.add].needs && PIECES[b.dataset.add].needs(st.spec.width);
      b.classList.toggle("off", !!need);
      b.title = need ? `${PIECES[b.dataset.add].name} ${need}` : PIECES[b.dataset.add].hint;
    });
    $('[data-act="undo"]').disabled = !st.undo.length;
    $('[data-act="redo"]').disabled = !st.redo.length;
    renderChips();
    if (inspector) renderInspector();
    else updateInspectorReadouts();
    renderReport();
  }

  function renderChips() {
    const bad = new Set(badSegs());
    const r = selRange();
    const inSel = (i) => r !== null && i >= r[0] && i <= r[1];
    const segs = st.spec.segments;
    chipsEl.innerHTML = `<li class="mge-chip end start" aria-label="Start room">${icon("checkpoint")}<span>Start</span></li>` +
      segs.map((s, i) => `<li class="mge-chip${inSel(i) ? " on" : ""}${bad.has(i) ? " bad" : ""}${s.ice ? " ice" : ""}${s.open ? " open" : ""}"
          draggable="true" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === st.selected}"
          title="${esc(PIECES[s.type].name)} (piece ${i})">
          <em>${i}</em>${icon(s.type)}<span><b>${esc(PIECES[s.type].name)}</b><small>${esc(chipLabel(s))}${s.ice ? " ❄" : ""}${
            mg.NUDGE.some((k) => s[k]) ? ` ${esc(nudgeLabel(s))}` : ""}</small></span></li>`).join("") +
      `<li class="mge-chip end finish" aria-label="Finish room">${icon("checkpoint")}<span>Finish</span></li>`;
  }

  // Two bands, and the difference is the point: the number box spans
  // everything this piece MAY be, and the slider spans the band it probably
  // SHOULD be — the generator's own, which is fine-grained enough to be worth
  // dragging. A value already outside the suggested band stretches the
  // slider to include it rather than being silently clamped back, so a
  // deliberate choice survives being touched.
  function bands(key, val, hard, soft, invert) {
    const h = invert ? [-hard[1], -hard[0]] : hard;
    const s0 = soft && soft[key] ? (invert ? [-soft[key][1], -soft[key][0]] : soft[key]) : h;
    const v = invert ? -val : val;
    let band = [Math.max(h[0], Math.min(s0[0], v)), Math.min(h[1], Math.max(s0[1], v))];
    // A field the generator never uses has a zero-wide suggested band, which
    // would leave a slider with nothing to drag; give it the whole range.
    if (band[0] === band[1] && h[0] !== h[1]) band = [h[0], h[1]];
    // A field the generator never uses is not "beyond" anything — the hint
    // already says whose control it is, and flagging every use of it would
    // make the warning permanent and therefore worthless.
    const editorOnly = s0[0] === 0 && s0[1] === 0;
    return { hard: h, soft: s0, band, outside: !editorOnly && (v < s0[0] || v > s0[1]) };
  }

  function slider(key, label, val, hard, { step = 1, unit = "", note = "", invert = false, soft = null } = {}) {
    const b = bands(key, val, hard, soft, invert);
    const v = invert ? -val : val;
    const fixed = b.hard[0] === b.hard[1];
    // A suggested band of exactly zero is not a narrow range — it means the
    // generator never does this at all, and the control is the editor's own.
    const hint = b.soft[0] === 0 && b.soft[1] === 0
      ? `the generator never does this · ${fmt(b.hard[0])} – ${fmt(b.hard[1])} ${esc(unit)} here`
      : b.soft[0] === b.hard[0] && b.soft[1] === b.hard[1]
        ? `${fmt(b.hard[0])} – ${fmt(b.hard[1])} ${esc(unit)}`
        : `${fmt(b.soft[0])} – ${fmt(b.soft[1])} suggested · up to ${fmt(b.hard[0])} – ${fmt(b.hard[1])} ${esc(unit)}`;
    return `<div class="mge-row${b.outside ? " wide" : ""}" data-key="${key}" data-invert="${invert ? 1 : 0}">
      <label><span>${esc(label)}</span><output data-out="${key}">${esc(note)}</output></label>
      <div class="mge-ctl">
        <input type="range" min="${b.band[0]}" max="${b.band[1]}" step="${step}" value="${v}" ${fixed ? "disabled" : ""} aria-label="${esc(label)}">
        <input type="number" min="${b.hard[0]}" max="${b.hard[1]}" step="${step}" value="${v}" ${fixed ? "disabled" : ""} aria-label="${esc(label)} ${esc(unit)}">
      </div>
      <div class="mge-range">${hint}${b.outside ? " · <b>beyond the suggested range</b>" : ""}</div>
    </div>`;
  }
  const seg2 = (key, label, opts, val) => `<div class="mge-row"><label><span>${esc(label)}</span></label>
      <div class="mge-seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t]) =>
        `<button type="button" role="radio" data-set="${key}" data-val="${esc(String(v))}" aria-checked="${String(v) === String(val)}">${t}</button>`).join("")}</div></div>`;
  const toggle = (key, label, on, note, disabled = false) => `<label class="mge-tog${disabled ? " off" : ""}">
      <input type="checkbox" data-flag="${key}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span><b>${label}</b><small>${esc(note)}</small></span></label>`;

  // What each piece calls its count and its length. Keeping these in a table
  // rather than in the row list is what stops that list growing a conditional
  // per piece as the palette grows.
  const COUNT_LABEL = {
    slalom: "Fins", split: "Holes in the fast lane", stairs: "Steps",
    platforms: "Stones", pillars: "Pillars", bumps: "Bumps", strafepads: "Pads",
  };
  const LENGTH_LABEL = {
    gap: "Gap length (lip to lip)", wallgap: "Gap length (lip to lip)",
    dash: "Gap length (lip to lip)", hazard: "How far across",
  };

  function readout(seg, key) {
    switch (key) {
      case "length": return `${fmt(seg.length)} units · ${secs(mg.routeLength(seg))}`;
      case "rise": return seg.rise > 0 ? `climbs ${fmt(seg.rise)}` : seg.rise < 0 ? `drops ${fmt(-seg.rise)}` : "level";
      case "drop":
        if (seg.type === "gap") return seg.drop > 0 ? `lands ${fmt(seg.drop)} lower` : seg.drop < 0 ? `lands ${fmt(-seg.drop)} higher` : "lands level";
        if (seg.type === "wallgap") return `ledge ${-seg.drop} up`;
        return `lands ${fmt(seg.drop)} lower`;
      case "radius": return `${fmt(seg.radius)} · ${secs(mg.routeLength(seg))}`;
      case "count":
        if (seg.type === "stairs" && seg.count) {
          return `${seg.count} steps of ${fmt(Math.abs(seg.rise || 0) / seg.count)}`;
        }
        if (seg.type === "strafepads") return `${seg.count} pads`;
        return String(seg.count);
      case "beam_width": return `${seg.beam_width} (player is 32)`;
      case "ledge_width": return `${seg.ledge_width} (player is 32)`;
      case "gate": return `${seg.gate} (player is 32)`;
      case "height": return `${fmt(seg.height)} (a jump needs about 160)`;
      case "angle": return `${seg.angle}°`;
      case "spacing":
        return `${fmt(seg.spacing)} apart · ${fmt(Math.max(0, (seg.spacing || 0) - mg.STRAFE_PAD_LEN))} of air`;
      case "curve":
        return !seg.curve ? "straight"
          : `${Math.abs(seg.curve)}° to the ${seg.curve > 0 ? "left" : "right"}`;
      case "away": return !seg.away ? "touching"
        : seg.away > 0 ? `${fmt(seg.away)} gap to jump` : `${fmt(-seg.away)} back over it`;
      case "shift": return !seg.shift ? "in line"
        : `${fmt(Math.abs(seg.shift))} to the ${seg.shift > 0 ? "left" : "right"}`;
      case "rotate": return !seg.rotate ? "square on"
        : `${Math.abs(seg.rotate)}° to the ${seg.rotate > 0 ? "left" : "right"}`;
      case "roll": return !seg.roll ? "level"
        : `${Math.abs(seg.roll)}° banked, ${seg.roll > 0 ? "left" : "right"} side up`;
      case "pitch": return !seg.pitch ? "flat"
        : `far end ${Math.abs(seg.pitch)}° ${seg.pitch > 0 ? "up" : "down"}`;
      default: return "";
    }
  }

  function renderInspector() {
    const i = st.selected;
    const r = selRange();
    if (r && r[1] > r[0]) {
      const segs = st.spec.segments.slice(r[0], r[1] + 1);
      const iceable = segs.filter((x) => mg.ICEABLE.includes(x.type));
      const len = segs.reduce((n, x) => n + mg.routeLength(x), 0);
      inspEl.innerHTML = `<div class="mge-ihead">${icon("combo")}<div><div class="mge-h">${segs.length} pieces <em>#${r[0]}–${r[1]}</em></div>
          <small>${fmt(len)} units · ${secs(len)} at run speed</small></div></div>
        <p class="mge-note">Shift-click or Shift+←/→ to change how many pieces are selected. Copy them,
          mirror them, or save them as a combo to place again.</p>
        <div class="mge-iact">
          <button type="button" class="btn" data-act="copysel" title="Ctrl+C">${icon("copy")} Copy</button>
          <button type="button" class="btn" data-act="mirror" title="M">${icon("mirror")} Mirror</button>
          <button type="button" class="btn" data-act="savecombo">${icon("combo")} Save as combo</button>
        </div>
        ${iceable.length ? `<div class="mge-iact">
          <button type="button" class="btn" data-act="iceon">${icon("ice")} All ice</button>
          <button type="button" class="btn" data-act="iceoff">All grip</button></div>` : ""}
        <div class="mge-iact"><button type="button" class="btn mge-del" data-act="delsel" title="Delete">Remove ${segs.length} pieces</button></div>`;
      return;
    }
    if (i === null) {
      const r = st.result && st.result.course ? mg.summary(st.result.course, fullSpec()) : null;
      inspEl.innerHTML = `<div class="mge-h">Nothing selected</div>
        <p class="mge-note">Click a piece in the course strip or in the 3-D view to edit it, or add one from the palette.
        New pieces go after the selected one.</p>
        <p class="mge-note">The start room, the finish room and enough checkpoints are added for you, just as the generator adds them.</p>
        ${r ? `<p class="mge-note">This course: <b>${fmt(r.route_length)}</b> units, about <b>${r.par_seconds} s</b> at run speed.</p>` : ""}`;
      return;
    }
    const s = st.spec.segments[i];
    const L = limits(s, st.spec.width, RULES);
    const SOFT = limits(s, st.spec.width, "strict");
    const start = st.result && st.result.course && st.result.course.segStart;
    const z0 = start && start[i] ? Math.round(start[i].z) : null;
    const z1 = start && start[i + 1] ? Math.round(start[i + 1].z) : null;
    const rows = [];
    if (s.type === "turn") {
      rows.push(seg2("direction", "Direction", [["left", "↰ Left"], ["right", "Right ↱"]], s.direction));
      rows.push(seg2("angle", "Angle", mg.TURN_ANGLES.map((a) => [a, `${a}°`]), s.angle));
      rows.push(slider("radius", "Radius (bigger is gentler)", s.radius, L.radius, { step: 16, unit: "units", note: readout(s, "radius") }));
    }
    if (["split", "wallclimb", "wallgap"].includes(s.type)) {
      const label = s.type === "split" ? "Fast lane" : "Kick wall";
      rows.push(seg2("direction", label, [["left", "Left"], ["right", "Right"]], s.direction));
    }
    if (s.type === "chicane") {
      rows.push(seg2("direction", "First bend", [["left", "↰ Left"], ["right", "Right ↱"]], s.direction));
      rows.push(slider("angle", "Angle of each bend", s.angle, L.angle, { unit: "°", soft: SOFT, note: readout(s, "angle") }));
      rows.push(slider("radius", "Radius (bigger is gentler)", s.radius, L.radius, { step: 16, unit: "units", soft: SOFT, note: readout(s, "radius") }));
    }
    if (s.type === "ledge") {
      rows.push(seg2("direction", "Which wall", [["left", "Left"], ["right", "Right"]], s.direction));
    }
    // A turn's angle is a fixed choice in the generator's band and a free
    // number past it, so the editor offers both: the four buttons above, and
    // this slider whenever the course has left them behind.
    if (s.type === "turn" && L.angle && !mg.TURN_ANGLES.includes(s.angle)) {
      rows.push(slider("angle", "Angle", s.angle, L.angle, { unit: "°", soft: SOFT, note: `${s.angle}°` }));
    }
    if (L.count) {
      rows.push(slider("count", COUNT_LABEL[s.type] || "Count", s.count, L.count, { soft: SOFT, note: readout(s, "count") }));
    }
    if (L.drop && s.type === "gap") rows.push(slider("drop", "Landing height", s.drop, L.drop, { step: 8, unit: "units", soft: SOFT, note: readout(s, "drop"), invert: true }));
    if (L.drop && s.type === "wallgap") rows.push(slider("drop", "Ledge height", s.drop, L.drop, { unit: "units", soft: SOFT, note: readout(s, "drop"), invert: true }));
    if (L.drop && s.type === "dash") rows.push(slider("drop", "Drop", s.drop, L.drop, { step: 8, unit: "units", soft: SOFT, note: readout(s, "drop") }));
    if (L.drop && s.type === "platforms") rows.push(slider("drop", "Height change", s.drop, L.drop, { step: 8, unit: "units", soft: SOFT, note: readout(s, "drop") }));
    if (L.spacing) rows.push(slider("spacing", "Spacing (pad to pad)", s.spacing, L.spacing, { step: 8, unit: "units", soft: SOFT, note: readout(s, "spacing") }));
    if (L.curve) rows.push(slider("curve", "Curve (left ← straight → right)", s.curve ?? 0, L.curve, { unit: "°", soft: SOFT, note: readout(s, "curve") }));
    if (L.length) rows.push(slider("length", LENGTH_LABEL[s.type] || "Length", s.length, L.length, { step: L.length[1] - L.length[0] > 600 ? 16 : 1, unit: "units", soft: SOFT, note: readout(s, "length") }));
    if (L.rise && s.type === "ramp") rows.push(slider("rise", "Height change", s.rise, L.rise, { step: 8, unit: "units", soft: SOFT, note: readout(s, "rise") }));
    if (L.rise && s.type === "wallclimb") rows.push(slider("rise", "Ledge height", s.rise, L.rise, { unit: "units", soft: SOFT, note: `ledge ${s.rise} up` }));
    if (L.rise && s.type === "stairs") rows.push(slider("rise", "Height change", s.rise, L.rise, { step: 8, unit: "units", soft: SOFT, note: readout(s, "rise") }));
    if (L.rise && s.type === "bumps") rows.push(slider("rise", "Bump height", s.rise, L.rise, { step: 4, unit: "units", soft: SOFT, note: readout(s, "rise") }));
    if (L.height) rows.push(slider("height", "Roof height", s.height, L.height, { step: 8, unit: "units", soft: SOFT, note: readout(s, "height") }));
    if (L.gate) rows.push(slider("gate", "Gate width", s.gate, L.gate, { step: 4, unit: "units", soft: SOFT, note: readout(s, "gate") }));
    if (L.ledge_width) rows.push(slider("ledge_width", "Walkway width", s.ledge_width, L.ledge_width, { step: 4, unit: "units", soft: SOFT, note: readout(s, "ledge_width") }));
    if (L.beam_width) rows.push(slider("beam_width", "Beam width", s.beam_width, L.beam_width, { step: 4, unit: "units", soft: SOFT, note: readout(s, "beam_width") }));
    const flags = [];
    if (mg.ICEABLE.includes(s.type)) flags.push(toggle("ice", `${icon("ice")} Ice`, s.ice, "Slick floor: no friction, so speed carries and corners slide."));
    if (mg.OPENABLE.includes(s.type)) flags.push(toggle("open", "Open", s.open, "No side walls. Falling off sends you back to the start."));
    if (s.type === "turn") {
      flags.push(toggle("shortcut", "Shortcut stones", s.shortcut,
        s.angle === 180 ? `Stepping stones across the U. Needs a straight of ${mg.SHORTCUT_MIN_LEG}+ on both sides.` : "Only on a 180° turn.", s.angle !== 180));
    }
    // Sideways and on the spot. Every piece takes these, so they live in their
    // own group rather than among the fields that differ piece to piece; it
    // opens by itself once a piece has been nudged, so the setting is never
    // hidden from the person who made it.
    const nudged = mg.NUDGE.some((k) => s[k]);
    const nudge = `<details class="mge-nudge"${nudged ? " open" : ""}>
      <summary>Placement${nudged ? ` <b>${esc(nudgeLabel(s))}</b>` : ""}</summary>
      <p class="mge-note">Where this piece sits relative to the one before it. The first three move
        the course itself; the last two tilt only this piece, so what comes after carries on
        from where it would have anyway.</p>
      ${slider("away", "Away from the piece before (back ← → away)", s.away ?? 0, L.away, { step: 8, unit: "units", soft: SOFT, note: readout(s, "away") })}
      ${slider("shift", "Sideways (right ← → left)", s.shift ?? 0, L.shift, { step: 8, unit: "units", soft: SOFT, note: readout(s, "shift") })}
      ${slider("rotate", "Turn on the spot (right ← → left)", s.rotate ?? 0, L.rotate, { unit: "°", soft: SOFT, note: readout(s, "rotate") })}
      ${slider("roll", "Bank (right side up ← → left side up)", s.roll ?? 0, L.roll, { unit: "°", soft: SOFT, note: readout(s, "roll") })}
      ${slider("pitch", "Tip (far end down ← → far end up)", s.pitch ?? 0, L.pitch, { unit: "°", soft: SOFT, note: readout(s, "pitch") })}
      ${s.away ? `<p class="mge-note">A gap is left as a gap — nothing is bridged across it, because
        separating two pieces is the point of asking.</p>` : ""}
      ${nudged ? `<div class="mge-iact"><button type="button" class="btn" data-act="unnudge">Back in line</button></div>` : ""}
    </details>`;

    inspEl.innerHTML = `
      <div class="mge-ihead">${icon(s.type)}<div><div class="mge-h">${esc(PIECES[s.type].name)} <em>#${i}</em></div>
        <small>${esc(PIECES[s.type].hint)}</small></div></div>
      ${z0 !== null ? `<p class="mge-elev">Height: starts at <b>${fmt(z0)}</b>${z1 !== null && z1 !== z0 ? `, ends at <b>${fmt(z1)}</b>` : ""}</p>` : ""}
      ${rows.join("")}
      ${flags.length ? `<div class="mge-flags">${flags.join("")}</div>` : ""}
      ${nudge}
      <div class="mge-iact">
        <button type="button" class="btn" data-act="left" title="Move earlier (Alt+←)">◀ Move</button>
        <button type="button" class="btn" data-act="right" title="Move later (Alt+→)">Move ▶</button>
        <button type="button" class="btn" data-act="dup" title="Duplicate (Ctrl+D)">Duplicate</button>
        ${s.direction ? `<button type="button" class="btn" data-act="mirror" title="Mirror (M)">${icon("mirror")} Mirror</button>` : ""}
        <button type="button" class="btn mge-del" data-act="del" title="Remove (Delete)">Remove</button>
      </div>`;
  }

  // While a slider is dragged only the numbers next to it change; the rest
  // of the inspector (and the slider under the pointer) must stay put.
  function updateInspectorReadouts() {
    const i = st.selected;
    if (i === null) return;
    const s = st.spec.segments[i];
    const L = limits(s, st.spec.width, RULES);
    const SOFT = limits(s, st.spec.width, "strict");
    inspEl.querySelectorAll(".mge-row[data-key]").forEach((row) => {
      const key = row.dataset.key, inv = row.dataset.invert === "1";
      const out = row.querySelector("output");
      if (out) out.textContent = key === "rise" && s.type === "wallclimb" ? `ledge ${s.rise} up` : readout(s, key);
      if (!L[key]) return;
      const b = bands(key, s[key], L[key], SOFT, inv);
      const rng = row.querySelector('input[type="range"]');
      const nud = row.querySelector('input[type="number"]');
      // The slider spans the suggested band (stretched to hold the current
      // value); the number box spans everything allowed.
      if (rng) { rng.min = b.band[0]; rng.max = b.band[1]; }
      if (nud) { nud.min = b.hard[0]; nud.max = b.hard[1]; }
      for (const inp of row.querySelectorAll("input")) {
        if (document.activeElement !== inp) inp.value = inv ? -s[key] : s[key];
      }
      row.classList.toggle("wide", b.outside);
      row.querySelector(".mge-range").innerHTML =
        (b.soft[0] === 0 && b.soft[1] === 0
          ? `the generator never does this · ${fmt(b.hard[0])} – ${fmt(b.hard[1])} here`
          : b.soft[0] === b.hard[0] && b.soft[1] === b.hard[1]
            ? `${fmt(b.hard[0])} – ${fmt(b.hard[1])} units`
            : `${fmt(b.soft[0])} – ${fmt(b.soft[1])} suggested · up to ${fmt(b.hard[0])} – ${fmt(b.hard[1])} units`)
        + (b.outside ? " · <b>beyond the suggested range</b>" : "");
    });
  }

  function renderReport() {
    const r = st.result;
    const c = r.course;
    const sum = c ? mg.summary(c, fullSpec()) : null;
    const brushes = sum ? sum.brushes : 0;
    const bad = r.problems.length;
    const facts = sum ? `<div class="mge-facts">
        <span><b>${fmt(sum.route_length)}</b> units</span>
        <span>par <b>${sum.par_seconds} s</b> at run speed</span>
        ${sum.shortcuts.length ? `<span><b>${sum.par_seconds_shortcuts} s</b> with every shortcut</span>` : ""}
        <span><b>${sum.checkpoints}</b> checkpoint${sum.checkpoints === 1 ? "" : "s"}${sum.auto_checkpoints ? ` (${sum.auto_checkpoints} added)` : ""}</span>
        ${sum.overpasses.length ? `<span><b>${sum.overpasses.length}</b> overpass${sum.overpasses.length === 1 ? "" : "es"}</span>` : ""}
        ${sum.ice_segments.length ? `<span>${icon("ice")} <b>${sum.ice_segments.length}</b> icy</span>` : ""}
        <span class="${brushes > BRUSH_CAP ? "over" : ""}"><b>${fmt(brushes)}</b> / ${fmt(BRUSH_CAP)} brushes</span>
        <span><b>${st.spec.segments.length}</b> / ${SEG_CAP} pieces</span>
      </div>` : "";
    const quota = st.quota;
    const canBuild = !bad && (!quota || (quota.remaining > 0 && quota.open));
    const build = $('[data-act="build"]');
    build.disabled = !canBuild;
    build.title = bad ? "Fix the problems listed under the course first" : quota && !quota.open ? "The generator is closed for today"
      : quota && quota.remaining === 0 ? "You've used today's maps"
        : "Send it to an admin; once approved it is compiled and put on the game servers";
    // A note is not a problem. The generator refuses a described course over
    // these, because nobody looks at one before it is in the pool; here they
    // are things worth knowing about your own course, and yours to decide on.
    const notes = r.notes || [];
    const item = (p, cls) => {
      const m = p.match(/segment (\d+)/);
      return `<li class="${cls}">${m ? `<button type="button" class="mge-goto" data-goto="${m[1]}">#${m[1]}</button>` : ""}${esc(p)}</li>`;
    };
    reportEl.innerHTML = `
      <div class="mge-verdict ${bad ? "no" : "ok"}">${bad ? `${bad} problem${bad === 1 ? "" : "s"} to fix before it can be built`
        : "Ready to send. An admin approves it before it is built."}</div>
      ${facts}
      ${bad ? `<ul class="mge-probs">${r.problems.map((p) => item(p, "")).join("")}</ul>` : ""}
      ${notes.length ? `<details class="mge-notes"${bad ? "" : " open"}>
        <summary>${notes.length} thing${notes.length === 1 ? "" : "s"} worth a look</summary>
        <p class="mge-note">None of these stop the course being built — they are the checks the
          generator applies to a course nobody has seen. Your call.</p>
        <ul class="mge-probs">${notes.map((p) => item(p, "advice")).join("")}</ul></details>` : ""}
      ${quota ? `<p class="mge-quota">${esc(quotaLine(quota))} · map name <code>${esc(slug(st.spec.title))}_…</code></p>` : ""}`;
  }

  const quotaLine = (q) => !q.open && q.remaining > 0 ? "The generator has built all the maps it can today."
    : q.remaining === 0 ? `You've used today's ${q.limit === 1 ? "map" : q.limit + " maps"}; new ones at 00:00 UTC`
      : `${q.remaining} of ${q.limit} map${q.limit === 1 ? "" : "s"} left today`;

  /* -- events ------------------------------------------------------------ */
  const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); cleanups.push(() => el.removeEventListener(ev, fn, opts)); };
  const cleanups = [];

  on(titleIn, "input", () => {
    if (!liveBase) liveBase = JSON.stringify({ spec: st.spec, selected: st.selected });
    st.spec = { ...st.spec, title: titleIn.value.replace(/\s+/g, " ").replace(/^\s/, "") };
    scheduleRefresh();
  });
  on(titleIn, "change", () => {
    if (liveBase) { st.undo.push(liveBase); st.redo = []; liveBase = null; }
    st.spec = { ...st.spec, title: titleIn.value.trim().replace(/\s+/g, " ") };
    saveDraft(st.spec);
    refresh();
  });
  on(widthIn, "input", () => setWidth(Number(widthIn.value), true));
  on(widthIn, "change", () => setWidth(Number(widthIn.value), false));
  on(widthN, "input", () => {
    const w = Number(widthN.value);
    if (Number.isFinite(w) && w >= WIDTH_BAND[0] && w <= WIDTH_BAND[1]) setWidth(w, true);
  });
  on(widthN, "change", () => setWidth(clamp(Number(widthN.value) || 384, ...WIDTH_BAND), false));

  on(root, "click", (e) => {
    const t = e.target.closest("button, [data-add], [data-goto]");
    if (!t || !root.contains(t)) return;
    if (t.dataset.add) return addPiece(t.dataset.add);
    if (t.dataset.combo !== undefined) return insertPieces((combos()[Number(t.dataset.combo)] || {}).segments, null, "Placed");
    if (t.dataset.delcombo !== undefined) {
      const list = combos();
      list.splice(Number(t.dataset.delcombo), 1);
      store.set(COMBOS_KEY, list);
      return renderCombos();
    }
    if (t.dataset.lib !== undefined) {
      const c = library()[Number(t.dataset.lib)];
      t.closest("details").open = false;
      if (!c) return;
      view.framed = false;
      commit(adopt(c.spec)[0], { select: null });
      return flash(`Opened "${c.spec.title}".`);
    }
    if (t.dataset.dellib !== undefined) {
      const list = library();
      list.splice(Number(t.dataset.dellib), 1);
      store.set(LIBRARY_KEY, list);
      return renderLibrary();
    }
    if (t.dataset.surface) { st.surface = t.dataset.surface; refresh({ inspector: false }); return; }
    if (t.dataset.goto !== undefined) return select(Number(t.dataset.goto));
    if (t.dataset.starter) {
      t.closest("details").open = false;
      view.framed = false;   // before the commit, so the new course is framed
      commit(structuredClone(STARTERS[t.dataset.starter]), { select: null });
      return;
    }
    if (t.dataset.set) {
      const v = t.dataset.set === "angle" ? Number(t.dataset.val) : t.dataset.val;
      return setFields(st.selected, { [t.dataset.set]: v });
    }
    switch (t.dataset.act) {
      case "undo": return travel(st.undo, st.redo);
      case "redo": return travel(st.redo, st.undo);
      case "new":
        t.closest("details").open = false;
        view.framed = false;
        commit(structuredClone(STARTERS.blank), { select: 0 });
        return;
      case "import": t.closest("details").open = false; $("#mge-imsg").textContent = ""; return dlg.showModal();
      case "clearall": {
        t.closest("details").open = false;
        const n = st.spec.segments.length;
        $("#mge-clearn").textContent = `${n} piece${n === 1 ? "" : "s"}`;
        track("Map editor clear asked", { pieces: n });
        return clearDlg.showModal();
      }
      case "closeclear": return clearDlg.close();
      case "doclear": {
        const n = st.spec.segments.length;
        clearDlg.close();
        // Title and width survive; one straight is left so there is something
        // to build on (and because a course with no pieces is not a course).
        commit({ ...st.spec, segments: [PIECES.straight.make(st.spec.width)] }, { select: 0 });
        track("Map editor clear", { pieces: n });
        return flash(`Cleared ${n} piece${n === 1 ? "" : "s"}. Ctrl+Z puts them back.`);
      }
      case "unnudge": {
        if (st.selected === null) return;
        track("Map editor nudge", { field: "cleared" });
        return setFields(st.selected, Object.fromEntries(mg.NUDGE.map((k) => [k, 0])));
      }
      case "close": return dlg.close();
      case "doimport": return doImport();
      case "download": t.closest("details").open = false; return download();
      case "copy": t.closest("details").open = false; return copyJson();
      case "build": return build();
      case "frame": view.framed = true; return view.frame();
      case "top": return view.frame(true);
      case "focus": return st.selected !== null ? view.focus(st.selected) : flash("Select a piece first.");
      case "paint":
        st.paint = !st.paint;
        flash(st.paint ? `Paint: click pieces to make them ${st.surface === "ice" ? "ice" : "grip"}. B or Esc to stop.` : "Paint off.");
        return refresh({ inspector: false });
      case "save": t.closest("details").open = false; return saveToLibrary();
      case "copysel": return copySel();
      case "mirror": return mirrorSel();
      case "savecombo": return saveCombo();
      case "iceon": return surfaceSel(true);
      case "iceoff": return surfaceSel(false);
      case "delsel": {
        const r = selRange();
        if (!r) return;
        if (r[1] - r[0] + 1 >= st.spec.segments.length) return flash("A course needs at least one piece.");
        const [next] = withSegs((segs) => segs.splice(r[0], r[1] - r[0] + 1));
        return commit(next, { select: Math.min(r[0], next.segments.length - 1) });
      }
      case "left": return movePiece(st.selected, st.selected - 1);
      case "right": return movePiece(st.selected, st.selected + 1);
      case "dup": return duplicate(st.selected);
      case "del": return removePiece(st.selected);
      default:
    }
  });
  on(document, "click", (e) => {
    for (const d of root.querySelectorAll("details.mge-menu[open]")) if (!d.contains(e.target)) d.open = false;
  });
  on(chipsEl, "click", (e) => {
    const c = e.target.closest("[data-i]");
    if (!c) return;
    if (st.paint) return paint(Number(c.dataset.i));
    select(Number(c.dataset.i), { extend: e.shiftKey });
  });
  // The piece preview follows the pointer over the palette.
  on(root, "pointerover", (e) => {
    const b = e.target.closest("[data-add], [data-combo]");
    if (!b) return;
    if (b.dataset.add) {
      const p = PIECES[b.dataset.add];
      if (p.needs && p.needs(st.spec.width)) return showPreview(null);
      const seg = p.make(st.spec.width);
      if (st.surface === "ice" && mg.ICEABLE.includes(b.dataset.add)) seg.ice = true;
      showPreview([seg]);
    } else {
      showPreview((combos()[Number(b.dataset.combo)] || {}).segments || null);
    }
  });
  on(root, "pointerout", (e) => {
    const b = e.target.closest("[data-add], [data-combo]");
    if (b && !b.contains(e.relatedTarget)) showPreview(null);
  });
  on(chipsEl, "dblclick", (e) => {
    const c = e.target.closest("[data-i]");
    if (c) view.focus(Number(c.dataset.i));
  });
  on(chipsEl, "mouseover", (e) => {
    const c = e.target.closest("[data-i]");
    view.hover(c ? Number(c.dataset.i) : null);
  });
  on(chipsEl, "mouseleave", () => view.hover(null));

  // Inspector inputs: sliders and number boxes stay in step; flags toggle.
  on(inspEl, "input", (e) => {
    const row = e.target.closest(".mge-row[data-key]");
    // Only a slider edits live; a number box commits on change (Enter or
    // leaving it), so typing "1024" is not clamped at "1".
    if (!row || e.target.type !== "range") return;
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    const inv = row.dataset.invert === "1";
    row.querySelectorAll("input").forEach((x) => { if (x !== e.target) x.value = e.target.value; });
    setFields(st.selected, { [row.dataset.key]: inv ? -v : v }, { live: true });
  });
  on(inspEl, "change", (e) => {
    if (e.target.dataset.flag) return setFields(st.selected, { [e.target.dataset.flag]: e.target.checked });
    const row = e.target.closest(".mge-row[data-key]");
    if (!row) return;
    const key = row.dataset.key;
    const v = Number(e.target.value);
    const inv = row.dataset.invert === "1";
    setFields(st.selected, { [key]: Number.isFinite(v) ? (inv ? -v : v) : NaN });
    if (mg.NUDGE.includes(key)) track("Map editor nudge", { field: key });
    // A value typed past the generator's own band is the whole reason the
    // wider band exists, so it is worth knowing it gets used — and on what.
    else if (row.classList.contains("wide")) {
      const s2 = st.spec.segments[st.selected];
      if (s2) track("Map editor beyond suggested", { piece: s2.type, field: key });
    }
  });

  // Drag and drop: palette pieces into the strip, and chips within it.
  let dragFrom = null;
  // Insert before the nearest chip if the pointer is on its first half,
  // after it otherwise.
  const dropIndex = (e) => {
    let best = null, bd = Infinity;
    for (const c of chipsEl.querySelectorAll("[data-i]")) {
      const r = c.getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (d < bd) { bd = d; best = [c, r]; }
    }
    if (!best) return st.spec.segments.length;
    const [c, r] = best;
    const i = Number(c.dataset.i);
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  on(root, "dragstart", (e) => {
    const p = e.target.closest("[data-add]");
    const c = e.target.closest("[data-i]");
    if (p) { e.dataTransfer.setData("text/x-mge-add", p.dataset.add); e.dataTransfer.effectAllowed = "copy"; }
    else if (c) { dragFrom = Number(c.dataset.i); e.dataTransfer.setData("text/x-mge-move", c.dataset.i); e.dataTransfer.effectAllowed = "move"; c.classList.add("drag"); }
  });
  on(root, "dragend", () => { dragFrom = null; chipsEl.querySelectorAll(".drag, .drop-before").forEach((c) => c.classList.remove("drag", "drop-before")); chipsEl.classList.remove("drop-end"); });
  on(chipsEl, "dragover", (e) => {
    e.preventDefault();
    const i = dropIndex(e);
    chipsEl.querySelectorAll(".drop-before").forEach((c) => c.classList.remove("drop-before"));
    const c = chipsEl.querySelector(`[data-i="${i}"]`);
    if (c) c.classList.add("drop-before");
    chipsEl.classList.toggle("drop-end", !c);
  });
  on(chipsEl, "drop", (e) => {
    e.preventDefault();
    const i = dropIndex(e);
    chipsEl.classList.remove("drop-end");
    const add = e.dataTransfer.getData("text/x-mge-add");
    if (add) return addPiece(add, i);
    if (dragFrom !== null) movePiece(dragFrom, i > dragFrom ? i - 1 : i);
  });

  on(document, "keydown", (e) => {
    if (!root.isConnected || dlg.open) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)
      && document.activeElement.type !== "range" && document.activeElement.type !== "checkbox";
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !typing) { e.preventDefault(); return e.shiftKey ? travel(st.redo, st.undo) : travel(st.undo, st.redo); }
    if (mod && k === "y" && !typing) { e.preventDefault(); return travel(st.redo, st.undo); }
    if (typing) return;
    if (e.key === "Escape" && st.paint) { st.paint = false; return refresh({ inspector: false }); }
    if (mod && k === "d") { e.preventDefault(); return duplicate(st.selected); }
    if (mod && k === "c") { e.preventDefault(); return copySel(); }
    if (mod && k === "x") { e.preventDefault(); return copySel({ cut: true }); }
    if (mod && k === "v") { e.preventDefault(); return insertPieces(store.get(CLIP_KEY, [])); }
    if (mod || e.altKey && !e.key.startsWith("Arrow")) return;
    if (e.target.type === "range") return;
    const n = st.spec.segments.length;
    if ((e.key === "Delete" || e.key === "Backspace") && st.selected !== null) {
      e.preventDefault();
      const r = selRange();
      if (r[1] > r[0]) return $('[data-act="delsel"]') ? $('[data-act="delsel"]').click() : null;
      return removePiece(st.selected);
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = e.key === "ArrowLeft" ? -1 : 1;
      e.preventDefault();
      if (e.altKey && st.selected !== null) return movePiece(st.selected, st.selected + d);
      if (e.shiftKey && st.selected !== null) {
        const end = st.rangeEnd === null ? st.selected : st.rangeEnd;
        return select(clamp(end + d, 0, n - 1), { extend: true });
      }
      return select(st.selected === null ? (d > 0 ? 0 : n - 1) : clamp(st.selected + d, 0, n - 1));
    }
    // The hotbar: number keys place a piece, in palette order.
    const hot = HOTKEYS.indexOf(e.key);
    if (hot >= 0) { e.preventDefault(); return addPiece(HOTBAR[hot]); }
    if (e.key === "Escape") return select(null);
    if (k === "f") { view.framed = true; return view.frame(); }
    if (k === "t") return view.frame(true);
    if (k === "m") return mirrorSel();
    if (k === "b") return $('[data-act="paint"]').click();
    if (k === "i" && selRange()) {
      const r = selRange();
      const anyGrip = st.spec.segments.slice(r[0], r[1] + 1).some((x) => mg.ICEABLE.includes(x.type) && !x.ice);
      return surfaceSel(anyGrip);
    }
  });

  /* -- import / export / build ------------------------------------------ */
  async function doImport() {
    const msg = $("#mge-imsg");
    msg.className = "flag-msg";
    let raw;
    try {
      raw = JSON.parse($("#mge-json").value);
    } catch (e) {
      msg.classList.add("err");
      msg.textContent = `Not valid JSON: ${e.message}`;
      return;
    }
    try {
      const [s, why] = adopt(raw);
      dlg.close();
      view.framed = false;
      commit(s, { select: null });
      flash(why.length ? why.join(" ") : `Loaded ${s.segments.length} pieces.`);
      track("Map editor import");
    } catch (e) {
      msg.classList.add("err");
      msg.textContent = e.message;
    }
  }
  on($("#mge-file"), "change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 256 * 1024) { $("#mge-imsg").textContent = "That file is too big to be a course spec."; return; }
    $("#mge-json").value = await f.text();
    e.target.value = "";
  });
  function specText() { return JSON.stringify(mg.normalize(fullSpec()), null, 2) + "\n"; }
  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([specText()], { type: "application/json" }));
    a.download = `${slug(st.spec.title)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    track("Map editor download");
  }
  async function copyJson() {
    try { await navigator.clipboard.writeText(specText()); flash("Spec JSON copied."); }
    catch { flash("Couldn't reach the clipboard: use Download instead."); }
  }

  async function loadQuota() {
    try {
      const r = await fetch("/api/mapgen/quota", { cache: "no-store" });
      if (r.ok) st.quota = await r.json();
    } catch { /* the build button explains itself on click */ }
    renderReport();
  }

  async function build() {
    const btn = $('[data-act="build"]');
    if (st.result.problems.length) return flash("Fix the problems listed under the course first.");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const res = await fetch("/api/mapgen/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: mg.normalize(fullSpec()) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(body.problems) && body.problems.length) st.result.problems = body.problems;
        renderReport();
        flash(body.error || `${res.status} ${res.statusText}`);
        return;
      }
      // What was in it, not just how big: which pieces people actually reach
      // for is the thing worth knowing after adding ten of them.
      track("Map editor build", {
        pieces: st.spec.segments.length,
        width: st.spec.width,
        kinds: [...new Set(st.spec.segments.map((x) => x.type))].sort().join(" "),
        nudged: st.spec.segments.filter((x) => x.shift || x.rotate).length,
      });
      if (body.job && body.job.token && go) go(`/mapgen/${body.job.token}`);
    } catch (e) {
      flash("Couldn't send it. Please try again.");
    } finally {
      btn.textContent = "Send for approval";
      if (root.isConnected) loadQuota();
    }
  }

  track("Map editor open", { pieces: st.spec.segments.length });

  refresh();
  renderCombos();
  renderLibrary();
  if (notes.length || initialNote) flash([initialNote, ...notes].filter(Boolean).join(" "));
  loadQuota();

  return () => {
    for (const fn of cleanups) fn();
    clearTimeout(msgTimer);
    view.dispose();
  };
}

// For tests (node has no WebGL): the texture projection.
export const _test = { texAxes };
