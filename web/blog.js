// Site-update posts: slugs, the markdown-lite renderer, and the plain-text
// excerpt used for teasers, OG cards and the feed.
//
// Posts are admin-authored, but "trusted author" is not a reason to inject raw
// HTML into every reader's page: an admin session is exactly what an XSS would
// be after, and the same text is re-served in the RSS feed where it lands in
// third-party readers. So this renderer NEVER passes author HTML through. It
// escapes the whole body FIRST and only then re-introduces markup from its own
// fixed vocabulary — there is no path from input bytes to a tag we did not
// write. (Escaping first is also why a URL's "&" survives correctly: it is
// already "&amp;" by the time it lands in an href.)
//
// The vocabulary is deliberately small — headings, lists, quotes, code, links,
// bold/italic — because these are changelog posts, not articles.

export const BLOG_TAGS = [
  { value: "maps", label: "New maps" },
  { value: "update", label: "Site update" },
  { value: "servers", label: "Servers" },
  { value: "event", label: "Event" },
];
const TAG_VALUES = new Set(BLOG_TAGS.map((t) => t.value));

export const isBlogTag = (t) => TAG_VALUES.has(String(t || ""));
export const blogTagLabel = (t) =>
  (BLOG_TAGS.find((x) => x.value === t) || { label: "Update" }).label;

export const MAX_TITLE = 140;
export const MAX_SUMMARY = 300;
export const MAX_BODY = 20000;
export const MAX_SLUG = 80;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

