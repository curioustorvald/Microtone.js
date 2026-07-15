// Shared numeric-field annotations for the instrument editors — the basic
// General tab (views/instruments.js) and the Advanced Edit 'x' block
// (views/instadvanced.js) present the same fadeout / filter fields, so the
// unit translations live here to stay identical. Filter units follow the
// engine (AudioAdapter.refreshVoiceFilter).

import { t } from "./i18n.js";

export const annHex2 = (v) => "$" + (v & 0xff).toString(16).toUpperCase().padStart(2, "0");

/** ImpulseTracker filter byte: 0xFF = off (unfiltered), else the raw hex value. */
export const annFilter = (v) => (v === 0xff ? t("inst.annOff") : annHex2(v));

/** Volume Fadeout step → ticks-to-silence (0 = none, ≥1024 = instant cut). */
export function annFadeout(v) {
  if (v <= 0) return t("inst.annNone");
  if (v >= 1024) return t("inst.annCut");
  return t("inst.annTicks", { n: Math.round(1024 / v) });
}

// SoundFont filter units (AudioAdapter.refreshVoiceFilter): cutoff = absolute
// cents → Hz (8.176·2^(cents/1200)); resonance = centibels above DC → dB. The
// cents/cB are clamped to the SF2-spec range for display — a value carried over
// from a toggled ImpulseTracker instrument can sit far outside it (the engine
// clamps too), and the raw Hz/dB would otherwise read as an absurd number.
export function annSfCutoff(v) {
  if (v >= 0xffff) return t("inst.annOff");
  const hz = 8.176 * Math.pow(2, Math.min(Math.max(v, 1500), 13500) / 1200);
  if (hz >= 10000) return Math.round(hz / 1000) + " kHz";
  if (hz >= 1000) return (hz / 1000).toFixed(2) + " kHz";
  return Math.round(hz) + " Hz";
}
export function annSfReso(v) {
  if (v >= 0xffff) return t("inst.annFlat");
  return (Math.min(v, 960) / 10).toFixed(1) + " dB";
}
