// Project cleanup / renumber operations (items 60, 73, 74). Pure planners
// compute a new song or bank layout; the invertible ops that apply them live in
// ops.js (snapshot swaps, like importBankOp). Families:
//   patterns    — remove unreferenced / renumber, rewriting cue references + pNam
//   bank        — remove unused instruments and their now-orphaned samples
//   instrument  — renumber one instrument, following every reference to it (73)
//   ixmp        — drop unreachable instrument patches (74)
//
// Cue words: `cues[cue][ch]` low 15 bits = the channel's pattern index (0x7FFF =
// empty); bit 15 is one bit of the cue's packed instruction word, so a pattern
// remap must preserve it.

import { CUE_EMPTY, PATTERN_SIZE, SAMPLEBIN_SIZE } from "../format/taud-const.js";
import { writePatchesBlob } from "../engine/inst.js";

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

// ── instrument renumber (item 73) ──

/** Pattern cells (any song) whose instrument byte is `slot`: [{song, pat, row}].
 *  The cell's instrument byte is 8-bit, so a sub-instrument ($100+, reachable
 *  through its metainstrument since item 71) can never be named by one — it must
 *  NOT be masked down to its low byte and match an unrelated $01–$FF slot. */
export function instrumentCellRefs(doc, slot) {
  const refs = [];
  if (slot > 0xff) return refs;
  doc.songs.forEach((song, si) => {
    song.patterns.forEach((p, pi) => {
      if (!p) return;
      p.forEach((cell, row) => {
        if ((cell.instrment & 0xff) === slot) refs.push({ song: si, pat: pi, row });
      });
    });
  });
  return refs;
}

/**
 * Plan an instrument renumber `from` → `to` (item 73). The target must be a FREE
 * note-addressable slot ($01–$FF): occupied targets are refused rather than
 * silently swapped, and $100+ targets aren't offered because a metainstrument's
 * layer copies (item 72) are the way to reach that range.
 *
 * References that are pure wiring always follow the move — the Ixmp blob's slot
 * id, the INam entry, and every metainstrument layer that points at `from`.
 * Pattern cells are a musical choice: they only follow when `remapPatterns` is
 * set, otherwise cells keep referencing the (now empty) old number.
 *
 * Returns {error} or a renumberInstrumentOp plan: {image, inam, ixmp, cells}.
 */
export function planRenumberInstrument(doc, from, to, { remapPatterns = false } = {}) {
  if (!doc.sampleInstImage) return { error: "This project has no sample+instrument image." };
  if (to < 1 || to > 255) return { error: "An instrument number must be $01–$FF." };
  if (from === to) return { error: "The instrument already has that number." };
  const used = new Set(doc.usedInstrumentSlots());
  if (!used.has(from)) return { error: "That instrument slot is empty." };
  if (used.has(to)) {
    return { error: `$${to.toString(16).toUpperCase().padStart(2, "0")} is already taken.` };
  }
  doc._rebuildInstRegion(); // flush pending inst edits into the image

  const image = doc.sampleInstImage.slice();
  const recOff = (slot) => SAMPLEBIN_SIZE + slot * 256;
  image.set(image.slice(recOff(from), recOff(from) + 256), recOff(to));
  image.fill(0, recOff(from), recOff(from) + 256);

  // Metainstrument layers are raw record bytes, so patch them in the image: the
  // layer's low 8 index bits live at its byte 0, bits 8..9 in the top two bits
  // of its vol-start byte (+8). A meta that moved is patched at its NEW record.
  for (const s of used) {
    const layers = doc.instruments[s].metaLayers;
    if (!layers) continue;
    const base = recOff(s === from ? to : s);
    for (const l of layers) {
      if ((l.instIdx & 0x3ff) !== from) continue;
      image[base + l.rawOffset] = to & 0xff;
      image[base + l.rawOffset + 8] = (l.volStart & 0x3f) | (((to >>> 8) & 0x3) << 6);
    }
  }

  const inamArr = doc._nameTable("INam").slice();
  while (inamArr.length <= Math.max(from, to)) inamArr.push("");
  inamArr[to] = inamArr[from];
  inamArr[from] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  const ixmp = doc.ixmp.map((e) =>
    (e.instId & 0x3ff) === from ? { instId: to, count: e.count, blob: e.blob } : e);

  const cells = remapPatterns
    ? instrumentCellRefs(doc, from).map((r) => ({ ...r, inst: to }))
    : [];

  return { image, inam: encodeNameTable(inamArr), ixmp, cells, from, to };
}

// ── Ixmp patch cleanup (item 74) ──

/** A patch that can never sound: an empty pitch/velocity range, or no sample. */
function patchIsDegenerate(p) {
  return p.sampleLength <= 0 || p.pitchEnd < p.pitchStart || p.volumeEnd < p.volumeStart;
}

