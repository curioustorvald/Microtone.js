// Length-preserving DSP over U8 PCM sample spans (centre 0x80) — the sample
// editor's operation set. Pure functions: take a Uint8Array view, return a
// NEW Uint8Array of the same length (callers apply via setSampleBytesOp so
// the edit is one invertible undo step). Length-changing edits (trim,
// resample) are deliberately out of scope — they'd ripple every pool pointer.

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

export const SAMPLE_DSP = [
  ["Normalise", normalise],
  ["Fade in", fadeIn],
  ["Fade out", fadeOut],
  ["Reverse", reverse],
];
