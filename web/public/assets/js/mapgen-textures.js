// The racesow dev textures, drawn in the page exactly as the map gets them.
//
// tools/mapgen/assets.py draws the generated maps' textures procedurally (no
// image files in git), and this is that drawing code again, pixel for pixel,
// so the map editor's 3-D view wears the same floor grid, wall wordmark,
// start chevrons and ice as the compiled map. test/mapgen-textures.test.js
// hashes every texture and compares it with the hashes tools/mapgen/golden.py
// takes of the Python's.

export const SIZE = 256;

const ORANGE = [255, 106, 26];
const ORANGE_DIM = [193, 78, 16];
const CYAN = [34, 211, 238];
const GREEN = [169, 242, 106];
const NAVY = [21, 24, 36];
const NAVY_2 = [38, 43, 61];
const WHITE = [232, 235, 245];
const YELLOW = [250, 204, 21];
const BLACK = [18, 19, 24];

const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  " ": Array(7).fill("00000"),
};

// RGB raster, y down, like assets.Canvas.
class Canvas {
  constructor(n, fill) {
    this.n = n;
    this.px = new Uint8ClampedArray(n * n * 3);
    for (let i = 0; i < n * n; i++) this.px.set(fill, i * 3);
  }
  set(x, y, c) {
    if (x >= 0 && x < this.n && y >= 0 && y < this.n) this.px.set(c, (y * this.n + x) * 3);
  }
  rect(x0, y0, x1, y1, c) {
    for (let y = Math.max(0, y0); y < Math.min(this.n, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.n, x1); x++) this.px.set(c, (y * this.n + x) * 3);
    }
  }
  grid(step, width, c, offset = 0) {
    for (let i = offset; i < this.n; i += step) {
      this.rect(i, 0, i + width, this.n, c);
      this.rect(0, i, this.n, i + width, c);
    }
  }
  text(x, y, s, scale, c) {
    for (const ch of s) {
      FONT[ch].forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] === "1") this.rect(x + gx * scale, y + gy * scale, x + (gx + 1) * scale, y + (gy + 1) * scale, c);
        }
      });
      x += 6 * scale;
    }
  }
  static textWidth(s, scale) { return (6 * s.length - 1) * scale; }
}

const shade = (c, d) => c.map((v) => Math.max(0, Math.min(255, v + d)));

function devGrid(base, labels = true, labelColor = null) {
  const c = new Canvas(SIZE, base);
  c.grid(16, 1, shade(base, -10));
  c.grid(64, 2, shade(base, -26));
  c.rect(0, 0, SIZE, 3, shade(base, -40));
  c.rect(0, 0, 3, SIZE, shade(base, -40));
  if (labels) {
    const lc = labelColor || shade(base, -34);
    ["64", "128", "192"].forEach((lab, i) => {
      c.text(6 + 64 * (i + 1), 6, lab, 1, lc);
      c.text(6, 6 + 64 * (i + 1), lab, 1, lc);
    });
  }
  return c;
}

function floor() {
  const c = devGrid([136, 140, 151]);
  c.rect(3, 3, 19, 6, ORANGE);
  c.rect(3, 3, 6, 19, ORANGE);
  return c;
}

function wall() {
  const c = devGrid([64, 69, 82], true, [92, 98, 114]);
  c.rect(0, 226, SIZE, 229, ORANGE_DIM);
  c.text(8, 236, "RACESOW", 2, ORANGE_DIM);
  return c;
}

function start() {
  const c = devGrid(NAVY, false);
  for (const tip of [22, 182]) {
    for (let i = 0; i < 30; i++) {
      for (let w = 0; w < 7; w++) {
        c.set(128 - i, tip + i + w, GREEN);
        c.set(128 + i, tip + i + w, GREEN);
      }
    }
  }
  const s = "START";
  c.text(Math.floor((SIZE - Canvas.textWidth(s, 5)) / 2), 108, s, 5, GREEN);
  return c;
}

function finish() {
  const c = new Canvas(SIZE, WHITE);
  for (let y = 0; y < SIZE; y += 32) {
    for (let x = 0; x < SIZE; x += 32) if ((x / 32 + y / 32) % 2) c.rect(x, y, x + 32, y + 32, BLACK);
  }
  c.rect(0, 96, SIZE, 160, ORANGE);
  const s = "FINISH";
  c.text(Math.floor((SIZE - Canvas.textWidth(s, 5)) / 2), 111, s, 5, BLACK);
  return c;
}

function checkpoint() {
  const c = new Canvas(SIZE, NAVY_2);
  c.rect(0, 0, SIZE, 6, CYAN);
  c.rect(0, SIZE - 6, SIZE, SIZE, CYAN);
  for (let x = 0; x < SIZE; x += 128) c.text(x + 40, 100, "CP", 6, CYAN);
  return c;
}

function edge() {
  const c = new Canvas(SIZE, BLACK);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (Math.floor((x + y) / 32) % 2 === 0) c.set(x, y, ORANGE);
  }
  return c;
}

function trim() {
  const c = new Canvas(SIZE, ORANGE);
  c.rect(0, 0, SIZE, 8, WHITE);
  c.rect(0, SIZE - 8, SIZE, SIZE, WHITE);
  return c;
}

function pylon() {
  const c = new Canvas(SIZE, NAVY_2);
  for (let x = 0; x < SIZE; x += 64) c.rect(x + 8, 0, x + 40, SIZE, CYAN);
  c.rect(0, 0, SIZE, 6, WHITE);
  c.rect(0, SIZE - 6, SIZE, SIZE, WHITE);
  return c;
}

function kick() {
  const c = new Canvas(SIZE, NAVY_2);
  for (let y0 = 0; y0 < SIZE; y0 += 64) {
    for (let k = 0; k < 24; k++) {
      const y = y0 + 20 + k;
      const w = k * 3;
      c.rect(128 - w - 12, y, 128 - w, y + 1, YELLOW);
      c.rect(128 + w, y, 128 + w + 12, y + 1, YELLOW);
    }
  }
  c.rect(0, 0, 6, SIZE, YELLOW);
  c.rect(SIZE - 6, 0, SIZE, SIZE, YELLOW);
  return c;
}

function ice() {
  const base = [172, 214, 232];
  const c = devGrid(base, true, [120, 168, 190]);
  const frost = [226, 244, 252];
  for (const [x0, y0, n] of [[40, 70, 46], [150, 30, 30], [176, 150, 54], [60, 190, 26], [110, 120, 18]]) {
    for (let i = 0; i < n; i++) c.rect(x0 + i, y0 - i, x0 + i + 2, y0 - i + 1, frost);
  }
  c.rect(3, 3, 19, 6, CYAN);
  c.rect(3, 3, 6, 19, CYAN);
  const s = "ICE";
  c.text(Math.floor((SIZE - Canvas.textWidth(s, 4)) / 2), 210, s, 4, [140, 190, 212]);
  return c;
}

const MAKERS = { floor, wall, start, finish, checkpoint, edge, trim, pylon, kick, ice };
export const KINDS = Object.keys(MAKERS);

// The texture as rows of RGB, top row first (the image as drawn, not as TGA
// stores it).
export function rgb(kind) {
  return MAKERS[kind]().px;
}

// The texture as RGBA, top row first, for a canvas ImageData or a WebGL
// texture upload.
export function rgba(kind) {
  const px = rgb(kind);
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; out[j + 3] = 255;
  }
  return out;
}
