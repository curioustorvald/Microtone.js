// Vector icons for the icon-cell context menu (widgets/contextmenu.js).
//
// Plain inline SVG markup on a 24×24 grid, stroked in `currentColor` so the
// theme's ink and the hover/disabled states apply without a second palette —
// the same reason the canvas views read their colours from theme.js. Keep the
// stroke width at 1.6 and the geometry inside 2…22 so cells look even.

const SVG = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// Channel strips as vertical bars: the existing channels FILLED, the slot being
// made a dashed outline with a plus in it. Filling the solid pair is what keeps
// the two apart at 30 px — stroked-only bars this narrow are almost all stroke
// and the three read as one barcode.
const bar = (x) => `<rect x="${x}" y="4" width="4" height="16" rx="1" ` +
                   `fill="currentColor" stroke="none"/>`;
const ghostAt = (x) =>
  `<rect x="${x}" y="4" width="9" height="16" rx="1.5" stroke-dasharray="3 2.4"/>` +
  `<path d="M${x + 4.5} 9.5v5M${x + 2} 12h5"/>`;
// A bar-width EMPTY slot — the place a moved pattern lands. Same footprint as
// bar(), dashed instead of filled, so the pair reads as "this goes there".
const slot = (x) => `<rect x="${x}" y="4" width="4" height="16" rx="1" ` +
                    `stroke-dasharray="3 2.4"/>`;
// A speaker cone, for the mute pair. Left-facing wave/cross drawn separately.
const speaker = '<path d="M2.5 9.5H6l5-4v13l-5-4H2.5z"/>';

export const ICON = {
  /** Insert a channel to the LEFT of this one. */
  channelLeft: SVG(ghostAt(1.5) + bar(13) + bar(19)),
  /** Insert a channel to the RIGHT of this one. */
  channelRight: SVG(bar(1) + bar(7) + ghostAt(13.5)),
  /** Create a new pattern for an empty cue slot: a pattern column + a plus. */
  patternNew: SVG(
    '<rect x="2.5" y="2.5" width="12" height="19" rx="1.5"/>' +
    '<path d="M5.5 7.5h6M5.5 12h6M5.5 16.5h3.5"/>' +
    '<path d="M18.5 13v7.5M14.75 16.75h7.5"/>'),
  /** Move this slot's pattern one channel LEFT, into the empty slot there. */
  moveLeft: SVG(slot(2) + '<path d="M15.5 12h-7M11 9.5 8.5 12l2.5 2.5"/>' + bar(18)),
  /** Move this slot's pattern one channel RIGHT. */
  moveRight: SVG(bar(2) + '<path d="M8.5 12h7M13 9.5l2.5 2.5-2.5 2.5"/>' + slot(18)),
  /** Duplicate: a second pattern card in front of the one it was copied from. */
  duplicate: SVG(
    '<rect x="8.5" y="5.5" width="13" height="16" rx="1.5"/>' +
    '<path d="M11.5 10h7M11.5 13.5h7M11.5 17h4"/>' +
    '<path d="M15.5 2.5H4.5a2 2 0 0 0-2 2v11"/>'),

  // ── the channel header's mute row ──
  /** Solo: headphones — listen to this channel on its own. Not another bar
   *  triple: the channel inserts already own that shape, and the two rows are
   *  on screen together. */
  solo: SVG(
    '<path d="M3.5 16.5V12a8.5 8.5 0 0 1 17 0v4.5"/>' +
    '<rect x="1.5" y="14" width="5" height="7.5" rx="2.2" fill="currentColor" stroke="none"/>' +
    '<rect x="17.5" y="14" width="5" height="7.5" rx="2.2" fill="currentColor" stroke="none"/>'),
  /** Mute this channel: speaker with a cross. */
  mute: SVG(speaker + '<path d="M15 9.5 20.5 15M20.5 9.5 15 15"/>'),
  /** Unmute this channel: speaker with its waves back. */
  unmute: SVG(speaker +
    '<path d="M14.5 9.4a4.2 4.2 0 0 1 0 5.2M17.6 7a8 8 0 0 1 0 10"/>'),
  /** Unmute everything: every channel standing again. */
  unmuteAll: SVG(bar(2) + bar(10) + bar(18)),

  /** Copy the block selection: the usual two stacked sheets. */
  copy: SVG(
    '<rect x="8.5" y="2.5" width="13" height="15" rx="2"/>' +
    '<path d="M15 21.5H4.5a2 2 0 0 1-2-2V6.5"/>'),
  /** Cut the block selection: scissors. */
  cut: SVG(
    '<circle cx="6" cy="18.5" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/>' +
    '<path d="M7.9 16.7 18.5 2.5M16.1 16.7 5.5 2.5"/>'),
  /** Paste the clipboard: a clipboard board with its clip. */
  paste: SVG(
    '<rect x="3.5" y="4.5" width="17" height="17" rx="2"/>' +
    '<path d="M7.5 11h9M7.5 15.5h6"/>' +
    '<rect x="8" y="1.8" width="8" height="4.4" rx="1.3" fill="currentColor" stroke="none"/>'),

  // ── the second row's column tools ──
  /** Transpose: a note head with an up/down arrow beside it. */
  transpose: SVG(
    '<ellipse cx="7.5" cy="17" rx="4" ry="3.2" transform="rotate(-20 7.5 17)" ' +
    'fill="currentColor" stroke="none"/>' +
    '<path d="M11.2 15.8V3.5"/>' +
    '<path d="M18 3.5v17M14.75 6.75 18 3.5l3.25 3.25M14.75 17.25 18 20.5l3.25-3.25"/>'),
  /** Change instrument: two number plates, one becoming the other. */
  instrument: SVG(
    '<rect x="1.5" y="6" width="8.5" height="12" rx="1.5"/>' +
    '<rect x="14" y="6" width="8.5" height="12" rx="1.5" stroke-dasharray="3 2.4"/>' +
    '<path d="M10.75 12h2.5"/>'),
  /** Volume tool: a fader ramp. */
  volume: SVG(
    '<path d="M2.5 20.5 20.5 4.5v16z" />' +
    '<path d="M8.5 20.5v-5.3M14.5 20.5v-10.6"/>'),
  /** Panning tool: a left/right balance arc. */
  pan: SVG(
    '<path d="M2.5 17a9.5 9.5 0 0 1 19 0"/>' +
    '<path d="M12 17V8"/>' +
    '<circle cx="12" cy="19.5" r="1.8" fill="currentColor" stroke="none"/>' +
    '<path d="M2.5 20.5h3M18.5 20.5h3"/>'),
  /** Panner: the surround dial seen from above — listener at the centre, front
   *  tick at the top, a source placed off to one side. */
  panner: SVG(
    '<circle cx="12" cy="12" r="9.5"/>' +
    '<path d="M12 1.2v3.4"/>' +
    '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>' +
    '<path d="M12 12 17.6 7.4"/>' +
    '<circle cx="18" cy="7" r="2.4" fill="currentColor" stroke="none"/>'),
};

