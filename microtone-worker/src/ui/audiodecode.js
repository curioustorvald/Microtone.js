// Browser audio-file decoding for the sample importer. Whatever the browser's
// decodeAudioData accepts (.wav, .mp3, .ogg, .flac, …) comes out as mono U8
// PCM (centre 0x80) sized to fit the record's u16 sample-length budget, plus
// the Hz@C4 rate that keeps its original pitch.

async function decodeMono(fileBytes, contextRate) {
  const { channels, srcSeconds } = await decodeChannels(fileBytes, contextRate);
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (const d of channels) for (let i = 0; i < n; i++) mono[i] += d[i];
  if (channels.length > 1) {
    for (let i = 0; i < n; i++) mono[i] /= channels.length;
  }
  return { mono, srcSeconds };
}

/** Decode to per-channel float buffers, keeping at most `maxChannels` of them
 *  (a >2-channel file is folded to its first two — Taud plays stereo, and
 *  surround is TODO #998). */
async function decodeChannels(fileBytes, contextRate, maxChannels = 2) {
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AC) throw new Error("no OfflineAudioContext — can't decode audio here");
  // decodeAudioData resamples to the context rate (spec behaviour), so the
  // context rate normalises 44.1/48/96 kHz sources up front.
  const ctx = new AC(1, 1, contextRate);
  const buf = await ctx.decodeAudioData(
    fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
  const keep = Math.max(1, Math.min(maxChannels, buf.numberOfChannels));
  const channels = [];
  for (let ch = 0; ch < keep; ch++) channels.push(Float32Array.from(buf.getChannelData(ch)));
  return { channels, srcChannels: buf.numberOfChannels, srcSeconds: buf.length / buf.sampleRate };
}

/**
 * Float decode for the Sample Lab (item 83): full-length at `rate` (default
 * 48 kHz — above the 32 kHz taud ceiling, so nothing is thrown away before the
 * user has cropped/chopped; the Lab's Kaiser resampler has the final say at
 * commit time). No length budget here — length changes are the Lab's whole
 * point.
 *
 * `stereo` (default true) keeps a stereo file's channels apart so the Lab
 * opens on a stereo take (item 90); `data` is always channel 1, so callers
 * that only understand mono still work, and `channels` carries the rest.
 * @returns {data, channels, srcChannels, rate, seconds}
 */
export async function decodeAudioToFloat(fileBytes, { rate = 48000, stereo = true } = {}) {
  if (!stereo) {
    const { mono, srcSeconds } = await decodeMono(fileBytes, rate);
    return { data: mono, channels: [mono], srcChannels: 1, rate, seconds: srcSeconds };
  }
  const { channels, srcChannels, srcSeconds } = await decodeChannels(fileBytes, rate);
  return { data: channels[0], channels, srcChannels, rate, seconds: srcSeconds };
}

/**
 * @param fileBytes Uint8Array of the encoded audio file
 * @returns {pcm: Uint8Array, rate: number, seconds: number, clipped: boolean}
 */
export async function decodeAudioToU8(fileBytes, { maxLen = 0xffff, preferredRate = 32000 } = {}) {
  const { mono, srcSeconds } = await decodeMono(fileBytes, preferredRate);

  // squeeze into the u16 length budget by linear resampling (rate drops with it)
  let rate = preferredRate; // the decode context resampled to this
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
  return { pcm, rate, seconds: srcSeconds, clipped };
}