/**
 * Is `p`'s rectangle fully covered by the union of `earlier`'s rectangles? Patch
 * order IS trigger-match priority (engine resolvePatch returns the first hit), so
 * a fully-covered patch is unreachable. Exact test: compress the coordinates of
 * every boundary inside p into a grid and check each cell has a coverer — pairwise
 * containment would miss rectangles that only cover p when combined.
 */
function patchIsShadowed(p, earlier) {
  const covers = earlier.filter((q) =>
    !patchIsDegenerate(q) &&
    q.pitchStart <= p.pitchEnd && q.pitchEnd >= p.pitchStart &&
    q.volumeStart <= p.volumeEnd && q.volumeEnd >= p.volumeStart);
  if (covers.length === 0) return false;
  const axis = (lo, hi, starts, ends) => {
    const cuts = new Set([lo]);
    for (const v of starts) if (v > lo && v <= hi) cuts.add(v);
    for (const v of ends) if (v >= lo && v < hi) cuts.add(v + 1);
    return [...cuts].sort((a, b) => a - b);
  };
  const xs = axis(p.pitchStart, p.pitchEnd, covers.map((q) => q.pitchStart), covers.map((q) => q.pitchEnd));
  const ys = axis(p.volumeStart, p.volumeEnd, covers.map((q) => q.volumeStart), covers.map((q) => q.volumeEnd));
  for (const x of xs) {
    for (const y of ys) {
      // (x, y) is the lowest corner of a compressed cell: if it is covered, the
      // whole cell is (no rectangle boundary runs through a cell's interior).
      const hit = covers.some((q) =>
        x >= q.pitchStart && x <= q.pitchEnd && y >= q.volumeStart && y <= q.volumeEnd);
      if (!hit) return false;
    }
  }
  return true;
}

/**
 * Plan an Ixmp cleanup (item 74): drop patch entries that can never be triggered.
 *   * orphan    — the blob's instrument slot holds no record at all
 *   * degenerate— empty pitch/velocity range, or a zero-length sample
 *   * shadowed  — fully covered by higher-priority (earlier) patches
 * A slot whose patches all drop loses its Ixmp entry. Removing patches can change
 * the sample census, so SNam is realigned by (ptr:len) identity like planBankCleanup.
 * Returns {noop:true, …} when nothing is unreachable, else a cleanupBankOp plan
 * (image + INam pass through unchanged) with a per-slot report.
 */
export function planIxmpCleanup(doc) {
  if (!doc.sampleInstImage) return { noop: true, removedPatches: 0, removedBlobs: 0 };
  doc._rebuildInstRegion();
  const instRegion = doc.sampleInstImage.subarray(SAMPLEBIN_SIZE);
  const hasRecord = (slot) =>
    !instRegion.subarray(slot * 256, (slot + 1) * 256).every((b) => b === 0);

  const ixmp = [];
  const report = [];
  let removedPatches = 0;
  let removedBlobs = 0;
  for (const e of doc.ixmp) {
    const slot = e.instId & 0x3ff;
    const patches = doc.instruments[slot].extraPatches ?? [];
    if (!hasRecord(slot)) { // orphan blob: nothing to trigger it
      removedBlobs++;
      removedPatches += patches.length;
      report.push({ slot, reason: "orphan", dropped: patches.length, kept: 0, keep: [] });
      continue;
    }
    const keep = [];
    let dropped = 0;
    for (const p of patches) {
      if (patchIsDegenerate(p) || patchIsShadowed(p, keep)) { dropped++; continue; }
      keep.push(p);
    }
    if (dropped === 0) { ixmp.push(e); continue; }
    removedPatches += dropped;
    report.push({ slot, reason: "unreachable", dropped, kept: keep.length, keep });
    if (keep.length === 0) { removedBlobs++; continue; }
    ixmp.push({ instId: e.instId, count: keep.length, blob: writePatchesBlob(keep) });
  }
  if (removedPatches === 0) {
    return { noop: true, removedPatches: 0, removedBlobs: 0, report: [] };
  }

  // SNam realigns to the post-cleanup census: preview it with each touched
  // slot's SURVIVING patches, then key the names by (ptr:len) identity.
  const overrides = new Map(report.map((r) => [r.slot, r.keep]));
  const oldNameByKey = new Map();
  for (const s of doc.sampleList()) oldNameByKey.set(s.ptr + ":" + s.len, s.name);
  const snamArr = doc.sampleList(overrides).map((s) => oldNameByKey.get(s.ptr + ":" + s.len) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  return {
    image: doc.sampleInstImage,
    inam: doc.projSections.find((s) => s.fourcc === "INam")?.payload ?? null,
    snam: encodeNameTable(snamArr),
    ixmp,
    report,
    removedPatches,
    removedBlobs,
  };
}