// Strip control characters (keeping \n and \t) and normalise newlines. Applied
// to every stored field: control bytes have no meaning in a post and would ride
// straight into the XML feed, where they are not even well-formed.
export function sanitizeText(raw, max) {
  const s = String(raw == null ? "" : raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return max ? s.slice(0, max) : s;
}

// Title -> URL slug. Kept ASCII-only and lowercase: the slug is the permanent
// public identity of a post, so it must be typeable and stable, not a
// percent-encoded blob. Returns "" when a title has no slug-able characters —
// the caller falls back to a dated slug rather than storing an empty one.
export function slugify(title) {
  return String(title == null ? "" : title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining marks left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, ""); // the slice may have landed mid-separator
}

// A slug is valid iff slugify() would leave it untouched — so every stored slug
// is one the router can round-trip, whether it was derived or hand-typed.
export const isValidSlug = (s) => typeof s === "string" && s.length > 0 && slugify(s) === s;

// Only schemes that cannot execute script. Checked against the ESCAPED url, which
// is safe: escaping never introduces a ":" and never rewrites a leading scheme,
// so "javascript:..." is still recognisably itself here and gets rejected.
const SAFE_URL = /^(?:https?:\/\/|mailto:|\/)/i;

// Inline spans, applied to already-escaped text. Code spans are lifted out
// first so their contents are never treated as emphasis (`a *b* c` inside
// backticks must stay literal), then restored at the end.
function inline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000c${codes.length - 1}\u0000`;
  });

  // [text](url) — the url is dropped (link rendered as plain text) when the
  // scheme is not one of ours, so a bad link degrades instead of disappearing.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    if (!SAFE_URL.test(url)) return text;
    // Off-site links open in a new tab; site-relative ones navigate in place so
    // the SPA router handles them.
    const external = !url.startsWith("/");
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener nofollow"' : ""}>${text}</a>`;
  });

  // Bold first, so its "**" are consumed before the single-"*" pass sees them.
  //
  // The italic rule is deliberately stricter than "any two asterisks": race
  // posts are full of map-name globs (bug*, dm_*, kairos-*) and an eager rule
  // turned "bug*, dm_*" into "bug<em>, dm_</em>". Borrowing the useful half of
  // CommonMark's flanking rules: an opener may not sit directly after a word
  // character or start a run of whitespace, and a closer may not sit directly
  // before one. That keeps *emphasis* working and leaves globs alone.
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?![\w*])/g, "$1<em>$2</em>");

  return s.replace(/\u0000c(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

const LIST_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

// Render one blank-line-separated block. Headings start at <h3>: the page
// already owns <h1> (site) and <h2> (post title), so a post that starts with
// "## Foo" must not outrank them in the document outline.
function renderBlock(lines) {
  const first = lines[0];

  const heading = /^(#{2,4})\s+(.*)$/.exec(first);
  if (heading) {
    const level = Math.min(heading[1].length + 1, 5); // ## -> h3, ### -> h4, #### -> h5
    return `<h${level}>${inline(esc(heading[2].trim()))}</h${level}>`;
  }

  if (/^\s*(?:---+|\*\*\*+)\s*$/.test(first) && lines.length === 1) return "<hr>";

  if (LIST_ITEM.test(first) || ORDERED_ITEM.test(first)) {
    const ordered = !LIST_ITEM.test(first) && ORDERED_ITEM.test(first);
    const items = [];
    for (const line of lines) {
      const m = (ordered ? ORDERED_ITEM : LIST_ITEM).exec(line);
      // A continuation line (no marker) belongs to the item above it.
      if (m) items.push(m[1]);
      else if (items.length) items[items.length - 1] += " " + line.trim();
      else items.push(line.trim());
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((i) => `<li>${inline(esc(i))}</li>`).join("")}</${tag}>`;
  }

  if (/^\s*>/.test(first)) {
    const text = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
    return `<blockquote>${inline(esc(text)).replace(/\n/g, "<br>")}</blockquote>`;
  }

  // Plain paragraph. Single newlines become <br> — changelog posts lean on
  // hard-wrapped lines far more than on prose reflow.
  return `<p>${inline(esc(lines.join("\n"))).replace(/\n/g, "<br>")}</p>`;
}

// Markdown-lite -> HTML. Safe to insert as-is: every tag in the output was
// written by this function, never by the author.
export function renderBody(body) {
  const src = sanitizeText(body);
  const lines = src.split("\n");
  const out = [];
  let block = [];
  let fence = null; // non-null while inside a ``` block
  let fenced = [];

  const flush = () => {
    if (block.length) out.push(renderBlock(block));
    block = [];
  };

  for (const line of lines) {
    const fenceMark = /^\s*```(.*)$/.exec(line);
    if (fence !== null) {
      if (fenceMark) {
        out.push(`<pre><code>${esc(fenced.join("\n"))}</code></pre>`);
        fence = null;
        fenced = [];
      } else fenced.push(line);
      continue;
    }
    if (fenceMark) {
      flush();
      fence = fenceMark[1] || "";
      continue;
    }
    if (line.trim() === "") flush();
    else block.push(line);
  }
  // An unterminated fence still renders — losing the tail of a post to a typo'd
  // closing marker is worse than rendering it as code.
  if (fence !== null && fenced.length) out.push(`<pre><code>${esc(fenced.join("\n"))}</code></pre>`);
  flush();

  return out.join("\n");
}

// Plain-text teaser: the post's own summary when it has one, otherwise the
// opening prose of the body with the markup stripped. Used by the list view,
// the OG description and the feed, so it must never contain markup.
export function excerpt(body, limit = 200) {
  const text = sanitizeText(body)
    .replace(/```[\s\S]*?(?:```|$)/g, " ") // drop fenced code entirely
    .split("\n")
    .filter((l) => !/^\s*(?:#{1,6}\s|>|---+\s*$)/.test(l))
    // Strip list markers per LINE, before the join: once the lines are one
    // string the /^/m anchor no longer sees them and every bullet survives into
    // the teaser as a stray "- ".
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))
    .join(" ")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1") // links -> their text
    .replace(/[*`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  // Cut on a word boundary so the teaser doesn't end mid-word.
  const cut = text.slice(0, limit);
  const sp = cut.lastIndexOf(" ");
  return (sp > limit * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

// The teaser for a row as stored: explicit summary wins, body excerpt fills in.
export const teaserFor = (row, limit = 200) =>
  (row && row.summary && row.summary.trim()) || excerpt(row ? row.body : "", limit);
