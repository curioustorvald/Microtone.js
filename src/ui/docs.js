// Documentation viewer controller (docs.html) — item 30. A standalone page in
// the app's design language: a left TOC (document switcher + the current
// document's headings) and centred content (max-width 960px). Light/dark theme
// matches the main app (shared `microtone-theme` localStorage + data-theme).
//
// Two documents: a placeholder User Manual (real content deferred) and the Note
// Effects reference, rendered live from the repo's TAUD_NOTE_EFFECTS.md.

import { renderMarkdown, extractToc } from "./markdown.js";

// ── theme (mirror src/ui/theme.js, standalone) ──
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("microtone-theme", name); } catch { /* private mode */ }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("microtone-theme"); } catch { /* private mode */ }
  applyTheme(saved ??
    (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"));
}

const MANUAL = `# User Manual

> This manual is still being written. Until it lands, press **?** in the app for
> the keyboard reference, and see the **Note Effects** reference in the sidebar
> for the full effect-command specification.

## Overview

Microtone.js is a complete web build of the Microtone tracker — a ScreamTracker
3-lineage engine extended to 16-bit effect arguments and a 4096-tone
equal-temperament pitch grid. Everything runs in the browser; there is no
server and nothing is uploaded.

## Views

- **Timeline** — the whole song across every channel.
- **Cues** — the per-channel order list and its flow commands.
- **Patterns** — a single pattern editor with bulk transforms.
- **Samples / Instruments** — the sample pool and instrument bank.
- **Project / File** — song metadata, import/export and browser storage.

## Editing

Toggle record mode with **Insert**, enter notes with the piano row
(**A S D F G H J K**, black keys **W E T Y U**), and step values with the mouse
wheel over the cursor cell. Full details live under **?** in the app.

## Saving

**Ctrl+S** saves into the browser's private storage (OPFS); use the File tab to
export a \`.taud\` you can keep. Work autosaves periodically and offers recovery
on the next boot.
`;

const DOCS = [
  { id: "manual", title: "User Manual", load: async () => MANUAL },
  {
    id: "effects", title: "Note Effects",
    load: async () => {
      const resp = await fetch("TAUD_NOTE_EFFECTS.md");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.text();
    },
  },
];

const tocEl = document.getElementById("toc");
const contentEl = document.getElementById("content");
let currentId = null;

function docList(activeId) {
  const items = DOCS.map((d) =>
    `<button class="toc-doc${d.id === activeId ? " active" : ""}" data-doc="${d.id}">${d.title}</button>`).join("");
  return `<div class="toc-section">${items}</div>`;
}

async function selectDoc(id, anchor) {
  const doc = DOCS.find((d) => d.id === id) ?? DOCS[0];
  currentId = doc.id;
  contentEl.innerHTML = `<p class="docs-loading">Loading…</p>`;
  let md;
  try {
    md = await doc.load();
  } catch (err) {
    contentEl.innerHTML = `<p class="docs-error">Could not load this document (${err.message}).</p>`;
    tocEl.innerHTML = docList(doc.id);
    wireDocButtons();
    return;
  }
  contentEl.innerHTML = renderMarkdown(md);
  contentEl.scrollTop = 0;
  // TOC = document switcher + this document's h2/h3 headings
  const toc = extractToc(md);
  const links = toc.map((e) =>
    `<a class="toc-h${e.level}" href="#${e.slug}" data-slug="${e.slug}">${escapeText(e.text)}</a>`).join("");
  tocEl.innerHTML = docList(doc.id) +
    (links ? `<div class="toc-section toc-headings">${links}</div>` : "");
  wireDocButtons();
  for (const a of tocEl.querySelectorAll("a[data-slug]")) {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      scrollToSlug(a.dataset.slug);
      history.replaceState(null, "", `#${doc.id}/${a.dataset.slug}`);
    });
  }
  document.title = `Microtone.js — ${doc.title}`;
  if (anchor) scrollToSlug(anchor);
}

function scrollToSlug(s) {
  const el = document.getElementById(s);
  if (el) el.scrollIntoView({ block: "start" });
}

function wireDocButtons() {
  for (const b of tocEl.querySelectorAll(".toc-doc")) {
    b.addEventListener("click", () => {
      if (b.dataset.doc !== currentId) {
        history.replaceState(null, "", `#${b.dataset.doc}`);
        selectDoc(b.dataset.doc);
      }
    });
  }
}

function escapeText(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function fromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!h) return { id: "manual", anchor: null };
  const [id, anchor] = h.split("/");
  return DOCS.some((d) => d.id === id) ? { id, anchor } : { id: "manual", anchor: h };
}

// ── boot ──
initTheme();
document.getElementById("themeBtn").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
const start = fromHash();
selectDoc(start.id, start.anchor);
window.addEventListener("hashchange", () => {
  const { id, anchor } = fromHash();
  if (id !== currentId) selectDoc(id, anchor);
  else if (anchor) scrollToSlug(anchor);
});
