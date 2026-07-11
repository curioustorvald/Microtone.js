// Tiny i18n runtime. Each language is a flat key→string module in
// src/ui/lang/ (en.js is the reference list — copy it to <code>.js and
// translate the values to add a language, then register it in LANGS below).
// The chosen language persists in localStorage and applies on reload; en is
// statically imported as the always-available fallback.
//
// Usage: t("files.save")            → looked up in the active language
//        t("files.deleteAsk", {n})  → "{n}" placeholders substituted
// Static DOM (index.html) is translated by applyDom(): data-i18n sets
// textContent, data-i18n-title sets the title attribute.

import en from "./lang/en.js";

export const LANGS = {
  en: "English",
  ko: "한국어",
};

let active = en;
let activeCode = "en";

export function currentLang() { return activeCode; }

/** Load the saved language (default en). Call once before building UI. */
export async function initI18n() {
  let saved = null;
  try { saved = localStorage.getItem("microtone-lang"); } catch { /* private mode */ }
  if (saved && saved !== "en" && LANGS[saved]) {
    try {
      active = (await import(`./lang/${saved}.js`)).default;
      activeCode = saved;
    } catch (err) {
      console.warn(`i18n: can't load "${saved}" (${err.message}) — falling back to en`);
    }
  }
}

/** Persist a language choice. The caller reloads the page to apply it. */
export function setLang(code) {
  if (!LANGS[code]) return;
  try { localStorage.setItem("microtone-lang", code); } catch { /* private mode */ }
}

const langListeners = new Set();

/** Register a callback fired after a runtime language change (views re-render).
 *  Returns an unsubscribe function. */
export function onLangChange(fn) {
  langListeners.add(fn);
  return () => langListeners.delete(fn);
}

/** Swap the active language at runtime — no page reload (item 29). Re-applies
 *  the static DOM (data-i18n) and notifies listeners so dynamic views re-render.
 *  Resolves true on a real change. */
export async function changeLang(code) {
  if (!LANGS[code] || code === activeCode) return false;
  if (code === "en") { active = en; activeCode = "en"; }
  else {
    try {
      active = (await import(`./lang/${code}.js`)).default;
      activeCode = code;
    } catch (err) {
      console.warn(`i18n: can't load "${code}" (${err.message})`);
      return false;
    }
  }
  try { localStorage.setItem("microtone-lang", code); } catch { /* private mode */ }
  applyDom();
  for (const fn of langListeners) fn(code);
  return true;
}

/** Translate a key; "{name}" placeholders are substituted from params. */
export function t(key, params = null) {
  let s = active[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Apply data-i18n / data-i18n-title attributes below root. */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}
