// Theme system. ALL colours — DOM and canvas — live in css/microtone.css as
// custom properties under the two clearly-marked THEME blocks; edit them
// there. This module reads the variables once per theme switch into a cached
// object the canvas views use every frame (getComputedStyle is too slow for
// per-frame reads).

const VAR_KEYS = {
  // DOM palette (also used by canvas for text/accents)
  bg: "--bg", panel: "--panel", panel2: "--panel-2", fg: "--fg", fg2: "--fg2", dim: "--dim",
  accent: "--accent", accent2: "--accent-2", meter: "--meter",
  meterBg: "--meter-bg", border: "--border",
  // canvas: grids
  cvBg: "--cv-bg", rowBeat: "--cv-row-beat", rowBar: "--cv-row-bar",
  playhead: "--cv-playhead", cursor: "--cv-cursor", caret: "--cv-caret",
  caretNav: "--cv-caret-nav", cueLine: "--cv-cue-line", colPan: "--cv-col-pan",
  // canvas: samples / instruments
  wave: "--cv-wave", waveLoop: "--cv-wave-loop", playCursor: "--cv-play-cursor",
  envLine: "--cv-env-line", envNode: "--cv-env-node", envSus: "--cv-env-sus",
  envLoop: "--cv-env-loop", live: "--cv-live",
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
  return document.documentElement.dataset.theme ?? "dark";
}

export function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("microtone-theme", name); } catch { /* private mode */ }
  _cache = null;
  themeColors(); // re-read eagerly
  for (const fn of _listeners) fn(name);
}

export function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

/** Boot-time theme: saved choice, else the OS preference. */
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("microtone-theme"); } catch { /* private mode */ }
  const name = saved ??
    (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(name);
}
