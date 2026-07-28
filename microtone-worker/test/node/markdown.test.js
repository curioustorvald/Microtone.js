// Item 30: the documentation viewer's Markdown renderer (src/ui/markdown.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderMarkdown, extractToc, slug } from "../../src/ui/markdown.js";

test("slug: stable, ascii-kebab, non-empty", () => {
  assert.equal(slug("0. Tracker terminologies"), "0-tracker-terminologies");
  assert.equal(slug("Effect **A** — Speed"), "effect-a-speed");
  assert.equal(slug("   "), "section");
});

test("headings carry slug ids", () => {
  const html = renderMarkdown("# Title\n\n## Section One\n\n### Sub");
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h2 id="section-one">Section One<\/h2>/);
  assert.match(html, /<h3 id="sub">Sub<\/h3>/);
});

test("fenced code is escaped and verbatim", () => {
  const html = renderMarkdown("```js\nconst a = b < c && d > e;\n```");
  assert.match(html, /<pre><code>const a = b &lt; c &amp;&amp; d &gt; e;<\/code><\/pre>/);
  // no inline formatting inside code
  assert.ok(!html.includes("<strong>"));
});

test("inline: bold / italic / code / link, HTML-escaped", () => {
  const html = renderMarkdown("A **bold** and *italic* and `x<y` and [ref](https://e.com).");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<a href="https:\/\/e\.com" target="_blank" rel="noopener">ref<\/a>/);
});

test("links: in-page anchors same-tab, external new-tab", () => {
  const html = renderMarkdown("See [effects](#effects) and [repo](https://e.com).");
  assert.match(html, /<a href="#effects">effects<\/a>/);
  assert.match(html, /<a href="https:\/\/e\.com" target="_blank" rel="noopener">repo<\/a>/);
});

test("GFM table renders thead/tbody with cells", () => {
  const md = "| Cmd | Meaning |\n| --- | --- |\n| A | Speed |\n| T | Tempo |";
  const html = renderMarkdown(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Cmd<\/th><th>Meaning<\/th>/);
  assert.match(html, /<td>A<\/td><td>Speed<\/td>/);
  assert.match(html, /<td>T<\/td><td>Tempo<\/td>/);
});

test("lists: unordered + one level of nesting", () => {
  const md = "- one\n- two\n  - two-a\n- three";
  const html = renderMarkdown(md);
  assert.match(html, /<ul><li>one<\/li>/);
  assert.match(html, /<li>two<ul><li>two-a<\/li><\/ul><\/li>/);
  assert.match(html, /<li>three<\/li><\/ul>/);
});

test("ordered list", () => {
  const html = renderMarkdown("1. first\n2. second");
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("horizontal rule + paragraph", () => {
  const html = renderMarkdown("para one\n\n---\n\npara two");
  assert.match(html, /<p>para one<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>para two<\/p>/);
});

test("renders the real TAUD_NOTE_EFFECTS.md without throwing + builds a TOC", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/TAUD_NOTE_EFFECTS.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.ok(html.length > 10000);
  assert.match(html, /<h1 id="taud-tracker-effect-command-reference">/);
  const toc = extractToc(md);
  assert.ok(toc.length > 10, "TOC has many entries");
  assert.ok(toc.every((e) => e.slug && e.text && (e.level === 2 || e.level === 3)));
  // slugs are unique enough to anchor (allow a few dupes but not mostly)
  assert.ok(new Set(toc.map((e) => e.slug)).size > toc.length * 0.8);
});

test("renders the real USER_MANUAL.md without throwing + builds a TOC", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/USER_MANUAL.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.match(html, /<h1 id="[^"]+">Microtone User Manual<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code>/);
  const toc = extractToc(md);
  assert.ok(toc.length > 20, "TOC has many entries");
  assert.ok(toc.every((e) => e.slug && e.text && (e.level === 2 || e.level === 3)));
  assert.equal(new Set(toc.map((e) => e.slug)).size, toc.length, "manual slugs unique");
});

// Item 95: the patch notes are a plain assets/*.md served by the same viewer.
// The invariants worth pinning are the ones a future append can break: every
// section is a bare ISO date, and the newest one comes first.
test("PATCH_NOTES.md: dated sections, newest first, renders + TOCs", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/PATCH_NOTES.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.match(html, /<h1 id="patch-notes">Patch Notes<\/h1>/);
  const toc = extractToc(md);
  assert.ok(toc.length > 5, "one TOC entry per dated section");
  assert.ok(toc.every((e) => e.level === 2 && /^\d{4}-\d{2}-\d{2}$/.test(e.text)),
    "every section heading is a bare ISO date");
  assert.equal(new Set(toc.map((e) => e.slug)).size, toc.length, "dates are unique");
  const dates = toc.map((e) => e.text);
  assert.deepEqual(dates, [...dates].sort().reverse(), "newest section first");
});
