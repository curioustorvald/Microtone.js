// Theme system. ALL colours — DOM and canvas — live in css/microtone.css as
// custom properties under the clearly-marked THEME blocks; edit them there.
// This module reads the variables once per theme switch into a cached object
// the canvas views use every frame (getComputedStyle is too slow for per-frame
// reads).
//
// THEMES is the cycle order of the ◐ button, ordered by ground lightness
// (dark → dim → light → dark), and is also the whitelist for the saved value
// and the ?theme= URL override. `dim` is the DEFAULT and a light-ink theme
// like `dark`, which is what isDarkTheme() answers for anything that shades
// against the ground.

export const THEMES = ["dark", "dim", "light"];
export const DEFAULT_THEME = "dim";

const VAR_KEYS = {
  // DOM palette (also used by canvas for text/accents)
  bg: "--bg", panel: "--panel", panel2: "--panel-2", fg: "--fg", fg2: "--fg2", dim: "--dim",
  accent: "--accent", accent2: "--accent-2", meter: "--meter",
  meterBg: "--meter-bg", border: "--border",
  // canvas: grids
  cvBg: "--cv-bg", rowBeat: "--cv-row-beat", rowBar: "--cv-row-bar",
  playhead: "--cv-playhead", cursor: "--cv-cursor", caret: "--cv-caret",
  caretNav: "--cv-caret-nav", cueLine: "--cv-cue-line", colPan: "--cv-col-pan",
  sel: "--cv-sel", ditto: "--cv-ditto",
  fxOp: "--cv-fx-op", fxA1: "--cv-fx-a1", fxA2: "--cv-fx-a2", fxA3: "--cv-fx-a3",
  // canvas: samples / instruments
  wave: "--cv-wave", waveLoop: "--cv-wave-loop", waveMid: "--cv-wave-mid",
  waveInvert: "--cv-wave-invert", waveFunk: "--cv-wave-funk",
  playCursor: "--cv-play-cursor",
  waveCursor: "--cv-wave-cursor",
  envLine: "--cv-env-line", envNode: "--cv-env-node", envSus: "--cv-env-sus",
  envLoop: "--cv-env-loop", live: "--cv-live",
  // canvas: sample-memory panel (item 166)
  poolUsed: "--cv-pool-used", poolShared: "--cv-pool-shared",
  poolFree: "--cv-pool-free", poolStale: "--cv-pool-stale",
};

let _cache = null;

/** Cached theme colours for canvas painting. Refreshed on applyTheme. */
export function themeColors() {
  if (_cache === null) {
    const css = getComputedStyle(document.documentElement);
    _cache = {};
    for (const [key, cssVar] of Object.entries(VAR_KEYS)) {
      _cache[key] = css.getPropertyValue(cssVar).trim();
    }
  }
  return _cache;
}

const _listeners = new Set();

/** Register a callback fired after every theme change (views redraw). */
export function onThemeChange(fn) { _listeners.add(fn); }

export function currentTheme() {
  const name = document.documentElement.dataset.theme;
  return THEMES.includes(name) ? name : "dark";
}

/** True for the light-ink themes (dark and dim) — see the header note. */
export function isDarkTheme() {
  return currentTheme() !== "light";
}

export function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("microtone-theme", name); } catch { /* private mode */ }
  _cache = null;
  themeColors(); // re-read eagerly
  // The address-bar tint follows the ground. The two <meta> tags are keyed to
  // the OS preference, which cannot express three themes — so both carry the
  // active background and whichever one matches is right.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = _cache.bg;
  }
  for (const fn of _listeners) fn(name);
}

/** Advance one step along THEMES (wraps). */
export function toggleTheme() {
  applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
}

/**
 * Boot-time theme: the saved choice, else DEFAULT_THEME. The OS preference is
 * deliberately not consulted — dim is the app's look, and every visitor should
 * see the same one until they pick otherwise (2026-08-03).
 */
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("microtone-theme"); } catch { /* private mode */ }
  applyTheme(THEMES.includes(saved) ? saved : DEFAULT_THEME);
}
