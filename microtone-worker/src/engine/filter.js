// Per-voice filters + Taud voice FX — port of AudioAdapter.kt refreshVoiceFilter
// (2001), applyVoiceFilter (2071), applyTaudVoiceFx (2101), clipSample (2141).
//
// TWO topologies, both mandatory:
//  - IT/tracker path: all-pole 2-pole resonant LPF (reference_materials/
//    tracker_filter/) — NO feedforward terms; byte-faithful for tracker playback.
//  - filterSfMode path: FluidSynth's RBJ biquad (reference_materials/fluidsynth/)
//    with cents→Hz cutoff, −3.01 dB Butterworth Q offset and 1/√Q gain-norm.

import { SAMPLING_RATE } from "./constants.js";

/** Recompute filter coefficients when cutoff/resonance changed since last refresh. */
export function refreshVoiceFilter(voice) {
  const cut = voice.currentCutoff;
  const res = voice.currentResonance;
  if (cut === voice.filterCutoffCached && res === voice.filterResonanceCached) return;
  voice.filterCutoffCached = cut;
  voice.filterResonanceCached = res;

  const nyquist = SAMPLING_RATE * 0.5 - 1.0;
  if (voice.filterSfMode) {
    // SoundFont mode: cutoff = absolute cents, resonance = centibels above DC gain.
    if (cut >= 0xffff) { voice.filterActive = false; return; }
    const fres = Math.min(Math.max(8.176 * 2 ** (cut / 1200.0), 5.0), 0.45 * SAMPLING_RATE);

    // SF2 Q (cB) → linear, with FluidSynth's −3.01 dB offset (Q=0 cB ⇒ Butterworth).
    const qcb = res >= 0xffff ? 0 : res;
    const qDb = Math.min(Math.max(qcb / 10.0, 0.0), 96.0) - 3.01;
    const qLin = Math.max(10 ** (qDb / 20.0), 0.001);

    // RBJ cookbook low-pass, normalised to a0; SF2 §2.01 p.59 1/√Q gain-norm.
    const omega = (2.0 * Math.PI * fres) / SAMPLING_RATE;
    const sinC = Math.sin(omega);
    const cosC = Math.cos(omega);
    const alpha = sinC / (2.0 * qLin);
    const a0inv = 1.0 / (1.0 + alpha);
    const gain = a0inv / Math.sqrt(qLin);
    voice.filterBqB1 = (1.0 - cosC) * gain;
    voice.filterBqB02 = voice.filterBqB1 * 0.5;
    voice.filterBqA1 = -2.0 * cosC * a0inv;
    voice.filterBqA2 = (1.0 - alpha) * a0inv;
    voice.filterIsBiquad = true;
    voice.filterActive = true;
    return;
  }

  if (Math.min(Math.max(cut, 0), 255) >= 255) { voice.filterActive = false; return; }
  const itCutoff = Math.min(Math.max(cut, 0), 254) * 0.5; // 0..127
  const itResonance = res >= 255 ? 0.0 : Math.min(Math.max(res, 0), 254) * 0.5;
  const frequency = Math.min(110.0 * 2 ** (itCutoff / 24.0 + 0.25), nyquist);
  const dmpfac = 10 ** ((-itResonance * (24.0 / 128.0)) / 20.0);

  const r = SAMPLING_RATE / (2.0 * Math.PI * frequency);
  const d = dmpfac * r + dmpfac - 1.0;
  const e = r * r;
  const denom = 1.0 + d + e;

  voice.filterA0 = 1.0 / denom;
  voice.filterB0 = (d + e + e) / denom;
  voice.filterB1 = -e / denom;
  voice.filterIsBiquad = false;
  voice.filterActive = true;
}

/** Apply the cached voice low-pass to one mono sample. */
export function applyVoiceFilter(voice, x0) {
  if (!voice.filterActive) return x0;
  if (voice.filterIsBiquad) {
    // FluidSynth RBJ biquad, Direct Form I (unclamped — the SF2 gain-norm bounds it).
    const y0 = voice.filterBqB02 * (x0 + voice.filterX2) +
               voice.filterBqB1 * voice.filterX1 -
               voice.filterBqA1 * voice.filterY1 -
               voice.filterBqA2 * voice.filterY2;
    voice.filterX2 = voice.filterX1;
    voice.filterX1 = x0;
    voice.filterY2 = voice.filterY1;
    voice.filterY1 = y0;
    return y0;
  }
  // IT all-pole recurrence; history taps clipped ±2.0 (OpenMPT ClipFilter).
  const y1Clipped = Math.min(Math.max(voice.filterY1, -2.0), 2.0);
  const y2Clipped = Math.min(Math.max(voice.filterY2, -2.0), 2.0);
  const y0 = voice.filterA0 * x0 + voice.filterB0 * y1Clipped + voice.filterB1 * y2Clipped;
  voice.filterY2 = voice.filterY1;
  voice.filterY1 = y0;
  return y0;
}

/** Shared clipper for effects 8/9: 0 clamp, 1 fold (triangle), 2 wrap (sawtooth). */
export function clipSample(x, mode) {
  switch (mode & 3) {
    case 1: {
      let v = x;
      while (v > 1.0) v = 2.0 - v;
      while (v < -1.0) v = -2.0 - v;
      return v;
    }
    case 2: {
      let v = (x + 1.0) % 2.0;
      if (v < 0.0) v += 2.0;
      return v - 1.0;
    }
    default:
      return Math.min(Math.max(x, -1.0), 1.0);
  }
}

/** Overdrive (9) → shared clipper → bitcrusher (8): per output sample, per voice. */
export function applyTaudVoiceFx(voice, sample) {
  let s = sample;
  const overdriveOn = voice.overdriveAmp > 0;
  const depthQuantises = voice.bitcrusherDepth >= 1 && voice.bitcrusherDepth <= 7;
  const skipActive = voice.bitcrusherSkip > 0;
  const crushActive = depthQuantises || skipActive;

  if (overdriveOn) {
    s *= (16 + voice.overdriveAmp) / 16.0;
    s = clipSample(s, voice.clipMode);
  }

  if (crushActive) {
    if (voice.bitcrusherCounter === 0) {
      if (depthQuantises) {
        const levels = (1 << voice.bitcrusherDepth) - 1;
        const clipped = Math.min(Math.max(clipSample(s, voice.clipMode), -1.0), 1.0);
        const q = Math.min(Math.max(Math.floor((clipped + 1.0) * 0.5 * levels + 0.5), 0.0), levels);
        s = (q / levels) * 2.0 - 1.0;
      }
      voice.bitcrusherHeld = s;
    } else {
      s = voice.bitcrusherHeld;
    }
    if (skipActive) {
      voice.bitcrusherCounter = (voice.bitcrusherCounter + 1) % (voice.bitcrusherSkip + 1);
    } else {
      voice.bitcrusherCounter = 0;
    }
  }
  return s;
}
