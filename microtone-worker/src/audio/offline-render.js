// Offline rendering — pure engine, runs identically in Node (tools/
// render-taud.js) and the browser (WAV export). Mirrors the JVM oracle's
// upload sequence exactly (taud.mjs uploadTaudFile order).

import { TaudEngine } from "../engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, MAX_VOICES, NUM_VOICES } from "../engine/constants.js";

/** Load a parsed .taud (or Document-adapted) song into a fresh engine. */
export function loadIntoEngine(eng, doc, songIndex = 0) {
  const song = doc.songs[songIndex];
  if (!song) throw new Error("songIndex out of range");

  eng.set64ChannelMode(doc.is64Channel);
  if (doc.sampleInstImage) eng.uploadSampleInstBlob(doc.sampleInstImage);

  for (let p = 0; p < song.patterns.length; p++) eng.uploadPattern(p, song.patterns[p]);

  const chans = doc.is64Channel ? MAX_VOICES : NUM_VOICES;
  const cueBytes = new Uint8Array(chans * 2);
  for (let c = 0; c < song.cues.length; c++) {
    const words = song.cues[c];
    for (let ch = 0; ch < chans; ch++) {
      cueBytes[ch * 2] = words[ch] & 0xff;
      cueBytes[ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
    }
    eng.uploadCue(c, cueBytes);
  }

  eng.setTrackerMode(0);
  eng.setBPM(0, song.bpm);
  eng.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
  eng.setTrackerMixerFlags(0, song.globalFlags);
  eng.setSongGlobalVolume(0, song.globalVolume);
  eng.setSongMixingVolume(0, song.mixingVolume);
  eng.setMasterVolume(0, 255);

  for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
}

/** Render up to `seconds`; returns U8 device output + f32 mix-bus tap. */
export function renderSong(eng, seconds) {
  const maxFrames = seconds * SAMPLING_RATE;
  const nChunks = Math.ceil(maxFrames / TRACKER_CHUNK);
  const u8out = new Uint8Array(nChunks * TRACKER_CHUNK * 2);
  const f32out = new Float32Array(nChunks * TRACKER_CHUNK * 2);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;

  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let chunkIdx = 0;
  let halted = false;
  while (frames < maxFrames) {
    if (!eng.isPlaying(0)) { halted = true; break; }
    if (eng.renderChunk(0, chunk) === null) { halted = true; break; }
    u8out.set(chunk, chunkIdx * TRACKER_CHUNK * 2);
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2] = ts.mixLeft[n];
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2 + 1] = ts.mixRight[n];
    }
    frames += TRACKER_CHUNK;
    chunkIdx++;
  }

  return {
    u8: u8out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    f32: f32out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    frames,
    halted,
  };
}

/** Linear-resample interleaved stereo Float32 from srcRate to dstRate. */
function resampleStereoF32(f32, srcRate, dstRate) {
  if (srcRate === dstRate) return f32;
  const srcFrames = f32.length / 2;
  const dstFrames = Math.floor((srcFrames * dstRate) / srcRate);
  const out = new Float32Array(dstFrames * 2);
  const step = srcRate / dstRate;
  for (let n = 0; n < dstFrames; n++) {
    const pos = n * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const i1 = Math.min(i0 + 1, srcFrames - 1);
    out[n * 2] = f32[i0 * 2] * (1 - frac) + f32[i1 * 2] * frac;
    out[n * 2 + 1] = f32[i0 * 2 + 1] * (1 - frac) + f32[i1 * 2 + 1] * frac;
  }
  return out;
}

/** Offline-render a Document's song to a 16-bit stereo WAV, resampled to
 *  `outRate` (default 48 kHz), taken from the pre-dither float mix bus (no
 *  dithering). Returns {bytes, seconds, halted}. */
export function renderToWav(docLike, songIndex, maxSeconds, outRate = 48000) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  const r = renderSong(eng, maxSeconds);

  const pcm = resampleStereoF32(r.f32, SAMPLING_RATE, outRate);
  const numSamples = pcm.length; // interleaved stereo samples
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 2, true);           // stereo
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 4, true); // byte rate (16-bit stereo)
  dv.setUint16(32, 4, true);           // block align
  dv.setUint16(34, 16, true);          // bits
  wstr(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return { bytes: new Uint8Array(buf), seconds: r.frames / SAMPLING_RATE, halted: r.halted };
}
