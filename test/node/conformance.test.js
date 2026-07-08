// Engine conformance vs the JVM oracle (tsvm devtests/webconf/RenderDumpTest).
// Compares the pre-dither float32 mix bus and the dithered U8 output for every
// corpus song with a reference dump in test/reference/ (gitignored; regenerate
// with the RenderDumpTest recipe in that file's header). Skips silently when
// no reference dumps are present. 4THSYM is NONDETERMINISTIC on the JVM side
// (Math.random vol/pan swing) and has no meaningful reference — excluded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../src/format/taud-parse.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { loadIntoEngine, renderSong } from "../../tools/render-taud.js";
import { SAMPLING_RATE } from "../../src/engine/constants.js";

const NONDETERMINISTIC = new Set(["4THSYM"]);

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const refDir = fileURLToPath(new URL("../reference/", import.meta.url));

let refFiles = [];
try {
  refFiles = (await readdir(refDir)).filter((f) => f.endsWith(".f32.pcm"));
} catch {
  // no reference dir — all conformance tests skip
}

for (const ref of refFiles) {
  const base = ref.replace(/\.f32\.pcm$/, "");
  if (NONDETERMINISTIC.has(base)) continue;

  test(`conformance ${base}`, async () => {
    try {
      await access(corpusDir + base + ".taud");
    } catch {
      return; // reference for a song no longer in the corpus
    }
    const refF32Bytes = await readFile(refDir + base + ".f32.pcm");
    const refU8 = await readFile(refDir + base + ".u8.pcm");
    const refF32 = new Float32Array(refF32Bytes.buffer, refF32Bytes.byteOffset, refF32Bytes.length / 4);
    const seconds = Math.round(refF32.length / 2 / SAMPLING_RATE);

    const doc = parseTaud(await readFile(corpusDir + base + ".taud"));
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    const r = renderSong(eng, seconds);

    assert.equal(r.f32.length, refF32.length, "rendered length differs");

    // Primary: pre-dither float32 tap. Pass criterion is ≤1e-6 max abs error;
    // in practice the port is bit-exact.
    let maxErr = 0;
    for (let i = 0; i < refF32.length; i++) {
      const e = Math.abs(r.f32[i] - refF32[i]);
      if (e > maxErr) maxErr = e;
    }
    assert.ok(maxErr <= 1e-6, `f32 max abs error ${maxErr} > 1e-6`);

    // Secondary: dithered U8 (seeded xorshift → deterministic). ≥99.9% exact, ±1 LSB.
    let exact = 0;
    let maxDelta = 0;
    for (let i = 0; i < refU8.length; i++) {
      const d = Math.abs(r.u8[i] - refU8[i]);
      if (d === 0) exact++;
      if (d > maxDelta) maxDelta = d;
    }
    assert.ok(exact / refU8.length >= 0.999, `u8 exact ratio ${exact / refU8.length}`);
    assert.ok(maxDelta <= 1, `u8 max delta ${maxDelta}`);
  });
}
