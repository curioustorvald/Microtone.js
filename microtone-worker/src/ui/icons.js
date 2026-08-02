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
