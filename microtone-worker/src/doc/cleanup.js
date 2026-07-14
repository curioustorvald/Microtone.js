// Project cleanup / renumber operations (item 60). Pure planners compute a new
// song layout; the invertible ops that apply them live in ops.js (snapshot
// swaps, like importBankOp). Two families:
//   patterns — remove unreferenced / renumber, rewriting cue references + pNam
//   bank     — remove unused instruments and their now-orphaned samples
//
// Cue words: `cues[cue][ch]` low 15 bits = the channel's pattern index (0x7FFF =
// empty); bit 15 is one bit of the cue's packed instruction word, so a pattern
// remap must preserve it.

import { CUE_EMPTY, PATTERN_SIZE, SAMPLEBIN_SIZE } from "../format/taud-const.js";

const PAT_MASK = 0x7fff;

/** Pattern indices referenced by any cue, in order of FIRST appearance
 *  (cue 0 ch 0, ch 1, …, cue 1, …). Excludes empty slots. */
export function referencedPatterns(song) {
  const seen = new Set();
  const order = [];
  for (const words of song.cues) {
    for (const w of words) {
      const pat = w & PAT_MASK;
      if (pat !== PAT_MASK && !seen.has(pat)) { seen.add(pat); order.push(pat); }
    }
  }
  return order;
}

/** Indices of materialised (non-null) patterns, ascending. */
function materialisedPatterns(song) {
  const out = [];
  for (let i = 0; i < song.patterns.length; i++) if (song.patterns[i]) out.push(i);
  return out;
}

/** New keep-order for "cleanup unused": only cue-referenced patterns, ascending
 *  by old index (stable, predictable numbering). */
export function planCleanupPatterns(song) {
  return [...new Set(referencedPatterns(song))].sort((a, b) => a - b);
}

/** New keep-order for "renumber": referenced patterns in play (first-appearance)
 *  order, then any materialised-but-unreferenced patterns (ascending) so nothing
 *  with content is lost — just compacted and reordered. */
export function planRenumberPatterns(song) {
  const ref = referencedPatterns(song);
  const refSet = new Set(ref);
  const extra = materialisedPatterns(song).filter((i) => !refSet.has(i));
  return [...ref, ...extra];
}

/**
 * Apply a keep-order (`order` = old indices in their new position) to a song:
 * returns { patterns, cues, pNam } — a fresh patterns array, cue words rewritten
 * to the new indices (empty slots and the instruction sign bit preserved; a
 * reference to a dropped pattern becomes empty), and a reordered pNam name list
 * (array of strings, aligned to the new indices). Pure — does not mutate `song`.
 */
export function applyPatternOrder(song, order, patternNames) {
  const oldToNew = new Map();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

  const patterns = order.map((oldIdx) => song.patterns[oldIdx] ?? null);

  const cues = song.cues.map((words) => {
    const out = words.slice();
    for (let ch = 0; ch < out.length; ch++) {
      const w = out[ch];
      const pat = w & PAT_MASK;
      if (pat === PAT_MASK) continue; // empty slot — leave as-is
      const nn = oldToNew.has(pat) ? oldToNew.get(pat) : PAT_MASK; // dropped → empty
      out[ch] = (w & 0x8000) | (nn & PAT_MASK);
    }
    return out;
  });

  const names = order.map((oldIdx) => patternNames[oldIdx] ?? "");
  // Trim trailing empty names (keep the table compact).
  while (names.length && names[names.length - 1] === "") names.pop();

  return { patterns, cues, pNam: names };
}

/** Encode a name-table string array to its 0x1E-separated payload, or null when
 *  empty (matches Document._nameTable's decode). */
export function encodeNameTable(names) {
  if (!names || names.length === 0) return null;
  const enc = new TextEncoder();
  const segs = names.map((n) => enc.encode(n ?? ""));
  const total = segs.reduce((n, s) => n + s.length, 0) + (segs.length - 1);
  const out = new Uint8Array(Math.max(0, total));
  let off = 0;
  segs.forEach((s, i) => { if (i > 0) out[off++] = 0x1e; out.set(s, off); off += s.length; });
  return out;
}

// ── bank cleanup (instruments + samples) ──

/** Instrument slots actually used: referenced by a pattern cell OR pulled in as
 *  a metainstrument layer child of a used top-level instrument. `instAt(slot)`
 *  returns the decoded TaudInst (for meta-layer closure). */
