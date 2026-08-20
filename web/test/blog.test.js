// Site-update posts: the markdown-lite renderer (which is a security boundary,
// so most of this file is about what it REFUSES to emit), the slug rules, and
// the data layer's draft/publish semantics.
//
// The HTTP layer on top is a thin projection of these two, and gets one
// end-to-end pass at the bottom covering the public list, one post, the RSS
// feed and the sitemap.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { openDatabase } from "../db.js";
import { createTestDb, ADMIN_URL } from "./pg-util.js";
import {
  renderBody,
  slugify,
  isValidSlug,
  excerpt,
  teaserFor,
  sanitizeText,
  isBlogTag,
  blogTagLabel,
} from "../blog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

/* ----------------------------- the renderer ------------------------------ */

// The renderer's whole contract in one place: whatever the author types, the
// only TAGS in the output are the ones renderBody() writes itself, with only
// the attributes it writes. Asserting on the emitted tags (rather than grepping
// the text for "<script" or "onerror=") is the difference that matters: an
// escaped "&lt;img ... onerror=...&gt;" is inert TEXT and must be allowed to
// appear, while a real <img> must not, and a substring search cannot tell the
// two apart.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "em", "code", "pre", "a",
  "ul", "ol", "li", "blockquote", "h3", "h4", "h5",
]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel"]);

function assertOnlyOurMarkup(html, source) {
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, tag, attrs] = m;
    assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `emitted <${tag}> from: ${source}`);
    for (const a of attrs.matchAll(/([a-zA-Z:-]+)\s*=/g)) {
      assert.ok(
        ALLOWED_ATTRS.has(a[1].toLowerCase()),
        `emitted attribute ${a[1]} on <${tag}> from: ${source}`
      );
    }
  }
  // No href may carry an executable scheme.
  for (const h of html.matchAll(/href="([^"]*)"/g)) {
    assert.ok(
      /^(?:https?:\/\/|mailto:|\/)/i.test(h[1]),
      `unsafe href ${h[1]} from: ${source}`
    );
  }
}

test("renderer never emits author-supplied markup", () => {
  // Each of these is a real injection shape: a raw tag, a tag smuggled through
  // link text, an executable URL scheme, and an attempt to break out of the
  // href attribute we build.
  const attacks = [
    `<script>alert(1)</script>`,
    `<img src=x onerror=alert(1)>`,
    `<iframe src="https://evil.example"></iframe>`,
    `<a href="https://evil.example">hi</a>`,
    `[click](javascript:alert(1))`,
    `[click](JaVaScRiPt:alert(1))`,
    `[click](data:text/html,<script>alert(1)</script>)`,
    `[<img src=x onerror=alert(1)>](https://ok.example)`,
    `[x]("onmouseover="alert(1))`,
    `[x](https://ok.example" onmouseover="alert(1))`,
    `> <script>alert(1)</script>`,
    `- <script>alert(1)</script>`,
    `## <script>alert(1)</script>`,
    "`<script>alert(1)</script>`",
    "```\n<script>alert(1)</script>\n```",
    `**<script>alert(1)</script>**`,
  ];
  for (const a of attacks) assertOnlyOurMarkup(renderBody(a), a);

  // And the author's own angle brackets survive as visible, inert text.
  assert.match(renderBody(`<script>alert(1)</script>`), /&lt;script&gt;/);
});

