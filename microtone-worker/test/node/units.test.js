// Instrument-editor field annotations (src/ui/units.js) — the fadeout / filter
// unit translations shared by the basic General tab and the Advanced Edit 'x'
// block. i18n defaults to English in Node, so the words are the en strings.

import { test } from "node:test";
import assert from "node:assert/strict";

import { annHex2, annFilter, annFadeout, annSfCutoff, annSfReso } from "../../src/ui/units.js";

test("annFadeout → ticks-to-silence (none / cut boundaries)", () => {
  assert.equal(annFadeout(0), "none");
  assert.equal(annFadeout(-5), "none");
  assert.equal(annFadeout(1024), "cut");
  assert.equal(annFadeout(4096), "cut"); // ≥1024 is still an instant cut
  assert.equal(annFadeout(512), "~2 ticks");
  assert.equal(annFadeout(256), "~4 ticks");
});

test("annFilter → off sentinel or hex byte (ImpulseTracker units)", () => {
  assert.equal(annFilter(0xff), "off");
  assert.equal(annFilter(0x40), "$40");
  assert.equal(annFilter(0), "$00");
  assert.equal(annHex2(0xab), "$AB");
});

test("annSfCutoff → Hz/kHz from absolute cents, spec-clamped", () => {
  assert.equal(annSfCutoff(0xffff), "off");
  assert.equal(annSfCutoff(6900), "440 Hz");   // 8.176·2^(6900/1200) ≈ 440
  assert.equal(annSfCutoff(0), "19 Hz");        // clamps up to 1500 cents
  assert.equal(annSfCutoff(13500), "20 kHz");   // clamps at the top of the range
});

test("annSfReso → dB from centibels, clamped at 960 cB", () => {
  assert.equal(annSfReso(0xffff), "flat");
  assert.equal(annSfReso(60), "6.0 dB");
  assert.equal(annSfReso(960), "96.0 dB");
  assert.equal(annSfReso(2000), "96.0 dB"); // clamped
});
