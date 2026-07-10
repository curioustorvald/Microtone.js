// Canvas webfont plumbing. The tracker-grid typeface is the --cv-font custom
// property in css/microtone.css; the canvas views build their ctx.font
// through canvasFont() so ANY webfont declared there (Google @import,
// @font-face, FontFace API) works. One catch makes this module necessary:
// canvas fillText never TRIGGERS a webfont download — only DOM usage does —
// so an undownloaded face silently renders as the fallback forever.
// loadCanvasFonts() force-loads the stack through the CSS Font Loading API
// and fires a repaint callback once the real faces are in.

const FALLBACK = 'ui-monospace, "Cascadia Mono", "DejaVu Sans Mono", monospace';

let _family = null;

/** The --cv-font family stack (cached — getComputedStyle is too slow for
 *  per-frame reads; see refreshCanvasFont). */
export function canvasFontFamily() {
  if (_family === null) {
    _family = getComputedStyle(document.documentElement)
      .getPropertyValue("--cv-font").trim() || FALLBACK;
  }
  return _family;
}

/** ctx.font string for the tracker grid at `px`. */
export function canvasFont(px) {
  return `${px}px ${canvasFontFamily()}`;
}

/** Drop the cached family — call when --cv-font may have changed (theme
 *  switch, live experimentation from the console). */
export function refreshCanvasFont() {
  _family = null;
}

/**
 * Force-load the webfont faces the canvas views use (one load per size the
 * views draw at), then fire onReady so they repaint with the real font —
 * paints before this resolves may show the fallback stack.
 */
export async function loadCanvasFonts(sizes, onReady) {
  try {
    await Promise.all(sizes.map((px) => document.fonts.load(canvasFont(px))));
    await document.fonts.ready;
  } catch { /* no Font Loading API / blocked fetch — the fallback stack stands */ }
  onReady?.();
}