test("renderer keeps its own markup vocabulary", () => {
  assert.equal(renderBody("## Heading"), "<h3>Heading</h3>");
  assert.equal(renderBody("### Sub"), "<h4>Sub</h4>");
  assert.equal(renderBody("hello **bold** here"), "<p>hello <strong>bold</strong> here</p>");
  assert.equal(renderBody("hello *it* here"), "<p>hello <em>it</em> here</p>");
  assert.equal(renderBody("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderBody("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderBody("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(renderBody("---"), "<hr>");
  // Hard-wrapped lines inside one paragraph become <br>, not separate <p>s.
  assert.equal(renderBody("one\ntwo"), "<p>one<br>two</p>");
  // Blank line separates blocks.
  assert.equal(renderBody("one\n\ntwo"), "<p>one</p>\n<p>two</p>");
});

test("emphasis leaves map-name globs and arithmetic alone", () => {
  // The reason this rule is strict: race posts are full of map globs, and an
  // eager "any two asterisks" rule rendered "bug*, dm_*" as "bug<em>, dm_</em>".
  for (const plain of [
    "covering bug*, dm_*, kairos-* and gvn-zapadlo",
    "2 * 3 * 4 = 24",
    "a * b * c",
    "map dm_14 and bug58_xs-wjfix",
  ]) {
    assert.equal(renderBody(plain), `<p>${plain}</p>`, plain);
  }
  // ...while real emphasis still works, including at the start of a line.
  assert.equal(renderBody("*lead* and *x*"), "<p><em>lead</em> and <em>x</em></p>");
  assert.equal(renderBody("**b** and *i*"), "<p><strong>b</strong> and <em>i</em></p>");
});

test("teaser drops list markers rather than inlining them", () => {
  // The markers must be stripped per line, BEFORE the lines are joined - once
  // joined, a /^/m anchor no longer sees them and every bullet leaks in as "- ".
  const t = excerpt("Intro line.\n\n- 331 packs\n- every map is new\n\nMore prose.", 200);
  assert.ok(!t.includes("- "), t);
  assert.equal(t, "Intro line. 331 packs every map is new More prose.");
});

test("links: safe schemes only, and off-site links are marked", () => {
  const ext = renderBody("[site](https://example.com/a)");
  assert.match(ext, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener nofollow">site<\/a>/);

  // Site-relative links stay in the SPA (no target/rel), so the router handles them.
  const rel = renderBody("[maps](/maps)");
  assert.match(rel, /<a href="\/maps">maps<\/a>/);
  assert.ok(!/target=/.test(rel));

  // An "&" in a query string must survive as a proper entity in the href.
  assert.match(renderBody("[q](/maps?a=1&b=2)"), /href="\/maps\?a=1&amp;b=2"/);

  // A rejected scheme degrades to the link TEXT rather than vanishing.
  assert.match(renderBody("[label](data:text/html,x)"), /<p>label<\/p>/);
});

test("code spans and fences are literal", () => {
  assert.equal(renderBody("use `a *b* c`"), "<p>use <code>a *b* c</code></p>");
  assert.equal(renderBody("```\n<b>x</b> *y*\n```"), "<pre><code>&lt;b&gt;x&lt;/b&gt; *y*</code></pre>");
  // An unterminated fence still renders its contents rather than dropping them.
  assert.match(renderBody("```\nlost tail"), /<pre><code>lost tail<\/code><\/pre>/);
});

test("sanitizeText strips control bytes and normalises newlines", () => {
  assert.equal(sanitizeText("a\r\nb\rc"), "a\nb\nc");
  const ctrl = String.fromCharCode(0) + String.fromCharCode(7);
  assert.equal(sanitizeText("a" + ctrl + "b"), "ab");
  assert.equal(sanitizeText("keep\ttab\nand newline"), "keep\ttab\nand newline");
  assert.equal(sanitizeText("truncate me", 8), "truncate");
});

/* -------------------------------- slugs ---------------------------------- */

test("slugify produces stable, round-trippable slugs", () => {
  assert.equal(slugify("373 New Maps!"), "373-new-maps");
  assert.equal(slugify("  Spaces   everywhere  "), "spaces-everywhere");
  assert.equal(slugify("Café Ünïcode — tëst"), "cafe-unicode-test");
  assert.equal(slugify("!!! ???"), "");
  // A slug is valid exactly when slugify() leaves it alone.
  assert.ok(isValidSlug("373-new-maps"));
  assert.ok(!isValidSlug("373 New Maps"));
  assert.ok(!isValidSlug("-leading"));
  assert.ok(!isValidSlug(""));
  // Truncation must not leave a trailing separator (which would be invalid).
  const long = slugify("word ".repeat(40));
  assert.ok(isValidSlug(long), long);
  assert.ok(!long.endsWith("-"));
});

/* ------------------------------- teasers --------------------------------- */

test("excerpt strips markup and cuts on a word boundary", () => {
  const e = excerpt("## Title\n\n- **bold** item\n- second\n\nSome prose here", 200);
  assert.ok(!/[*#\-]/.test(e.replace(/[^*#]/g, "")), e);
  assert.match(e, /bold item/);
  assert.ok(!e.startsWith("Title"), "headings are dropped");

  const cut = excerpt("aaa bbb ccc ddd eee fff ggg hhh", 12);
  assert.ok(cut.endsWith("…"), cut);
  assert.ok(cut.length <= 14, cut);
  assert.ok(!/\s…$/.test(cut), "no dangling space before the ellipsis");

  // Fenced code is not teaser material.
  assert.ok(!excerpt("```\nsecret code\n```\n\nreal text").includes("secret code"));
});

test("teaserFor prefers an explicit summary", () => {
  assert.equal(teaserFor({ summary: "Explicit.", body: "Body text." }), "Explicit.");
  assert.equal(teaserFor({ summary: "   ", body: "Body text." }), "Body text.");
});

test("tags fall back to a known label", () => {
  assert.ok(isBlogTag("maps"));
  assert.ok(!isBlogTag("nonsense"));
  assert.equal(blogTagLabel("maps"), "New maps");
  assert.equal(blogTagLabel("nonsense"), "Update");
});

/* ----------------------------- the data layer ---------------------------- */

test("drafts are invisible to every public read", async (t) => {
  const race = await freshDb(t);
  const pub = await race.blogCreate({ slug: "published", title: "Published", body: "x", publishedAt: 1000 });
  await race.blogCreate({ slug: "draft", title: "Draft", body: "x", publishedAt: null });
  assert.ok(pub);

  const list = await race.blogList({});
  assert.deepEqual(list.rows.map((r) => r.slug), ["published"]);
  assert.equal(list.total, 1);

  assert.equal(await race.blogBySlug("draft"), null);
  assert.ok(await race.blogBySlug("draft", { drafts: true }));
  assert.deepEqual((await race.blogSitemap()).map((r) => r.slug), ["published"]);

  // The admin view sees both, with the draft sorted to the top (no date yet).
  const all = await race.blogList({ drafts: true });
  assert.deepEqual(all.rows.map((r) => r.slug), ["draft", "published"]);
});

test("list is newest-first and paginates", async (t) => {
  const race = await freshDb(t);
  for (let i = 1; i <= 5; i++) {
    await race.blogCreate({ slug: `p${i}`, title: `Post ${i}`, body: "b", publishedAt: 1000 + i });
  }
  const page1 = await race.blogList({ limit: 2 });
  assert.deepEqual(page1.rows.map((r) => r.slug), ["p5", "p4"]);
  assert.equal(page1.total, 5);

  const page2 = await race.blogList({ limit: 2, offset: 2 });
  assert.deepEqual(page2.rows.map((r) => r.slug), ["p3", "p2"]);

  // limit is clamped, not trusted.
  assert.equal((await race.blogList({ limit: 9999 })).limit, 50);
  assert.equal((await race.blogList({ limit: 0 })).limit, 10);
  assert.equal((await race.blogList({ offset: -5 })).offset, 0);
});

test("a duplicate slug is refused, not thrown", async (t) => {
  const race = await freshDb(t);
  assert.ok(await race.blogCreate({ slug: "dup", title: "First", body: "" }));
  assert.equal(await race.blogCreate({ slug: "dup", title: "Second", body: "" }), null);
  // The original is untouched.
  assert.equal((await race.blogBySlug("dup", { drafts: true })).title, "First");
});

test("neighbours walk publish order and skip drafts", async (t) => {
  const race = await freshDb(t);
  const ids = {};
  for (const [slug, at] of [["a", 100], ["b", 200], ["c", 300]]) {
    ids[slug] = await race.blogCreate({ slug, title: slug, body: "", publishedAt: at });
  }
  await race.blogCreate({ slug: "d", title: "d", body: "", publishedAt: null });

  const mid = await race.blogNeighbours(200, ids.b);
  assert.equal(mid.prev.slug, "a");
  assert.equal(mid.next.slug, "c");

  const newest = await race.blogNeighbours(300, ids.c);
  assert.equal(newest.prev.slug, "b");
  assert.equal(newest.next, null, "the newest post has no next, draft or not");

  const oldest = await race.blogNeighbours(100, ids.a);
  assert.equal(oldest.prev, null);
});

test("update edits content and can unpublish; the slug never moves", async (t) => {
  const race = await freshDb(t);
  const id = await race.blogCreate({ slug: "keep", title: "Old", body: "old", tag: "update", publishedAt: 500 });
  await race.blogUpdate(id, { title: "New", summary: "s", body: "new", tag: "maps", publishedAt: 600 });
  const post = await race.blogById(id);
  assert.equal(post.slug, "keep");
  assert.equal(post.title, "New");
  assert.equal(post.tag, "maps");
  assert.equal(post.publishedAt, 600);
  assert.ok(post.updatedAt >= 0);

  await race.blogUpdate(id, { title: "New", summary: "s", body: "new", tag: "maps", publishedAt: null });
  assert.equal(await race.blogBySlug("keep"), null, "unpublished => gone from public reads");
});

test("blogById tolerates a non-id and delete removes the row", async (t) => {
  const race = await freshDb(t);
  assert.equal(await race.blogById(null), null);
  const id = await race.blogCreate({ slug: "gone", title: "Gone", body: "" });
  await race.blogDelete(id);
  assert.equal(await race.blogById(id), null);
});

/* --------------------------- end to end over HTTP ------------------------- */

let proc;
let dbName;
let base;

before(async () => {
  dbName = "test_blog_" + crypto.randomBytes(6).toString("hex");
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();

  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`),
      INGEST_TOKEN: "blog-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.end();
});

test("HTTP: list, post, feed and sitemap agree, and drafts appear in none", async () => {
  const race = await openDatabase(ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`));
  try {
    await race.blogCreate({
      slug: "373-new-maps",
      title: "373 new maps",
      body: "We added **373** maps.\n\n- one\n- two",
      tag: "maps",
      publishedAt: 1_700_000_000,
      author: "elchupa",
    });
    await race.blogCreate({ slug: "secret-draft", title: "Secret", body: "nope", publishedAt: null });
  } finally {
    await race.close();
  }

  const list = await (await fetch(`${base}/api/blog`)).json();
  assert.equal(list.total, 1);
  assert.equal(list.posts[0].slug, "373-new-maps");
  assert.equal(list.posts[0].tagLabel, "New maps");
  // The list carries a teaser, never the body: it is an index, not the content.
  assert.ok(list.posts[0].teaser.includes("373"));
  assert.equal(list.posts[0].body, undefined);

  const one = await (await fetch(`${base}/api/blog/373-new-maps`)).json();
  assert.match(one.html, /<strong>373<\/strong>/);
  assert.match(one.html, /<ul><li>one<\/li>/);
  assert.equal(one.prev, null);
  assert.equal(one.next, null);

  assert.equal((await fetch(`${base}/api/blog/secret-draft`)).status, 404);
  assert.equal((await fetch(`${base}/api/blog/nope-not-real`)).status, 404);

  const feedRes = await fetch(`${base}/blog.xml`);
  assert.equal(feedRes.status, 200);
  assert.match(feedRes.headers.get("content-type") || "", /xml/);
  const feed = await feedRes.text();
  assert.match(feed, /<title>373 new maps<\/title>/);
  assert.match(feed, /<link>http:\/\/[^<]*\/blog\/373-new-maps<\/link>/);
  assert.ok(!feed.includes("Secret"), "a draft must not reach the feed");

  const sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
  assert.ok(sitemap.includes("/blog/373-new-maps"), "published post is in the sitemap");
  assert.ok(sitemap.includes("/blog<") || sitemap.includes("/blog</loc>"), "the index page is listed");
  assert.ok(!sitemap.includes("secret-draft"));

  // The shared-link shell carries the post's own OG tags, not the site default.
  const shell = await (await fetch(`${base}/blog/373-new-maps`)).text();
  assert.match(shell, /og:title" content="373 new maps — Racesow"/);
  assert.match(shell, /rel="canonical" href="[^"]*\/blog\/373-new-maps"/);

  // An unknown post falls through to the plain SPA shell (the client renders
  // the "doesn't exist" view), NOT to a post shell with empty tags.
  const missing = await fetch(`${base}/blog/nope-not-real`);
  assert.equal(missing.status, 200);
  assert.ok(!(await missing.text()).includes("og:type\" content=\"article\""));
});
