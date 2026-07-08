#!/usr/bin/env node
// Render a .taud through the JS Taud engine to PCM dumps, mirroring the JVM
// oracle (tsvm/devtests/webconf/RenderDumpTest.java) exactly:
//   <out>/<name>.u8.pcm   interleaved stereo unsigned-8 (device output)
//   <out>/<name>.f32.pcm  interleaved stereo float32 LE pre-dither mix bus
// Usage: node tools/render-taud.js <in.taud> <outDir> [seconds=20] [songIndex=0]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseTaud } from "../src/format/taud-parse.js";
import { TaudEngine } from "../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, MAX_VOICES, NUM_VOICES } from "../src/engine/constants.js";

export function loadIntoEngine(eng, doc, songIndex = 0) {
  if (doc.kind !== "taud") throw new Error("not a full .taud");
  if (songIndex < 0 || songIndex >= doc.songs.length) throw new Error("songIndex out of range");
  const song = doc.songs[songIndex];

  eng.set64ChannelMode(doc.is64Channel);
  eng.uploadSampleInstBlob(doc.sampleInstImage);

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

  // Playhead config — same order as taud.mjs uploadTaudFile / RenderDumpTest.
  eng.setTrackerMode(0);
  eng.setBPM(0, song.bpm);
  eng.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
  eng.setTrackerMixerFlags(0, song.globalFlags);
  eng.setSongGlobalVolume(0, song.globalVolume);
  eng.setSongMixingVolume(0, song.mixingVolume);
  eng.setMasterVolume(0, 255);

  for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
}

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

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const [inPath, outDir = "/tmp/tauddump-js", secondsArg, songArg] = process.argv.slice(2);
  if (!inPath) {
    console.error("usage: render-taud.js <in.taud> <outDir> [seconds=20] [songIndex=0]");
    process.exit(2);
  }
  const seconds = secondsArg ? parseInt(secondsArg, 10) : 20;
  const songIndex = songArg ? parseInt(songArg, 10) : 0;

  const doc = parseTaud(await readFile(inPath));
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, songIndex);
  const t0 = performance.now();
  const r = renderSong(eng, seconds);
  const dt = performance.now() - t0;

  await mkdir(outDir, { recursive: true });
  const base = basename(inPath).replace(/\.taud$/, "");
  await writeFile(join(outDir, base + ".u8.pcm"), r.u8);
  await writeFile(join(outDir, base + ".f32.pcm"), Buffer.from(r.f32.buffer, r.f32.byteOffset, r.f32.byteLength));
  console.log(`${base}: frames=${r.frames} (${(r.frames / SAMPLING_RATE).toFixed(1)}s) halted=${r.halted} rendered in ${dt.toFixed(0)}ms (${(r.frames / SAMPLING_RATE / (dt / 1000)).toFixed(1)}x realtime)`);
}