// ── button icons (item 107) ───────────────────────────────────────────────
// The transport and tool buttons used to be Unicode symbols — ▶ ■ ⏺ ↶ ↷ ↻ ◐ ⬇
// ↗ ♥ ⇤ ⇥ — with a VS15 selector begging for text presentation. Several of
// them are simply absent from the default fonts on some phones and tablets, so
// the button read as a tofu box (and where they DID resolve, the emoji
// fallback painted them in a font of its own choosing). These are the same
// shapes as vectors: same 24×24 grid as the menu icons above, drawn at 1em
// beside the label (`.btn-ico` in the stylesheet).
const solid = (body) =>
  `<svg viewBox="0 0 24 24" class="btn-ico" fill="currentColor" aria-hidden="true">${body}</svg>`;
const line = (body) =>
  `<svg viewBox="0 0 24 24" class="btn-ico" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const BTN_ICON = {
  /** Play (▶). */
  play: solid('<path d="M7.5 4.8 19 12 7.5 19.2z"/>'),
  /** Stop (■). */
  stop: solid('<rect x="6" y="6" width="12" height="12" rx="1.4"/>'),
  /** Record / arm (⏺ ●). */
  record: solid('<circle cx="12" cy="12" r="6"/>'),
  /** Undo (↶) — the arrow turns back on itself, anticlockwise. */
  undo: line('<path d="M9.5 8.5H14a4.75 4.75 0 0 1 0 9.5H7.5"/><path d="M12 5 8.5 8.5 12 12"/>'),
  /** Redo (↷). */
  redo: line('<path d="M14.5 8.5H10a4.75 4.75 0 0 0 0 9.5h6.5"/><path d="M12 5l3.5 3.5L12 12"/>'),
  /** Reload the app (↻). */
  reload: line('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 3.5v4.2h-4.2"/>'),
  /** Cycle the theme (◐) — a disc lit on one side. */
  theme: line('<circle cx="12" cy="12" r="8"/>' +
    '<path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>'),
  /** Export / download (⬇). */
  download: line('<path d="M12 4v10"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M4.5 19.5h15"/>'),
  /** Opens in a new tab (↗). */
  external: line('<path d="M13.5 4.5H19.5V10.5"/><path d="M19.5 4.5 11 13"/>' +
    '<path d="M16.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V9a1.5 1.5 0 0 1 1.5-1.5H10"/>'),
  /** Step to the previous / next pattern (◀ ▶). */
  prev: solid('<path d="M16 4.8 4.5 12 16 19.2z"/>'),
  next: solid('<path d="M8 4.8 19.5 12 8 19.2z"/>'),
  /** Jump to the previous / next cue (|◀ ▶|). */
  prevCue: solid('<path d="M18 4.8 8 12 18 19.2z"/><rect x="5" y="4.8" width="2.4" height="14.4" rx="0.8"/>'),
  nextCue: solid('<path d="M6 4.8 16 12 6 19.2z"/><rect x="16.6" y="4.8" width="2.4" height="14.4" rx="0.8"/>'),
  /** Rename this file (✎) — a pencil over a line. */
  rename: line('<path d="M4.5 19.5h15"/>' +
    '<path d="M5.5 15.6 15.9 5.2a2 2 0 0 1 2.9 0 2 2 0 0 1 0 2.9L8.4 18.5H5.5z"/>'),
  /** Fold a panel open/shut (▾). */
  caretDown: solid('<path d="M6 9h12l-6 7z"/>'),
  /** Becomes this (→) — the mono/stereo conversions. */
  arrowRight: line('<path d="M4 12h15"/><path d="M13.5 6.5 19 12l-5.5 5.5"/>'),
  /** A plain filled disc — the status bar's "unsaved changes" marker (●). */
  dot: solid('<circle cx="12" cy="12" r="5"/>'),
  /** Delete this file (✕). */
  close: line('<path d="M6 6l12 12M18 6 6 18"/>'),
  /** Support the project (♥). */
  heart: solid('<path d="M12 20.6 4.9 13.4a4.4 4.4 0 0 1 0-6.3 4.6 4.6 0 0 1 6.4 0l.7.7.7-.7a4.6 4.6 0 0 1 6.4 0 4.4 4.4 0 0 1 0 6.3z"/>'),
};

/** The `<svg>` markup for a button icon — for the HTML-template popups.
 *  `after` is the trailing-icon variant (the download and new-tab arrows). */
export function icon(name, after = false) {
  const svg = BTN_ICON[name] ?? "";
  return after ? svg.replace('class="btn-ico"', 'class="btn-ico after"') : svg;
}

/** …and the same thing as an element, for the DOM-building callers. */
function iconEl(name, after = false) {
  const holder = document.createElement("span");
  holder.innerHTML = icon(name); // our own markup, never user data
  const svg = holder.firstElementChild;
  if (svg && after) svg.classList.add("after");
  return svg;
}

/**
 * Give `el` an icon and `text`. Used wherever a label is assigned at runtime
 * (the `btn.textContent = t(…)` sites), so a button whose label toggles
 * play↔stop can be re-labelled as often as it likes. `after` puts the icon at
 * the END, which is where the download and new-tab arrows read best.
 */
export function setIconLabel(el, name, text = "", { after = false } = {}) {
  const svg = iconEl(name, after);
  const parts = text ? [text] : [];
  if (svg) parts[after ? "push" : "unshift"](svg);
  el.replaceChildren(...parts);
}

/**
 * Mount `data-icon="name"` icons below `root`, beside whatever text is already
 * there (`data-icon-after` puts it on the far side). i18n.applyDom() calls this
 * after every pass because setting textContent wipes the icon element — which
 * is also why it has to be safe to call twice (an element that still has its
 * icon is left alone).
 */
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    const has = el.firstElementChild?.classList.contains("btn-ico") ||
                el.lastElementChild?.classList.contains("btn-ico");
    if (has) continue;
    const after = el.hasAttribute("data-icon-after");
    const svg = iconEl(el.dataset.icon, after);
    if (svg) el[after ? "append" : "prepend"](svg);
  }
}

/**
 * An effect cell's "icon" is its own base-36 opcode letter — the thing you
 * would type, and the thing the grid prints. Drawn as SVG text rather than a
 * styled span so it sits on the same 30 px baseline as the real glyphs and
 * inherits the cell's colour the same way.
 */
export function fxGlyph(letter) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="12" ` +
    `text-anchor="middle" dominant-baseline="central" font-size="19" ` +
    `font-weight="600" fill="currentColor">${letter}</text></svg>`;
}
