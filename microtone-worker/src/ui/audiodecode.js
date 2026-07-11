// Browser audio-file decoding for the sample importer. Whatever the browser's
// decodeAudioData accepts (.wav, .mp3, .ogg, .flac, …) comes out as mono U8
// PCM (centre 0x80) sized to fit the record's u16 sample-length budget, plus
// the Hz@C4 rate that keeps its original pitch.

/**
 * @param fileBytes Uint8Array of the encoded audio file
 * @returns {pcm: Uint8Array, rate: number, seconds: number, clipped: boolean}
 */
export async function decodeAudioToU8(fileBytes, { maxLen = 0xffff, preferredRate = 32000 } = {}) {
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AC) throw new Error("no OfflineAudioContext — can't decode audio here");
  // decodeAudioData resamples to the context rate (spec behaviour), so a
  // 32 kHz context normalises 44.1/48/96 kHz sources up front.
  const ctx = new AC(1, 1, preferredRate);
  const buf = await ctx.decodeAudioData(
    fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));

  // mix every channel down to mono
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += d[i];
  }
  if (buf.numberOfChannels > 1) {
    for (let i = 0; i < n; i++) mono[i] /= buf.numberOfChannels;
  }

  // squeeze into the u16 length budget by linear resampling (rate drops with it)
  let rate = buf.sampleRate;
  let data = mono;
  if (data.length > maxLen) {
    const factor = data.length / maxLen;
    const out = new Float32Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      const x = i * factor;
      const i0 = Math.floor(x);
      const i1 = Math.min(i0 + 1, data.length - 1);
      out[i] = data[i0] + (data[i1] - data[i0]) * (x - i0);
    }
    rate /= factor;
    data = out;
  }
  rate = Math.max(1, Math.min(0xffff, Math.round(rate)));

  let clipped = false;
  const pcm = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(128 + data[i] * 127);
    if (v < 0 || v > 255) clipped = true;
    pcm[i] = Math.max(0, Math.min(255, v));
  }
  return { pcm, rate, seconds: n / buf.sampleRate, clipped };
}