export function usedInstrumentSlots(song, allUsedSlots, instAt) {
  const used = new Set();
  for (const p of song.patterns) {
    if (!p) continue;
    for (const cell of p) if (cell.instrment !== 0) used.add(cell.instrment & 0xff);
  }
  // Meta-layer dependency closure (a used meta pulls in its children).
  const queue = [...used];
  while (queue.length) {
    const s = queue.pop();
    const layers = instAt(s)?.metaLayers;
    if (layers) for (const l of layers) {
      const c = l.instIdx & 0x3ff;
      if (allUsedSlots.has(c) && !used.has(c)) { used.add(c); queue.push(c); }
    }
  }
  return used;
}

/** Sample spans referenced by `slots` (deduped by ptr:len, ptr-sorted).
 *  instAt(slot) → decoded TaudInst. Returns [{ptr, len, key}]. */
function censusForSlots(instAt, slots) {
  const byKey = new Map();
  const add = (ptr, len) => {
    if (len <= 0) return;
    const key = ptr + ":" + len;
    if (!byKey.has(key)) byKey.set(key, { ptr, len, key });
  };
  for (const s of slots) {
    const inst = instAt(s);
    if (!inst) continue;
    if (!inst.isMeta) add(inst.samplePtr, inst.sampleLength);
    if (inst.extraPatches) for (const p of inst.extraPatches) add(p.samplePtr, p.sampleLength);
  }
  return [...byKey.values()].sort((a, b) => a.ptr - b.ptr);
}

/**
 * Plan a bank cleanup (item 60): drop instruments no pattern cell references
 * (keeping meta-layer children of used metas) and free the sample bytes that
 * only they used. Returns the NEW bank state for cleanupBankOp:
 *   { image, inam, snam, ixmp, removedInstruments, freedSampleBytes }
 * `inam`/`snam` are name-table payloads (or null). Pure w.r.t. the doc except a
 * _rebuildInstRegion() to make the image current first.
 */
export function planBankCleanup(doc) {
  if (!doc.sampleInstImage) return { noop: true, removedInstruments: 0, freedSampleBytes: 0 };
  doc._rebuildInstRegion(); // flush pending inst edits into the image
  const instAt = (s) => doc.instruments[s];
  const allUsed = new Set(doc.usedInstrumentSlots());

  // Slots referenced by a pattern cell (any song) + meta-layer dependency closure.
  const used = new Set();
  for (const song of doc.songs) for (const p of song.patterns) {
    if (!p) continue;
    for (const cell of p) if (cell.instrment !== 0) used.add(cell.instrment & 0xff);
  }
  const queue = [...used];
  while (queue.length) {
    const layers = instAt(queue.pop())?.metaLayers;
    if (layers) for (const l of layers) {
      const c = l.instIdx & 0x3ff;
      if (allUsed.has(c) && !used.has(c)) { used.add(c); queue.push(c); }
    }
  }
  const survivors = [...allUsed].filter((s) => used.has(s));
  const unused = [...allUsed].filter((s) => !used.has(s));

  // Cleaned image: zero the removed instrument records.
  const image = doc.sampleInstImage.slice();
  for (const s of unused) image.fill(0, SAMPLEBIN_SIZE + s * 256, SAMPLEBIN_SIZE + (s + 1) * 256);

  // Free sample bytes referenced ONLY by removed instruments: zero the pool
  // outside the surviving census spans (shared samples are kept).
  const keep = censusForSlots(instAt, survivors);
  const pool = image.subarray(0, SAMPLEBIN_SIZE);
  let freedSampleBytes = 0;
  const zeroRange = (from, to) => {
    for (let i = from; i < to; i++) if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
  };
  let cursor = 0;
  for (const sp of keep) {
    if (sp.ptr > cursor) zeroRange(cursor, sp.ptr);
    cursor = Math.max(cursor, sp.ptr + sp.len);
  }
  zeroRange(cursor, SAMPLEBIN_SIZE);

  // INam: blank removed slots' names.
  const inamArr = doc._nameTable("INam").slice();
  for (const s of unused) if (s < inamArr.length) inamArr[s] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  // SNam: realign to the surviving census (names keyed by ptr:len identity).
  const oldNameByKey = new Map();
  for (const e of doc.sampleList()) oldNameByKey.set(e.ptr + ":" + e.len, e.name);
  const snamArr = keep.map((sp) => oldNameByKey.get(sp.key) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  // Ixmp: keep the patches of surviving slots only.
  const ixmp = doc.ixmp.filter((e) => used.has(e.instId & 0x3ff));

  return {
    image, inam: encodeNameTable(inamArr), snam: encodeNameTable(snamArr), ixmp,
    removedInstruments: unused.length, freedSampleBytes,
  };
}
