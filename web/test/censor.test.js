import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, maskAll, censorName, normalizeTerm } from "../censor.js";

// A representative slice of the seeded word list (see migration 20260728...).
const TERMS = [
  { term: "nigger", mode: "norm", severity: "slur" },
  { term: "nigga", mode: "norm", severity: "slur" },
  { term: "faggot", mode: "norm", severity: "slur" },
  { term: "hitler", mode: "norm", severity: "hate" },
  { term: "1488", mode: "norm", severity: "hate" },
  { term: "whore", mode: "norm", severity: "profanity" },
  { term: "fuck", mode: "norm", severity: "profanity" },
  { term: "cunt", mode: "norm", severity: "sexual" },
  { term: "cock", mode: "word", severity: "profanity" },
  { term: "cum", mode: "word", severity: "sexual" },
  { term: "rape", mode: "word", severity: "sexual" },
];
const M = buildMatcher(TERMS);

test("clean names are untouched", () => {
  for (const n of ["^7Job", "^4<^7acc^4/^7funk^7", "Fleks", "kod^44^7", ""]) {
    assert.equal(M.mask(n).hit, false);
    assert.equal(M.mask(n).name, n);
  }
});

test("plain slur is masked, colour codes preserved", () => {
  assert.equal(M.mask("^0NIGGER").name, "^0******");
  assert.equal(M.mask("^7Faggot").name, "^7******");
});

test("partial mask keeps the clean part of the name", () => {
  assert.equal(M.mask("Girl Nigger").name, "Girl ******");
  assert.equal(M.mask("^6BIGGA ^1NIGGA").name, "^6BIGGA ^1*****");
});

test("separator evasion is defeated (matches on stripped form)", () => {
  // wh|ore -> stripped "whore" -> all five letters starred, the '|' stays.
  assert.equal(M.mask("wh|ore").name, "**|***");
  assert.equal(M.mask("AF(uc)K").hit, true); // -> "afuck"
});

test("colour codes spliced into the slur don't help", () => {
  assert.equal(M.mask("^1f^2u^3ck").name, "^1*^2*^3**");
});

test("leetspeak is folded", () => {
  assert.equal(M.mask("n1gg3r").name, "******");
  assert.equal(M.mask("H1TL3R").hit, true);
});

test("numeric hate code matches literally but not folded away", () => {
  assert.equal(M.mask("SVT1488").name, "SVT****");
  assert.equal(normalizeTerm("1488"), "1488"); // term not corrupted by leet fold
});

test("word-mode avoids substring false positives", () => {
  for (const clean of ["cocktail", "peacock", "accumulate", "scumbag", "grape", "drapery"]) {
    assert.equal(M.mask(clean).hit, false, `${clean} should be clean`);
  }
});

test("word-mode still catches the standalone word", () => {
  assert.equal(M.mask("Cock Leo").name, "**** Leo");
  assert.equal(M.mask("Fifth Cum Today").name, "Fifth *** Today");
  // "^R" is a literal caret (R isn't a colour digit) so it stays and acts as a
  // word boundary — the real DB nick "DG^Rape" is caught.
  assert.equal(M.mask("DG^Rape").name, "DG^****");
});

test("word-mode boundaries treat underscore as a separator (no evasion)", () => {
  // JS \b counts '_' as a word char; we must not, or "_cum_" slips through.
  assert.equal(M.mask("_Cum_").hit, true);
  assert.equal(M.mask("cock_blocked").name, "****_blocked");
  assert.equal(M.mask("x_rape_y").hit, true);
  // ...but a letter/digit fused to the term still blocks it (no false positive).
  assert.equal(M.mask("scumbag").hit, false);
  assert.equal(M.mask("cocktail").hit, false);
});

test("word-mode limitation: a word fused by a colour code is not auto-caught", () => {
  // "DG^1Rape" strips to "dgrape" (contiguous) so word-mode 'rape' won't fire —
  // this is the deliberate trade to keep "grape" clean. An admin 'censor'
  // override (or a norm-mode term) handles such a nick if it ever appears.
  assert.equal(M.mask("DG^1Rape").hit, false);
  assert.equal(censorName("DG^1Rape", M, "censor"), "**^1****");
});

test("scan reports which terms and severities tripped", () => {
  const hits = M.scan("Girl Nigger");
  assert.deepEqual(hits, [{ term: "nigger", severity: "slur" }]);
  assert.equal(M.scan("Fleks").length, 0);
});

test("maskAll force-censors every visible char, keeping colours", () => {
  assert.equal(maskAll("^1ab^2c"), "^1**^2*");
  assert.equal(maskAll("Job"), "***");
});

test("censorName honours per-player overrides", () => {
  assert.equal(censorName("^0NIGGER", M, "allow"), "^0NIGGER"); // whitelist beats the word list
  assert.equal(censorName("^7Job", M, "censor"), "^7***"); // force-censor a missed name
  assert.equal(censorName("^0NIGGER", M, undefined), "^0******");
  assert.equal(censorName("^7Job", M, undefined), "^7Job");
});

test("null / undefined names pass through", () => {
  assert.equal(M.mask(null).name, null);
  assert.equal(censorName(undefined, M), undefined);
});
