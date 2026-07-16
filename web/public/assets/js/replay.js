// In-browser WR ghost replay viewer (three.js). Lazily imported by app.js on
// the /replay/:id route. Renders the recorded world-record trajectory as an
// animated marker flying along a path, inside the real map geometry when a
// converted mesh exists (web/public/maps/<name>.glb, built by tools/bsp2gltf),
// or over the bare path otherwise.
//
// Coordinates: ghost frames are Quake units (Z-up, X fwd, Y left); the map
// mesh was already converted to glTF Y-up by bsp2gltf using gl = (x, z, -y).
// We apply the SAME transform to ghost points here so they line up.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const q2t = (x, y, z) => new THREE.Vector3(x, z, -y);

// Minimal .glb reader for the single-mesh, POSITION+indices files bsp2gltf
// emits. Returns a BufferGeometry (gl-space) or throws.
function parseGlb(arrayBuf) {
  const dv = new DataView(arrayBuf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a glb");
  const total = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const clen = dv.getUint32(off, true);
    const ctype = dv.getUint32(off + 4, true);
    off += 8;
    const chunk = arrayBuf.slice(off, off + clen);
    off += clen;
    if (ctype === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (ctype === 0x004e4942) bin = chunk;
  }
  if (!json || !bin) throw new Error("glb missing chunks");
  const prim = json.meshes[0].primitives[0];
  const pAcc = json.accessors[prim.attributes.POSITION];
  const iAcc = json.accessors[prim.indices];
  const pBV = json.bufferViews[pAcc.bufferView];
  const iBV = json.bufferViews[iAcc.bufferView];
  const positions = new Float32Array(bin, pBV.byteOffset || 0, pAcc.count * 3);
  const indices = new Uint32Array(bin, iBV.byteOffset || 0, iAcc.count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

function fmtClock(ms) {
  if (ms == null) return "—";
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = String(Math.floor(ms % 1000)).padStart(3, "0");
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}.${mss}` : `${s}.${mss}`;
}

export async function mountReplay(root, { mapId, mapName, wr }) {
  const ghostUrl = (wr && wr.ghost && wr.ghost.url) || `/api/maps/${mapId}/ghost`;
  const ghost = await (await fetch(ghostUrl)).json();
  const frames = ghost.frames || [];
  const hz = ghost.hz || 25;
  if (frames.length < 2) throw new Error("ghost has too few frames");
  const cps = Array.isArray(ghost.cps) ? ghost.cps : [];
  const duration = (frames.length - 1) / hz; // seconds

  // Pre-transform trajectory points + per-frame velocity/speed/angles/keys.
  const pts = frames.map((f) => q2t(f[0], f[1], f[2]));
  const vel = frames.map((f) => q2t(f[6], f[7], f[8]));
  const hspeed = frames.map((f) => Math.round(Math.hypot(f[6], f[7])));
  const ang = frames.map((f) => [f[3], f[4], f[5]]); // quake pitch, yaw, roll
  // Optional 10th value = the player's pressed-keys bitmask (Warsow Key_*).
  const keysAt = (i) => (frames[i] && frames[i].length > 9 ? frames[i][9] | 0 : 0);
  const KEY_BITS = { fwd: 1, back: 2, left: 4, right: 8, fire: 16, jump: 32, crouch: 64, special: 128 };
  const hasKeys = frames.some((f) => f.length > 9);

  // --- DOM scaffold ---------------------------------------------------------
  root.innerHTML = `
    <div class="rv-stage">
      <div class="rv-keys${hasKeys ? "" : " rv-hidden"}" aria-hidden="true">
        <div class="rv-krow"><span class="rv-key" data-k="fwd">W</span></div>
        <div class="rv-krow"><span class="rv-key" data-k="left">A</span><span class="rv-key" data-k="back">S</span><span class="rv-key" data-k="right">D</span></div>
        <div class="rv-krow"><span class="rv-key rv-wide" data-k="jump">JUMP</span><span class="rv-key rv-wide" data-k="crouch">CROUCH</span></div>
        <div class="rv-krow"><span class="rv-key rv-wide" data-k="special">DASH</span><span class="rv-key rv-wide" data-k="fire">FIRE</span></div>
      </div>
    </div>
    <div class="rv-bar">
      <button class="rv-btn rv-play" title="Play / pause">⏸</button>
      <input class="rv-seek" type="range" min="0" max="1000" value="0">
      <span class="rv-clock mono">0.000</span>
      <span class="rv-sep">/</span>
      <span class="rv-total mono">${fmtClock(duration * 1000)}</span>
      <span class="rv-hud mono"><span class="rv-speed">0</span> ups</span>
      <select class="rv-speed-sel" title="Playback speed">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
      </select>
      <button class="rv-btn rv-cam" title="Camera: click to cycle POV / Follow / Orbit">POV</button>
    </div>
    <div class="rv-note"></div>`;
  const stage = root.querySelector(".rv-stage");
  const playBtn = root.querySelector(".rv-play");
  const seek = root.querySelector(".rv-seek");
  const clockEl = root.querySelector(".rv-clock");
  const speedEl = root.querySelector(".rv-speed");
  const speedSel = root.querySelector(".rv-speed-sel");
  const camBtn = root.querySelector(".rv-cam");
  const keyEls = Object.keys(KEY_BITS)
    .map((k) => [k, root.querySelector(`.rv-key[data-k="${k}"]`)])
    .filter(([, el]) => el);
  const noteEl = root.querySelector(".rv-note");

  // --- three.js scene -------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b0f);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 1, 200000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 1, 0.3);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Bounding box grows to include the trajectory (+ mesh if any).
  const bbox = new THREE.Box3();
  pts.forEach((p) => bbox.expandByPoint(p));

  // Map mesh (optional).
  try {
    const r = await fetch(`/maps/${encodeURIComponent(mapName)}.glb`);
    if (r.ok) {
      const geo = parseGlb(await r.arrayBuffer());
      // The converter ships untextured geometry (Warsow's shader/texture system
      // is out of scope), so render a lit "greybox" with a world-space grid:
      // faceted lighting via screen-space derivatives (true per-face normals,
      // no normal attribute needed) + triplanar grid lines on the Warsow unit
      // grid, so surfaces read cleanly and show real-world scale.
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
          uLight: { value: new THREE.Vector3(0.4, 1.0, 0.35).normalize() },
          uBase: { value: new THREE.Color(0x2b3446) },
          uLine: { value: new THREE.Color(0x8fa6cc) },
          uGrid: { value: 64.0 }, // world units between grid lines
        },
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          precision highp float;
          varying vec3 vWorld;
          uniform vec3 uLight; uniform vec3 uBase; uniform vec3 uLine; uniform float uGrid;
          float gridA(vec2 p) {
            vec2 c = p / uGrid;
            vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
            return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
          }
          void main() {
            vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
            vec3 an = abs(n);
            float grid = gridA(vWorld.yz) * an.x + gridA(vWorld.xz) * an.y + gridA(vWorld.xy) * an.z;
            float light = 0.45 + 0.55 * clamp(dot(n, uLight) * 0.5 + 0.5, 0.0, 1.0);
            vec3 col = mix(uBase * light, uLine, clamp(grid, 0.0, 1.0) * 0.55);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      });
      scene.add(new THREE.Mesh(geo, mat));
      if (geo.boundingBox) bbox.union(geo.boundingBox);
    } else {
      noteEl.textContent = "Map geometry not available — showing the flight path only.";
    }
  } catch (e) {
    noteEl.textContent = "Map geometry failed to load — showing the flight path only.";
  }

  // Trajectory line.
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff7a2f })));

  // Start / finish / checkpoint markers.
  const dot = (pos, color, size) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(size, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    m.position.copy(pos);
    scene.add(m);
  };
  const span = bbox.getSize(new THREE.Vector3()).length();
  const markSize = Math.max(4, span * 0.004);
  dot(pts[0], 0x39d98a, markSize * 1.3); // start
  dot(pts[pts.length - 1], 0xff4d4d, markSize * 1.3); // finish
  for (const ci of cps) if (ci > 0 && ci < pts.length) dot(pts[ci], 0x2fd0ff, markSize);

  // Moving player marker (cone pointing along travel direction).
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(markSize * 1.2, markSize * 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x332200, flatShading: true })
  );
  scene.add(marker);

  // Frame the camera on the whole run.
  const center = bbox.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  const camDist = Math.max(200, span * 0.6);
  camera.position.set(center.x + camDist, center.y + camDist * 0.6, center.z + camDist);
  camera.updateProjectionMatrix();

  // --- playback state -------------------------------------------------------
  const UP = new THREE.Vector3(0, 1, 0);
  const EYE_H = 20; // gl units above the recorded origin for the POV camera
  const MODES = ["pov", "follow", "orbit"];
  const MODE_LABEL = { pov: "POV", follow: "Follow", orbit: "Orbit" };
  const orbitPos = new THREE.Vector3(center.x + camDist, center.y + camDist * 0.6, center.z + camDist);
  let camMode = "pov";
  let t = 0; // seconds
  let playing = true;
  let speed = 1;
  let raf = 0;
  let last = performance.now();
  const _tmp = new THREE.Vector3();
  const _f0 = new THREE.Vector3();
  const _f1 = new THREE.Vector3();
  const viewDir = new THREE.Vector3(1, 0, 0);

  // Quake view angles (pitch, yaw in degrees) -> gl-space forward unit vector.
  // AngleVectors: fwd_q = (cp*cy, cp*sy, -sp); gl = (x, z, -y).
  const fwdFromAngles = (pitch, yaw, out) => {
    const dp = (pitch * Math.PI) / 180, dy = (yaw * Math.PI) / 180;
    const cp = Math.cos(dp), sp = Math.sin(dp), cy = Math.cos(dy), sy = Math.sin(dy);
    return out.set(cp * cy, -sp, -cp * sy);
  };

  const updateKeyOverlay = (bits) => {
    for (const [name, el] of keyEls) el.classList.toggle("on", (bits & KEY_BITS[name]) !== 0);
  };

  const sampleInto = (tSec) => {
    const x = Math.min(Math.max(tSec, 0), duration) * hz;
    const i = Math.min(Math.floor(x), pts.length - 2);
    const a = x - i;
    marker.position.copy(pts[i]).lerp(pts[i + 1], a);
    // travel direction (orients the marker cone + drives the follow cam)
    const dir = vel[i].clone().lerp(vel[i + 1], a);
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      marker.quaternion.setFromUnitVectors(UP, dir);
    }
    // recorded VIEW direction (POV cam) — interpolate as vectors to avoid wrap
    fwdFromAngles(ang[i][0], ang[i][1], _f0);
    fwdFromAngles(ang[i + 1][0], ang[i + 1][1], _f1);
    viewDir.copy(_f0).lerp(_f1, a);
    if (viewDir.lengthSq() > 1e-6) viewDir.normalize();
    speedEl.textContent = Math.round(hspeed[i] + (hspeed[i + 1] - hspeed[i]) * a);
    updateKeyOverlay(keysAt(a < 0.5 ? i : i + 1));
    return dir;
  };

  const tick = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (playing) {
      t += dt * speed;
      if (t >= duration) t = 0; // loop at real-time
      seek.value = String(Math.round((t / duration) * 1000));
    }
    const dir = sampleInto(t);
    clockEl.textContent = fmtClock(t * 1000);
    if (camMode === "orbit") {
      controls.update();
    } else if (camMode === "pov") {
      // sit at the player's eye and look where they looked, at real speed
      camera.position.copy(marker.position).addScaledVector(UP, EYE_H);
      camera.lookAt(_tmp.copy(camera.position).add(viewDir));
    } else {
      // follow: chase just behind the direction of travel
      const back = dir && dir.lengthSq() > 1e-6 ? dir : viewDir;
      const eye = _tmp.copy(marker.position).addScaledVector(back, -markSize * 26).addScaledVector(UP, markSize * 12);
      camera.position.lerp(eye, 0.18);
      camera.lookAt(marker.position);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };

  // --- controls -------------------------------------------------------------
  const setPlaying = (v) => {
    playing = v;
    playBtn.textContent = v ? "⏸" : "▶";
  };
  const setMode = (m) => {
    camMode = m;
    camBtn.textContent = MODE_LABEL[m];
    controls.enabled = m === "orbit";
    marker.visible = m !== "pov"; // you ARE the ghost in POV
    if (m === "orbit") {
      camera.position.copy(orbitPos);
      controls.target.copy(center);
      controls.update();
    }
  };
  playBtn.addEventListener("click", () => setPlaying(!playing));
  seek.addEventListener("input", () => {
    t = (Number(seek.value) / 1000) * duration;
    setPlaying(false);
  });
  speedSel.addEventListener("change", () => (speed = Number(speedSel.value)));
  camBtn.addEventListener("click", () => setMode(MODES[(MODES.indexOf(camMode) + 1) % MODES.length]));
  setMode("pov"); // default: watch the run from the player's eyes, real speed

  // --- sizing + lifecycle ---------------------------------------------------
  const resize = () => {
    const w = stage.clientWidth || 800;
    const h = stage.clientHeight || 450;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  raf = requestAnimationFrame(tick);

  // Cleanup handed back to app.js router.
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    renderer.domElement.remove();
  };
}
