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
};
