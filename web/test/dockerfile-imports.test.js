// The web image copies an explicit list of files (Dockerfile), so a new local
// module that server.js imports but the list forgets builds fine and then
// crashes on boot with ERR_MODULE_NOT_FOUND. That is how mapgen-identity.js
// first broke the full-stack e2e. Walk the local import graph from the entry
// points the image runs and check every file in it is copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function copiedFiles() {
  const out = new Set();
  for (const line of fs.readFileSync(path.join(WEB, "Dockerfile"), "utf8").split("\n")) {
    const m = /^COPY\s+(?!--)(.+?)\s+\S+\s*$/.exec(line.trim());
    if (m) for (const f of m[1].split(/\s+/)) out.add(f);
  }
  return out;
}

function localImports(file) {
  const src = fs.readFileSync(path.join(WEB, file), "utf8");
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.\/[^"']+)["']/g;
  return [...src.matchAll(re)].map((m) => path.normalize(m[1]));
}

test("every local module the image runs is copied into it", () => {
  const copied = copiedFiles();
  const seen = new Set();
  const queue = ["server.js", "heatmap.js", "admin.js"];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    assert.ok(copied.has(f), `${f} is imported by the image's code but not COPY'd in web/Dockerfile`);
    queue.push(...localImports(f));
  }
  assert.ok(seen.has("mapgen-identity.js"), "the walk should reach server.js's imports");
});
