# model2glb

Pure-Node.js (no Blender/Assimp) converters that turn Warsow player and weapon
models into binary glTF (`.glb`) for the three.js browser viewer under
`web/public/assets/`.

Two entry points plus a shared GLB writer:

| file          | reads                              | writes                                   |
|---------------|------------------------------------|------------------------------------------|
| `iqm2glb.js`  | padpork IQM v2 + `animation.cfg`   | `padpork.glb` (skinned) + `padpork.meta.json` |
| `md32glb.js`  | weapon `*.md3` (Quake3 MD3 v15)    | `weapon-<name>.glb` (static geometry)    |
| `glb.js`      | —                                  | shared `GlbBuilder` + `validateGlb`      |

Everything uses only Node built-ins. The one external dependency is a one-time
texture conversion done with ImageMagick (see below); the converters themselves
assume the PNG already exists.

## Run

```sh
# 1. convert the diffuse texture once (ImageMagick). grayscale fullbright diffuse.
convert tools/wsw-assets/models/players/padpork/padpork_diff_fb.tga \
        web/public/assets/models/padpork_diff.png

# 2. player model -> skinned GLB + meta sidecar
node tools/model2glb/iqm2glb.js

# 3. race weapons -> static GLBs
node tools/model2glb/md32glb.js
```

Both scripts are re-runnable and idempotent. `md32glb.js <in.md3> <out.glb>`
also converts a single MD3.

## Outputs (under web/public/assets/models/)

- `padpork.glb` — SkinnedMesh: 34-joint skeleton, inverse bind matrices,
  `JOINTS_0`/`WEIGHTS_0` skin attributes, `POSITION`/`NORMAL`/`TEXCOORD_0`, an
  embedded `padpork_diff.png` baseColorTexture, and 10 named animation clips:
  `idle, run, run_back, run_left, run_right, jump, walljump, dash, crouch,
  shoot`. Clips are sampled from `animation.cfg` frame ranges at their fps.
- `padpork.meta.json` — tag_weapon attach data, clip list, model height in units.
- `weapon-gunblade.glb`, `weapon-rlauncher.glb`, `weapon-plasmagun.glb` —
  static, textureless weapon geometry (`POSITION` + `NORMAL` + indices), plus an
  empty `tag_weapon` node marking the hand-attach origin.

## Coordinate system

All GLBs are emitted in **native Quake axes** (Z-up, X forward, Y left) — NOT
pre-rotated. The viewer applies the Quake -> glTF swap `(x,y,z) -> (x, z, -y)`
itself (matching `tools/bsp2gltf/bsp2gltf.js`). This is recorded in
`padpork.meta.json`.

## Format notes / gotchas

- **IQM channels.** Poses carry a 10-channel TRS (3 translate, 4 rotate quat
  xyzw, 3 scale). Frame data is ushort deltas: `value = channeloffset[c] +
  framedata[ptr++] * channelscale[c]` when the pose's channelmask bit is set,
  else just `channeloffset[c]`. `animation.cfg` frame indices are **1-based**
  into the IQM frame array.
- **Inverse bind matrices** come from each joint's global bind transform (base
  joint TRS composed up the parent chain), inverted. Verified:
  `globalBind · inverseBind == I` to 1e-15.
- **Constant-channel pruning.** A clip channel is emitted only if the joint's
  value varies within the clip *or* differs from the node's bind default.
  Constant-and-equal-to-default channels are dropped (glTF leaves the joint at
  its default). This is lossless — reconstructing every clip's per-frame TRS
  from the pruned GLB matches direct IQM sampling to <2e-4 — and cuts the file
  from ~970 KB to ~630 KB. All scale channels drop (scale never animates here).
- **MD3 `_hand.md3` has no geometry.** In these assets `<weapon>_hand.md3` is a
  positioning rig: `numSurfaces == 0`, it only carries the `tag_weapon` tag and
  a 60-frame hands animation. The actual weapon mesh lives in `<weapon>.md3`, so
  `md32glb.js` takes **geometry from `<weapon>.md3`** and reads the tag_weapon
  origin from `<weapon>_hand.md3`. All surfaces of the main model are included.
- **MD3 vertices** are int16 scaled 1/64 -> units; normals are lat/lng packed
  (2 bytes) and decoded to unit vectors. Frame 0 only (static viewmodel).
- **padpork diffuse** (`padpork_diff_fb.tga`) is genuinely an 8-bit grayscale
  fullbright diffuse (TGA image type 3), so the PNG is grayscale by design.

## Validation

Every write is followed by `validateGlb()` which re-parses the file: checks the
12-byte header, JSON + BIN chunk framing, declared length, and that each
accessor's byte span fits inside its bufferView. Structural only (no GL
context) — the converters print accessor counts, clip names, and POSITION
min/max so output can be eyeballed.
