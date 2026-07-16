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
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const q2t = (x, y, z) => new THREE.Vector3(x, z, -y);

// "Dev texture" greybox material for the weapon view/hand models, themed to
// match the map greybox: faceted lighting (screen-space derivative normals, no
// normal attribute needed) + a fine grid in the model's OWN coordinates so the
// lines stay put on the weapon instead of swimming as it moves with the view.
function weaponGreyboxMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uLight: { value: new THREE.Vector3(0.3, 0.8, 0.55).normalize() },
      uBase: { value: new THREE.Color(0x4a3a2b) }, // warm grey with an orange cast
      uLine: { value: new THREE.Color(0xff6a1a) }, // site-theme --orange edges — stands out
      uGrid: { value: 3.0 },
    },
    vertexShader: `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vLocal;
      uniform vec3 uLight; uniform vec3 uBase; uniform vec3 uLine; uniform float uGrid;
      float gridA(vec2 p) {
        vec2 c = p / uGrid;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
      }
      void main() {
        vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
        vec3 an = abs(n);
        float grid = gridA(vLocal.yz) * an.x + gridA(vLocal.xz) * an.y + gridA(vLocal.xy) * an.z;
        float light = 0.5 + 0.5 * clamp(dot(n, uLight) * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(mix(uBase * light, uLine, clamp(grid, 0.0, 1.0) * 0.5), 1.0);
      }
    `,
  });
}

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
  // Show a loading indicator immediately — the ghost fetch, map mesh and rigged
  // models all load before the first frame renders.
  root.innerHTML = `<div class="rv-loading"><div class="rv-loadbar"><i></i></div><span>Loading replay…</span></div>`;
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

  // Strafe/acceleration optimality — mirrors the in-game race HUD accel bar
  // (server/clientdata/huds/inc/ale_racemod/acceleration.hud): the ratio of the
  // player's ACTUAL horizontal acceleration to the theoretical maximum for the
  // current speed (STAT_PROGRESS_SELF max_accel, computed the same way as
  // hrace.as). ~1.0 = a near-perfect strafe; low = bleeding potential speed.
  const rawSpeed = frames.map((f) => Math.hypot(f[6], f[7]));
  const PMOVE_MAXSPEED = 320; // Warsow race ground max speed (client.pmoveMaxSpeed)
  const _adt = 1 / hz;
  const strafeEff = frames.map((_, i) => {
    if (i === 0) return 0;
    const speed = rawSpeed[i];
    const ba = PMOVE_MAXSPEED * _adt;
    const maxA = (Math.sqrt(speed * speed + ba * (2 * PMOVE_MAXSPEED - ba)) - speed) / _adt;
    const act = (rawSpeed[i] - rawSpeed[i - 1]) / _adt;
    return maxA > 1 ? act / maxA : 0;
  });
  // light 3-tap smoothing so the bar isn't jittery frame to frame
  const strafe = strafeEff.map((_, i) =>
    (strafeEff[Math.max(0, i - 1)] + strafeEff[i] + strafeEff[Math.min(strafeEff.length - 1, i + 1)]) / 3
  );
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
      <div class="rv-legend${hasKeys ? "" : " rv-hidden"}"></div>
      <div class="rv-strafe" aria-hidden="true" title="Strafe efficiency: actual acceleration vs. the theoretical max (like the race HUD)">
        <div class="rv-strafe-track"><i></i></div>
        <span class="rv-strafe-lbl">Strafe</span>
      </div>
      <div class="rv-loading"><div class="rv-loadbar"><i></i></div><span>Loading map…</span></div>
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
      <button class="rv-btn rv-fx on" title="Show / hide action effects">FX</button>
      <button class="rv-btn rv-cam" title="Camera: POV / Chase">POV</button>
      <button class="rv-btn rv-full" title="Fullscreen">⛶</button>
    </div>
    <div class="rv-note"></div>`;
  const stage = root.querySelector(".rv-stage");
  const playBtn = root.querySelector(".rv-play");
  const seek = root.querySelector(".rv-seek");
  const clockEl = root.querySelector(".rv-clock");
  const speedEl = root.querySelector(".rv-speed");
  const speedSel = root.querySelector(".rv-speed-sel");
  const fxBtn = root.querySelector(".rv-fx");
  const camBtn = root.querySelector(".rv-cam");
  const fullBtn = root.querySelector(".rv-full");
  const legendEl = root.querySelector(".rv-legend");
  const loadingEl = root.querySelector(".rv-loading");
  const strafeEl = root.querySelector(".rv-strafe-track > i");
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

  // Orbit controls, used ONLY while Ctrl is held in Chase (free look around the
  // pig); releasing Ctrl hands the camera back to the auto-follow.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.enabled = false;

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 1, 0.3);
  scene.add(sun);

  // Bounding box grows to include the trajectory (+ mesh if any).
  const bbox = new THREE.Box3();
  pts.forEach((p) => bbox.expandByPoint(p));
  // Marker/effect sizes key off the RUN's own extent, not the (often enormous)
  // map mesh — otherwise the path dots balloon large enough to engulf the cam.
  const trajSpan = bbox.getSize(new THREE.Vector3()).length();

  // Map mesh (optional). Kept as `mapMesh` so weapon-impact rays can hit it.
  // Time-boxed so a slow/hung mesh fetch falls back to line-only instead of
  // blocking the viewer forever.
  let mapMesh = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(`/maps/${encodeURIComponent(mapName)}.glb`, { signal: ctrl.signal }).finally(() => clearTimeout(to));
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
      mapMesh = new THREE.Mesh(geo, mat);
      scene.add(mapMesh);
      if (geo.boundingBox) bbox.union(geo.boundingBox);
    } else {
      noteEl.textContent = "Map geometry not available — showing the flight path only.";
    }
  } catch (e) {
    noteEl.textContent = "Map geometry failed to load — showing the flight path only.";
  }

  // Trajectory line.
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff6a1a })));

  const span = bbox.getSize(new THREE.Vector3()).length();
  const markSize = Math.min(Math.max(6, trajSpan * 0.006), 36);
  // Start / finish / checkpoint markers are drawn as flat surface rings just
  // after the effects section (they reuse surfaceAt), so they lie on the floor
  // and never balloon over the pig the way billboarded spheres did.

  // --- action effects along the path ---------------------------------------
  // Annotate the trajectory where the player jumps / dashes / walljumps /
  // crouches / shoots, using the per-frame key bitmask. Dash and walljump are
  // BOTH +special in the input; a walljump kicks you UP off a wall while a dash
  // is a flat ground burst, so we split them by the vertical-velocity change
  // right after the press. Shots additionally raycast the aim vector against
  // the map to place an impact where the projectile would land.
  const UP = new THREE.Vector3(0, 1, 0);
  const EYE_H = 20; // gl units above the recorded origin for the eye/muzzle
  const ORANGE = 0xff6a1a; // matches the site theme --orange
  const EFFECTS = {
    jump: { glyph: "↑", color: "#39d98a", label: "Jump" },
    dash: { glyph: "»", color: "#ffd24a", label: "Dash" },
    walljump: { glyph: "★", color: "#ff5ce0", label: "Wall jump" },
    crouch: { glyph: "▼", color: "#22d3ee", label: "Crouch" },
    shoot: { glyph: "✦", color: "#ff6a1a", label: "Shoot" },
    impact: { glyph: "✸", color: "#ff8f4d", label: "Impact" },
  };
  // A flat "dev-texture" decal per effect type: a reticle ring + tick marks +
  // glyph on a transparent disc, laid FLAT on the surface where the action
  // happened (floor for jumps/dashes, wall for walljumps) — not billboarded.
  const fxMat = {};
  for (const [type, def] of Object.entries(EFFECTS)) {
    const c = document.createElement("canvas");
    c.width = c.height = 256; // hi-res so the decal stays crisp up close
    const g = c.getContext("2d");
    g.translate(128, 128);
    g.beginPath(); g.arc(0, 0, 116, 0, Math.PI * 2);
    g.fillStyle = "rgba(10,11,15,0.34)"; g.fill(); // reads on any greybox surface
    g.strokeStyle = def.color; g.lineWidth = 14;
    g.beginPath(); g.arc(0, 0, 102, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 10;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      g.beginPath();
      g.moveTo(Math.cos(a) * 86, Math.sin(a) * 86);
      g.lineTo(Math.cos(a) * 122, Math.sin(a) * 122);
      g.stroke();
    }
    g.fillStyle = def.color; g.font = "bold 124px sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(def.glyph, 0, 10);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 16;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    fxMat[type] = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
  }
  const fxGroup = new THREE.Group();
  scene.add(fxGroup);
  const fxSize = Math.min(Math.max(markSize * 1.7, 14), 60);
  const fxGeo = new THREE.CircleGeometry(1, 28);
  const emitted = new Set();

  const fwdFromAngles = (pitch, yaw, out) => {
    const dp = (pitch * Math.PI) / 180, dy = (yaw * Math.PI) / 180;
    const cp = Math.cos(dp), sp = Math.sin(dp), cy = Math.cos(dy), sy = Math.sin(dy);
    return out.set(cp * cy, -sp, -cp * sy);
  };

  // Nearest surface (world point + normal) near a path point, so a decal can be
  // laid flat on it. Probe down first (most actions are on the floor), then the
  // four horizontals (walljumps are against a wall), then up.
  const _rc = new THREE.Raycaster();
  const _Z = new THREE.Vector3(0, 0, 1);
  const PROBES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((d) => new THREE.Vector3(...d));
  const surfaceAt = (pos) => {
    if (!mapMesh) return null;
    let best = null;
    for (const d of PROBES) {
      _rc.set(pos, d);
      _rc.far = 90;
      const h = _rc.intersectObject(mapMesh, false)[0];
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    if (!best) return null;
    const n = best.face ? best.face.normal.clone().transformDirection(mapMesh.matrixWorld).normalize() : UP.clone();
    return { point: best.point, normal: n };
  };

  const addFx = (type, pos, scale = 1, surf = undefined) => {
    const s = surf === undefined ? surfaceAt(pos) : surf;
    // Per-instance material clone so each decal can fade independently as the
    // camera nears it (prevents near-plane clipping when flying through them).
    const m = new THREE.Mesh(fxGeo, fxMat[type].clone());
    m.userData.baseOpacity = 1;
    m.scale.setScalar(fxSize * scale);
    if (s) {
      m.position.copy(s.point).addScaledVector(s.normal, 0.6); // lift off surface
      m.quaternion.setFromUnitVectors(_Z, s.normal);
    } else {
      m.position.copy(pos);
      m.quaternion.setFromUnitVectors(_Z, UP); // flat, facing up (line-only maps)
    }
    fxGroup.add(m);
    emitted.add(type);
  };

  if (hasKeys) {
    const _e0 = new THREE.Vector3();
    const _aim = new THREE.Vector3();
    const MIN_GAP = 4; // frames; collapse rapid re-presses of the same action
    const lastOf = {};
    const rising = (i, bit) => (keysAt(i) & bit) && !(keysAt(i - 1) & bit);
    const emit = (type, i) => {
      if (lastOf[type] != null && i - lastOf[type] < MIN_GAP) return false;
      lastOf[type] = i;
      addFx(type, pts[i]);
      return true;
    };
    for (let i = 1; i < frames.length; i++) {
      if (rising(i, KEY_BITS.jump)) emit("jump", i);
      if (rising(i, KEY_BITS.crouch)) emit("crouch", i);
      if (rising(i, KEY_BITS.special)) {
        const vzBefore = vel[i - 1] ? vel[i - 1].y : 0;
        const vzAfter = vel[Math.min(i + 3, frames.length - 1)].y;
        emit(vzAfter - vzBefore > 80 ? "walljump" : "dash", i);
      }
      if (rising(i, KEY_BITS.fire)) {
        if (emit("shoot", i) && mapMesh) {
          // Raycast the aim vector to approximate where the shot lands and lay
          // an impact decal flat on that surface. (Exact impacts would need
          // server-side capture; this estimates from the recorded view angles.)
          _e0.copy(pts[i]).addScaledVector(UP, EYE_H);
          fwdFromAngles(ang[i][0], ang[i][1], _aim);
          _rc.set(_e0, _aim.normalize());
          _rc.far = 12000;
          const hit = _rc.intersectObject(mapMesh, false)[0];
          if (hit) {
            const n = hit.face ? hit.face.normal.clone().transformDirection(mapMesh.matrixWorld).normalize() : UP.clone();
            addFx("impact", hit.point, 0.85, { point: hit.point, normal: n });
            const tg = new THREE.BufferGeometry().setFromPoints([_e0.clone(), hit.point.clone()]);
            fxGroup.add(new THREE.Line(tg, new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.3 })));
          }
        }
      }
    }
    // Legend of what the markers mean (only the types that actually occurred).
    const rows = Object.entries(EFFECTS)
      .filter(([type]) => emitted.has(type))
      .map(([, d]) => `<span class="rv-lg"><i style="color:${d.color}">${d.glyph}</i>${d.label}</span>`)
      .join("");
    legendEl.innerHTML = rows || "";
    if (!rows) legendEl.classList.add("rv-hidden");
  }

  // Start / finish / checkpoint markers as flat surface rings (like the effect
  // decals) — laid on the floor so they read as pads and never hide the pig.
  const padGroup = new THREE.Group();
  scene.add(padGroup);
  const padRing = (pos, color, scale) => {
    const s = surfaceAt(pos);
    const m = new THREE.Mesh(
      new THREE.RingGeometry(fxSize * scale * 0.6, fxSize * scale, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    m.userData.baseOpacity = 0.9;
    if (s) { m.position.copy(s.point).addScaledVector(s.normal, 0.5); m.quaternion.setFromUnitVectors(_Z, s.normal); }
    else { m.position.copy(pos); m.quaternion.setFromUnitVectors(_Z, UP); }
    padGroup.add(m);
  };
  padRing(pts[0], 0x39d98a, 1.5); // start
  padRing(pts[pts.length - 1], 0xff4d4d, 1.5); // finish
  for (const ci of cps) if (ci > 0 && ci < pts.length) padRing(pts[ci], 0x2fd0ff, 1.1);

  // Moving player marker (cone pointing along travel direction). Anchors the
  // playback maths and is the fallback avatar if the model GLBs fail to load.
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(markSize * 1.2, markSize * 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x332200, flatShading: true })
  );
  scene.add(marker);

  // --- player model (padpork) + first-person weapon view --------------------
  // Load the rigged pig + a weapon view model. In Chase we drive the animated
  // pig (holding a greybox weapon); in POV we show a first-person greybox
  // weapon. The cone stays only as a fallback if any of this fails to load.
  let pig = null; // { root, mixer, setClip }
  let povWeaponGroup = null; // weapon parented to the camera (first person)
  let modelLoading = true; // true until the pig+weapon finish (or fail) loading
  // Each GLTFLoader.load gets a fresh loader + a timeout so a stuck fetch is
  // retried rather than hanging forever (concurrent loads through the CDN under
  // full page load could wedge indefinitely with no error).
  const loadGltfOnce = (url) => new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  const withTimeout = (pr, ms, tag) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + " timeout")), ms))]);
  const loadGltf = async (url, tries = 3) => {
    for (let k = 0; ; k++) {
      try { return await withTimeout(loadGltfOnce(url), 12000, url); }
      catch (e) { if (k >= tries - 1) throw e; }
    }
  };
  // Load the rigged models in the BACKGROUND (largest download, so a slow/cold
  // fetch must never block the viewer) and SEQUENTIALLY (concurrent GLB loads
  // through the CDN were observed to wedge). The cone shows until the pig is
  // ready; setMode() then swaps it in.
  const loadModels = async () => {
   try {
    const meta = await withTimeout(fetch("/assets/models/padpork.meta.json").then((r) => r.json()), 12000, "meta");
    const pg = await loadGltf("/assets/models/padpork.glb");
    const wg = await loadGltf("/assets/models/weapon-gunblade.glb");
    const mScale = meta.recommendedScale || 0.69;

    // Rig: axisFix converts native Quake Z-up to gl Y-up; pigRoot carries world
    // position + a yaw so the pig faces its travel direction.
    const pigRoot = new THREE.Group();
    const axisFix = new THREE.Group();
    axisFix.rotation.x = -Math.PI / 2;
    axisFix.scale.setScalar(mScale);
    axisFix.add(pg.scene);
    pigRoot.add(axisFix);
    // Force the pig OPAQUE (the shipped diffuse carries an alpha channel that
    // GLTFLoader treats as blended -> see-through) and tint it darker with the
    // same warm orange cast as the weapon view model, to match the theme.
    pg.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      for (const mt of Array.isArray(o.material) ? o.material : [o.material]) {
        mt.transparent = false;
        mt.depthWrite = true;
        mt.alphaTest = 0;
        mt.opacity = 1;
        mt.side = THREE.FrontSide;
        if (mt.color) mt.color.set(0x5a3c1f); // darker + orange (multiplies the grey diffuse)
        if (mt.emissive) mt.emissive.set(0x140b04);
        if ("metalness" in mt) mt.metalness = 0.05;
        if ("roughness" in mt) mt.roughness = 0.85;
        mt.needsUpdate = true;
      }
    });
    pigRoot.visible = false;
    scene.add(pigRoot);

    // Weapon in the pig's right hand (tag_weapon offset/angles from the bone).
    const twBone = (meta.tag_weapon && meta.tag_weapon.bone) || "Bip01 R Hand";
    let hand = null;
    pg.scene.traverse((o) => { if (o.isBone && o.name === twBone) hand = o; });
    if (hand) {
      const hw = wg.scene.clone(true);
      hw.traverse((o) => { if (o.isMesh) o.material = weaponGreyboxMaterial(); });
      const off = (meta.tag_weapon && meta.tag_weapon.offset) || {};
      const rot = (meta.tag_weapon && meta.tag_weapon.angles) || {};
      hw.position.set(off.forward || 0, off.right || 0, off.up || 0);
      hw.rotation.set(
        THREE.MathUtils.degToRad(rot.pitch || 0),
        THREE.MathUtils.degToRad(rot.yaw || 0),
        THREE.MathUtils.degToRad(rot.roll || 0)
      );
      hand.add(hw);
    }

    // Animation mixer + a crossfading clip selector.
    const mixer = new THREE.AnimationMixer(pg.scene);
    const actions = {};
    for (const clip of pg.animations) actions[clip.name] = mixer.clipAction(clip);
    let curClip = null;
    const setClip = (name) => {
      const next = actions[name];
      if (!next || name === curClip) return;
      next.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).play();
      if (curClip && actions[curClip]) actions[curClip].crossFadeTo(next, 0.18, false);
      curClip = name;
    };
    if (actions.run) { actions.run.play(); curClip = "run"; }
    pig = { root: pigRoot, mixer, setClip };

    // First-person weapon view model. Reorient native Quake axes into camera
    // space (forward +X_q -> -Z_cam, up +Z_q -> +Y_cam) and sit it low + right.
    const pov = wg.scene.clone(true);
    pov.traverse((o) => { if (o.isMesh) { o.material = weaponGreyboxMaterial(); o.frustumCulled = false; } });
    pov.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 1, 0)
      )
    );
    povWeaponGroup = new THREE.Group();
    povWeaponGroup.add(pov);
    povWeaponGroup.position.set(5, -8, -9); // low + close to the eye
    povWeaponGroup.scale.setScalar(0.55); // compact, doesn't hog the screen
    povWeaponGroup.renderOrder = 999; // draw the viewmodel last
    camera.add(povWeaponGroup);
    scene.add(camera); // so the camera's weapon child is part of the render graph
    setMode(camMode); // pig + weapon now exist — apply visibility for the current mode
   } catch (e) {
    console.warn("replay: player model load failed, using cone marker", e);
   } finally {
    modelLoading = false;
   }
  };

  // Choose the pig's animation clip from the pressed keys at a given frame.
  const clipForState = (i) => {
    const b = keysAt(i);
    if (b & KEY_BITS.crouch) return "crouch";
    if (b & KEY_BITS.special) return Math.abs(vel[i].y) > 100 ? "walljump" : "dash";
    if (b & KEY_BITS.fire) return "shoot";
    if ((b & KEY_BITS.left) && !(b & KEY_BITS.right) && !(b & KEY_BITS.fwd)) return "run_left";
    if ((b & KEY_BITS.right) && !(b & KEY_BITS.left) && !(b & KEY_BITS.fwd)) return "run_right";
    if ((b & KEY_BITS.back) && !(b & KEY_BITS.fwd)) return "run_back";
    return "run";
  };

  // Frame the camera on the whole run (used as the chase-cam seed too).
  const center = bbox.getCenter(new THREE.Vector3());
  const camDist = Math.max(200, span * 0.6);
  camera.position.set(center.x + camDist, center.y + camDist * 0.6, center.z + camDist);
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  // --- playback state -------------------------------------------------------
  const MODES = ["pov", "chase"];
  const MODE_LABEL = { pov: "POV", chase: "Chase" };
  let camMode = "pov";
  let t = 0; // seconds
  let playing = true;
  let speed = 1;
  let raf = 0;
  let curFrame = 0; // nearest frame index (drives the pig's animation clip)
  let renderTick = 0; // frame counter used to throttle render while models load
  let fxOn = true; // action markers enabled (toggled by the FX button)
  let ctrlHeld = false; // Ctrl -> free-orbit the chase cam
  const chaseDir = new THREE.Vector3(1, 0, 0); // eased trail dir (soft turns)
  let last = performance.now();
  const applyFx = () => { fxGroup.visible = fxOn; }; // flat decals — fine in POV too
  const _tmp = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _f0 = new THREE.Vector3();
  const _f1 = new THREE.Vector3();
  const viewDir = new THREE.Vector3(1, 0, 0);

  const updateKeyOverlay = (bits) => {
    for (const [name, el] of keyEls) el.classList.toggle("on", (bits & KEY_BITS[name]) !== 0);
  };

  // Strafe/accel bar: fill = actual/max acceleration, coloured like the race HUD
  // (green near/at optimal, cyan when over-optimal, grey when bleeding speed).
  const updateStrafe = (r) => {
    if (!strafeEl) return;
    strafeEl.style.width = (Math.max(0, Math.min(r, 1)) * 100).toFixed(1) + "%";
    strafeEl.style.background =
      r > 1.5 ? "#22d3ee" : r > 0.85 ? "#39d98a" : r > 0.5 ? "#8b93ab" : "#5c637d";
  };

  const sampleInto = (tSec) => {
    const x = Math.min(Math.max(tSec, 0), duration) * hz;
    const i = Math.min(Math.floor(x), pts.length - 2);
    const a = x - i;
    marker.position.copy(pts[i]).lerp(pts[i + 1], a);
    // travel direction (orients the marker cone + drives the chase cam)
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
    curFrame = a < 0.5 ? i : i + 1;
    updateKeyOverlay(keysAt(curFrame));
    return dir;
  };

  // Fade flat markers out as the camera approaches, so a decal/ring the camera
  // flies over never intersects the near clip plane and slices visibly.
  const fadeNearMarkers = (grp) => {
    for (const o of grp.children) {
      if (!o.isMesh) continue;
      const dist = o.position.distanceTo(camera.position);
      const f = Math.min(1, Math.max(0, (dist - 14) / 34)); // 0 within 14u, full by 48u
      o.material.opacity = (o.userData.baseOpacity ?? 1) * f;
      o.visible = f > 0.02;
    }
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
    updateStrafe(strafe[curFrame]);
    if (pig) {
      pig.root.position.copy(marker.position);
      const d = dir && dir.lengthSq() > 1e-6 ? dir : viewDir;
      pig.root.rotation.y = Math.atan2(-d.z, d.x); // face travel direction
      pig.mixer.update(playing ? dt * speed : 0);
      if (hasKeys) pig.setClip(clipForState(curFrame));
    }
    if (camMode === "pov") {
      // sit at the player's eye and look where they looked, at real speed
      camera.position.copy(marker.position).addScaledVector(UP, EYE_H);
      camera.lookAt(_tmp.copy(camera.position).add(viewDir));
    } else if (ctrlHeld && controls.enabled) {
      // Ctrl held: free-orbit around the pig (target tracks it as it moves).
      controls.target.lerp(_look.copy(marker.position).addScaledVector(UP, 26), 0.5);
      controls.update();
    } else {
      // chase: glide just behind + above the player, framed on the pig (~44u).
      // Ease the trail direction so quick direction changes don't whip the cam.
      const target = dir && dir.lengthSq() > 1e-6 ? dir : viewDir;
      chaseDir.lerp(target, 0.06);
      if (chaseDir.lengthSq() > 1e-6) chaseDir.normalize();
      const eye = _tmp.copy(marker.position).addScaledVector(chaseDir, -95).addScaledVector(UP, 42);
      camera.position.lerp(eye, 0.12);
      camera.lookAt(_look.copy(marker.position).addScaledVector(UP, 26));
    }
    fadeNearMarkers(fxGroup);
    fadeNearMarkers(padGroup);
    // While the model loads, render only every 3rd frame: software-WebGL frames
    // can hog the main thread and starve GLTFLoader's texture decode/upload, so
    // yield it time. Playback state still advances every frame.
    if (!modelLoading || renderTick++ % 3 === 0) renderer.render(scene, camera);
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
    const povView = m === "pov";
    if (pig) pig.root.visible = !povView; // you ARE the pig in POV
    marker.visible = !povView && !pig; // cone only when no model loaded
    if (povWeaponGroup) povWeaponGroup.visible = povView;
    controls.enabled = ctrlHeld && m === "chase";
    applyFx();
  };
  playBtn.addEventListener("click", () => setPlaying(!playing));
  seek.addEventListener("input", () => {
    t = (Number(seek.value) / 1000) * duration;
    setPlaying(false);
  });
  speedSel.addEventListener("change", () => (speed = Number(speedSel.value)));
  fxBtn.addEventListener("click", () => {
    fxOn = !fxOn;
    fxBtn.classList.toggle("on", fxOn);
    applyFx();
  });
  camBtn.addEventListener("click", () => setMode(MODES[(MODES.indexOf(camMode) + 1) % MODES.length]));
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (root.requestFullscreen ? root : stage).requestFullscreen?.();
  };
  fullBtn.addEventListener("click", toggleFull);
  const onFsChange = () => resize();
  document.addEventListener("fullscreenchange", onFsChange);
  // Hold Ctrl in Chase to free-orbit around the pig; release to snap back.
  const onKey = (e) => {
    if (e.key !== "Control") return;
    ctrlHeld = e.type === "keydown";
    controls.enabled = ctrlHeld && camMode === "chase";
    if (controls.enabled) { controls.target.copy(marker.position); controls.target.y += 26; }
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKey);
  const onBlur = () => { ctrlHeld = false; controls.enabled = false; };
  window.addEventListener("blur", onBlur);
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
  if (loadingEl) loadingEl.remove(); // scene is built — reveal the viewer now
  raf = requestAnimationFrame(tick);
  // Kick off the model download shortly after the viewer is up, so the critical
  // page resources get a head start (the 645KB GLB otherwise contends with them
  // on a fresh load). The cone shows until the pig is ready.
  setTimeout(loadModels, 500);

  // Cleanup handed back to app.js router.
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKey);
    window.removeEventListener("blur", onBlur);
    controls.dispose();
    if (pig) pig.mixer.stopAllAction();
    renderer.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    renderer.domElement.remove();
  };
}
