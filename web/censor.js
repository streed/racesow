// Player-name censoring — pure, dependency-free matching + masking.
//
// Offensive nicks are masked at DISPLAY time only (the stored player.name /
// simplified / trimmed are never altered — see migration 20260728120000000).
// A name is masked by turning the OFFENDING letters into '*' while keeping the
// rest of the nick, its Warsow ^0-^9 colour codes, and its punctuation intact
// (e.g. "^1Girl ^4Nigger" -> "^1Girl ^4******").
//
// Matching is deliberately evasion-resistant. Warsow nicks smuggle slurs past a
// naive filter three ways: colour codes ("^1f^2u^3ck"), separators ("wh|ore",
// "f.a.g") and leetspeak ("n1gg3r"). So a term is tested against the name's
// aggressive normal form — colour codes and non-alphanumerics stripped, lower-
// cased, digits leet-folded — and every alphanumeric that participated in a hit
// is mapped back to its ORIGINAL index in the raw string and starred there.
//
// Two match modes per term (see censor_term.mode):
//   'norm'  substring anywhere in the stripped form. Defeats separators, so it
//           is the right default for slurs ("wh|ore" -> normal form "whore").
//   'word'  whole word in the colour-stripped (but punctuation-kept) name. Fewer
//           false positives for short tokens ("cum" won't fire inside
//           "accumulate", "cock" won't fire inside "cocktail").

// Leet substitutions applied to BOTH the name and (implicitly) the digit-bearing
// terms so "n1gg3r"/"h1tl3r" fold onto "nigger"/"hitler". Length-preserving, so
// a hit's indices in the folded string are also valid in the original.
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };
function foldLeet(s) {
  let out = "";
  for (const c of s) out += LEET[c] || c;
  return out;
}

// Alphanumeric normal form of a raw name: drop ^N colour codes, keep [a-z0-9]
// only, lowercase. `map[k]` is the index in `raw` of the k-th normal-form char,
// so a hit at normal-form range [s,e) masks raw positions map[s..e-1].
function normIndex(raw) {
  let norm = "";
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "^" && i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "9") {
      i++; // skip the colour digit too
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) {
      norm += c.toLowerCase();
      map.push(i);
    }
  }
  return { norm, map };
}

// Colour-stripped form that KEEPS punctuation/spaces (lowercased), for 'word'
// matches that need real word boundaries. `map[k]` -> index in `raw`.
function simpIndex(raw) {
  let simp = "";
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "^" && i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "9") {
      i++;
      continue;
    }
    simp += raw[i].toLowerCase();
    map.push(i);
  }
  return { simp, map };
}

function isAlnum(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
}

// Normalise a candidate term: lowercase, drop non-alphanumerics. NOT leet-folded
// — the term is the canonical spelling ("nigger", "1488"); leet folding is a
// property of the NAME being tested, not of the term (folding "1488" would wreck
// it -> "ia88"). Empty result -> term is dropped.
export function normalizeTerm(term) {
  return String(term || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a reusable matcher from a term list [{term, mode, severity}]. Terms are
// re-normalised (and leet-folded) once here; matching is then plain string ops.
export function buildMatcher(terms) {
  const norm = [];
  const word = [];
  const meta = new Map(); // normalised term -> severity (for reporting)
  for (const t of terms || []) {
    const key = normalizeTerm(t.term);
    if (!key) continue;
    meta.set(key, t.severity || "profanity");
    if (t.mode === "word") word.push(key);
    else norm.push(key);
  }
  // Precompile a single alternation regex for the word terms. We use explicit
  // alphanumeric-only lookarounds instead of \b because JS \b treats '_' as a
  // word char, which would let "_rape_" / "cock_blocked" slip past word-mode
  // terms. Here '_', punctuation, spaces and string edges are ALL boundaries,
  // while a letter/digit next to the term still blocks it ("therapist","grape").
  // The lookarounds are zero-width, so a match's index/length is just the term.
  const wordRe = word.length
    ? new RegExp("(?<![a-z0-9])(?:" + word.map(escapeRegExp).join("|") + ")(?![a-z0-9])", "g")
    : null;

  function collect(raw) {
    const hitTerms = new Set();
    const toMask = new Set(); // raw indices to star

    if (norm.length) {
      const { norm: n, map } = normIndex(raw);
      // Search the literal stripped form AND its leet-folded twin, so both a
      // real "1488" (only in the literal form) and "n1gg3r" (only once folded)
      // are caught. Both strings share `map` (folding is length-preserving).
      for (const hay of n === foldLeet(n) ? [n] : [n, foldLeet(n)]) {
        for (const term of norm) {
          for (let from = 0; ; ) {
            const at = hay.indexOf(term, from);
            if (at < 0) break;
            for (let k = at; k < at + term.length; k++) toMask.add(map[k]);
            hitTerms.add(term);
            from = at + 1; // allow overlaps
          }
        }
      }
    }

    if (wordRe) {
      const { simp, map } = simpIndex(raw);
      for (const s of [simp, foldLeet(simp)]) {
        wordRe.lastIndex = 0;
        let m;
        while ((m = wordRe.exec(s))) {
          for (let k = m.index; k < m.index + m[0].length; k++) {
            if (isAlnum(s[k])) toMask.add(map[k]);
          }
          hitTerms.add(normalizeTerm(m[0]));
          if (m[0].length === 0) wordRe.lastIndex++;
        }
      }
    }
    return { toMask, hitTerms };
  }

  return {
    // Which terms (if any) a raw name trips — used by the admin review scan.
    // Returns [] for a clean name.
    scan(raw) {
      if (raw == null) return [];
      const { hitTerms } = collect(String(raw));
      return [...hitTerms].map((t) => ({ term: t, severity: meta.get(t) || "profanity" }));
    },
    // Mask the offending letters in a raw name. Returns { name, hit }.
    mask(raw) {
      if (raw == null) return { name: raw, hit: false };
      const str = String(raw);
      const { toMask } = collect(str);
      if (!toMask.size) return { name: str, hit: false };
      return { name: starAt(str, toMask), hit: true };
    },
    _terms: { norm, word }, // exposed for tests
  };
}

function starAt(raw, indices) {
  let out = "";
  for (let i = 0; i < raw.length; i++) out += indices.has(i) ? "*" : raw[i];
  return out;
}

// Force-mask EVERY visible character of a name (colour codes preserved). Used by
// an admin 'censor' override for a nick the word list didn't catch.
export function maskAll(raw) {
  if (raw == null) return raw;
  const str = String(raw);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "^" && i + 1 < str.length && str[i + 1] >= "0" && str[i + 1] <= "9") {
      out += str[i] + str[i + 1];
      i++;
      continue;
    }
    out += isAlnum(str[i]) ? "*" : str[i];
  }
  return out;
}

// Convenience wrapper the DB layer calls per displayed name. `override` is
// 'allow' | 'censor' | undefined for the specific player row being shown.
export function censorName(raw, matcher, override) {
  if (raw == null) return raw;
  if (override === "allow") return raw;
  if (override === "censor") return maskAll(raw);
  if (!matcher) return raw;
  return matcher.mask(raw).name;
}
