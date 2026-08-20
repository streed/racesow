// One definition of "is this a map name we will accept?", shared by everything
// that turns a name into a database lookup, a game payload, or a file on disk.
//
// It lives in its own module rather than in db.js because the .bsp/.pk3 readers
// (bsp.js, mapindex.js) need the same rule and must not drag the Postgres client
// into the heatmap sidecar. db.js re-exports it, so existing importers are
// unaffected.

// Longest map name we will accept. The longest real one on the board is 47
// chars, and the reverse boards ask for "<name>-reversed" (+9), so this is
// headroom rather than a constraint anyone races into.
export const MAX_MAP_NAME = 64;

// Punctuation a map name may contain after its first character.
//
// The rule used to stop at `_ . -`, which quietly excluded 22 real maps whose
// names carry a '!', '#', '^' or '`' — un-dead!020_3, gu3#5-stickupkids, 4^3,
// 3ont-p900`archi and friends. Those maps are in the pool and their finishes DO
// land in the database (/api/ingest never applied this check), so the only thing
// the rule achieved was a map with a full leaderboard on the site and, in game,
// an empty `top`, no scoreboard rank, no PB header, no ghost and no saved start.
//
// It stays an allowlist rather than becoming "anything printable", because a map
// name is not just a database key here — it is spliced into an engine console
// command (`map <name>`), into generated cfg lines, into shell variables in
// entrypoint.sh/crashguard.sh, into a file name under topscores/race/, and into
// the double-quoted token format of the topscores payload. So the characters
// that steer any of those stay out for good, and are worth naming:
//
//   ; $ &   would end the console command / cfg line and start another one
//   " '     quote the topscores tokens and the generated cfg
//   / \     directory separators (and '//' starts an engine comment)
//   % 	   would make a percent-decoded name round-trip into a different one
//   * ?     glob metacharacters in the shell paths that carry map names
//   : < > | path-hostile, and no real map wants them
//
// What is left is inert in every one of those sinks: the game percent-encodes
// the name into the query string (server/enginepatches/g_rs_api.cpp), and every
// SQL use is parameterised. Adding a character here means checking it against
// that list of sinks — not just against the map that prompted it.
const MAP_NAME_PUNCT = "_.-!#^`~+=@()[],";

// Feed this an already-lowercased name (every map row is lowercase).
export function isSafeMapName(name) {
  const n = String(name == null ? "" : name);
  if (!n || n.length > MAX_MAP_NAME) return false;
  // A leading '.' or '-' is what turns a name into "../.." or into something a
  // command line reads as an option, so the first character is always alphanumeric.
  if (!/^[a-z0-9]$/.test(n[0])) return false;
  for (let i = 1; i < n.length; i++) {
    const c = n[i];
    if (/[a-z0-9]/.test(c)) continue;
    if (!MAP_NAME_PUNCT.includes(c)) return false;
  }
  return !n.includes(".."); // belt and braces: no directory escape
}
