// Length-preserving DSP over U8 PCM sample spans (centre 0x80) — the sample
// editor's operation set. Pure functions: take a Uint8Array view, return a
// NEW Uint8Array of the same length (callers apply via setSampleBytesOp so
// the edit is one invertible undo step). Everything here is length-preserving;
// length changes belong to sample-IMPORT time (a future endeavour), never to
// the in-place editor — they'd ripple every pool pointer.

/** Peak-normalise to full scale (max deviation from centre → 127). */
export function normalise(bytes) {
  let maxDev = 0;
  for (let i = 0; i < bytes.length; i++) {
    const d = Math.abs(bytes[i] - 128);
    if (d > maxDev) maxDev = d;
  }
  const out = new Uint8Array(bytes.length);
  if (maxDev === 0) { out.set(bytes); return out; }
  const scale = 127 / maxDev;
  for (let i = 0; i < bytes.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(128 + (bytes[i] - 128) * scale)));
  }
  return out;
}

/** Linear fade from silence into full level across the span. */
export function fadeIn(bytes) {
  const out = new Uint8Array(bytes.length);
  const n = Math.max(1, bytes.length - 1);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = Math.round(128 + (bytes[i] - 128) * (i / n));
  }
  return out;
}

/** Linear fade from full level out to silence across the span. */
export function fadeOut(bytes) {
  const out = new Uint8Array(bytes.length);
  const n = Math.max(1, bytes.length - 1);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = Math.round(128 + (bytes[i] - 128) * (1 - i / n));
  }
  return out;
}

/** Reverse the span (loop points are NOT remapped — the editor's markers
 *  stay put; adjust them afterwards if the loop mattered). */
export function reverse(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

/** Polarity swap: reflect every sample about the 0x80 DC centre (out = 256-s,
 *  clamped). Silence (0x80) is fixed; 0x00 clamps to 0xFF (its ideal +128
 *  partner has no 8-bit slot). */
export function invert(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = Math.max(0, Math.min(255, 256 - bytes[i]));
  }
  return out;
}

/** Remove DC offset (item 68): shift the whole span so its mean sits at the
 *  0x80 centre. A pure bias shift — the waveform shape is untouched except
 *  where clamping bites on an extreme offset (a wave already riding near the
 *  rail). Applying it twice is a no-op unless clamping occurred. */
export function removeDC(bytes) {
  const out = new Uint8Array(bytes.length);
  if (bytes.length === 0) return out;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i];
  const bias = Math.round(sum / bytes.length) - 128;
  for (let i = 0; i < bytes.length; i++) {
    out[i] = Math.max(0, Math.min(255, bytes[i] - bias));
  }
  return out;
}

export const SAMPLE_DSP = [
  ["Normalise", normalise],
  ["Fade in", fadeIn],
  ["Fade out", fadeOut],
  ["Reverse", reverse],
  ["Invert", invert],
  ["Remove DC", removeDC],
];
