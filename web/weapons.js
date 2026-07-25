// Canonical Warsow weapon set for map tagging + randmap-by-weapon voting.
//
// A map's "weapons" are the weapon_* spawn entities its .bsp carries (see
// scan-map-weapons.js). Each weapon has a 2-char CODE (what the DB stores and
// the game votes on), the entity CLASSNAME that marks its presence, a display
// NAME, and human ALIASES the website filter / in-game vote also accept.
//
// Keep this in sync with the AngelScript alias table in
// server/racemod/source/progs/gametypes/hrace/mapweapons.as (that side can't
// import JS, so the two lists are maintained together).
export const WEAPONS = [
  { code: "gb", classname: "weapon_gunblade", name: "Gunblade", aliases: ["gunblade"] },
  { code: "mg", classname: "weapon_machinegun", name: "Machinegun", aliases: ["machinegun"] },
  { code: "rg", classname: "weapon_riotgun", name: "Riotgun", aliases: ["riotgun", "shotgun"] },
  { code: "gl", classname: "weapon_grenadelauncher", name: "Grenade Launcher", aliases: ["grenadelauncher", "grenade"] },
  { code: "rl", classname: "weapon_rocketlauncher", name: "Rocket Launcher", aliases: ["rocketlauncher", "rocket"] },
  { code: "pg", classname: "weapon_plasmagun", name: "Plasmagun", aliases: ["plasmagun", "plasma"] },
  { code: "lg", classname: "weapon_lasergun", name: "Lasergun", aliases: ["lasergun", "laser"] },
  { code: "eb", classname: "weapon_electrobolt", name: "Electrobolt", aliases: ["electrobolt", "electro", "bolt"] },
  { code: "ig", classname: "weapon_instagun", name: "Instagun", aliases: ["instagun", "insta"] },
];

// Every player spawns holding a gunblade, so a map whose only weapon pickup is a
// gunblade is still a "strafe" (movement-only) map. gb is excluded from the
// strafe test but still recorded, so `randmap gb` can find gunblade-pickup maps.
export const STRAFE_IGNORE = new Set(["gb"]);

export const CLASSNAME_TO_CODE = Object.fromEntries(WEAPONS.map((w) => [w.classname, w.code]));
export const CODE_TO_WEAPON = Object.fromEntries(WEAPONS.map((w) => [w.code, w]));
export const ALL_CODES = WEAPONS.map((w) => w.code);

// A map is a strafe map when it carries no weapon other than the gunblade.
export function isStrafe(codes) {
  return !codes.some((c) => !STRAFE_IGNORE.has(c));
}

// Weapon codes present in a BSP entity-lump text (see bsp.js parseEntities),
// deduped and returned in canonical (WEAPONS) order so the stored array is
// stable across scans. Matches `"classname" "weapon_..."` blocks.
const CLASSNAME_RE = /"classname"\s*"(weapon_[a-z0-9_]+)"/gi;
export function codesFromEntities(text) {
  const set = new Set();
  CLASSNAME_RE.lastIndex = 0;
  let m;
  while ((m = CLASSNAME_RE.exec(String(text || ""))) !== null) {
    const code = CLASSNAME_TO_CODE[m[1].toLowerCase()];
    if (code) set.add(code);
  }
  return ALL_CODES.filter((c) => set.has(c));
}

// Resolve a typed token (2-char code, full name, or alias — case-insensitive) to
// a weapon code, or null if it isn't a weapon. "strafe" is handled by callers.
const TOKEN_TO_CODE = (() => {
  const m = Object.create(null);
  for (const w of WEAPONS) {
    m[w.code] = w.code;
    for (const a of w.aliases) m[a] = w.code;
  }
  return m;
})();
export function tokenToCode(token) {
  return TOKEN_TO_CODE[String(token || "").trim().toLowerCase()] || null;
}
