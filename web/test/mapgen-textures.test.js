// The map editor's textures, pinned to the generator's.
//
// public/assets/js/mapgen-textures.js redraws tools/mapgen/assets.py's dev
// textures in the page so the editor's 3-D view looks like the compiled map.
// fixtures/mapgen-textures.json holds the sha256 of each Python texture's
// pixels (RGB, top row first), written by tools/mapgen/golden.py; every one
// must come back byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { KINDS, SIZE, rgb, rgba } from "../public/assets/js/mapgen-textures.js";

const want = JSON.parse(readFileSync(new URL("./fixtures/mapgen-textures.json", import.meta.url), "utf8"));

test("the editor draws every texture the generator ships, and only those", () => {
  assert.deepEqual([...KINDS].sort(), Object.keys(want).sort());
});

for (const kind of KINDS) {
  test(`${kind} is the same picture`, () => {
    const px = rgb(kind);
    assert.equal(px.length, SIZE * SIZE * 3);
    assert.equal(createHash("sha256").update(px).digest("hex"), want[kind]);
  });
}

test("rgba is rgb with an opaque alpha", () => {
  const a = rgba("ice"), b = rgb("ice");
  assert.equal(a.length, SIZE * SIZE * 4);
  assert.deepEqual([a[0], a[1], a[2], a[3]], [b[0], b[1], b[2], 255]);
});
