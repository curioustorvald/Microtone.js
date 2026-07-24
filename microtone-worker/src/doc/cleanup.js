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
import { writePatchesBlob, buildMetaRecord } from "../engine/inst.js";
import { emptyPatternBytes } from "./patterntools.js";

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

/** Binary content key of a pattern (its 512 raw bytes as a string). A null/absent
 *  slot uses the empty-pattern content, so it keys the same as a materialised-blank
 *  pattern — the two merge. */
function patternContentKey(pattern) {
  if (!pattern) {
    const bytes = emptyPatternBytes();
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  let s = "";
  for (let r = 0; r < pattern.length; r++) {
    const cell = pattern[r];
    for (let b = 0; b < 8; b++) s += String.fromCharCode(cell.getByte(b));
  }
  return s;
}

/**
 * De-dupe a keep-order: collapse byte-identical patterns onto their FIRST copy
 * in `order` (so with an ascending `order` the survivor is the lowest index).
 * Returns { order, canon }: `order` is the deduped keep-order (survivors only, in
 * their original relative order); `canon` maps every input old index to the old
 * index it merges onto (== itself for a survivor). Feed `canon` to
 * applyPatternOrder so cue words pointing at a duplicate re-target the survivor.
 */
export function planMergeDuplicatePatterns(song, order) {
  const firstByKey = new Map();
  const canon = new Map();
  const merged = [];
  for (const idx of order) {
    const key = patternContentKey(song.patterns[idx]);
    if (firstByKey.has(key)) {
      canon.set(idx, firstByKey.get(key));
    } else {
      firstByKey.set(key, idx);
      canon.set(idx, idx);
      merged.push(idx);
    }
  }
  return { order: merged, canon };
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
 * `canon` (optional, from planMergeDuplicatePatterns) re-targets each old index to
 * its merge survivor before the new-index lookup, so cues that played a duplicate
 * follow it onto the survivor.
 */
export function applyPatternOrder(song, order, patternNames, canon = null) {
  const oldToNew = new Map();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

  const patterns = order.map((oldIdx) => song.patterns[oldIdx] ?? null);

  const cues = song.cues.map((words) => {
    const out = words.slice();
    for (let ch = 0; ch < out.length; ch++) {
      const w = out[ch];
      const pat = w & PAT_MASK;
      if (pat === PAT_MASK) continue; // empty slot — leave as-is
      const canonPat = canon && canon.has(pat) ? canon.get(pat) : pat; // duplicate → survivor
      const nn = oldToNew.has(canonPat) ? oldToNew.get(canonPat) : PAT_MASK; // dropped → empty
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

// ── instrument delete ──

/** Metainstruments (used slots) that carry `slot` as one of their layers — the
 *  "parents" a delete has to rewire. Returns [{slot, layers}] (layers = how many
 *  of that meta's layers reference this sub-instrument). */
export function metainstrumentParents(doc, slot) {
  const s = slot & 0x3ff;
  const parents = [];
  for (const m of doc.usedInstrumentSlots()) {
    if (m === s) continue;
    const layers = doc.instruments[m].metaLayers;
    if (!layers) continue;
    const n = layers.filter((l) => (l.instIdx & 0x3ff) === s).length;
    if (n > 0) parents.push({ slot: m, layers: n });
  }
  return parents;
}

/** Sample spans (ptr:len) whose EVERY census user is in `slots` — the bytes a
 *  delete of that whole set can free without stealing a survivor's sample. Uses
 *  the deduped census (base insts + Ixmp patches); a shared span (a user outside
 *  the set) is never listed. Returns [{ptr, len}]. */
export function uniqueSampleSpansForSet(doc, slots) {
  const set = slots instanceof Set ? slots : new Set(slots);
  return doc.sampleList()
    .filter((e) => e.users.every((u) => set.has(u)))
    .map((e) => ({ ptr: e.ptr, len: e.len }));
}

/** Sample spans only `slot` uses (the single-slot case of the above). */
export function uniqueSampleSpans(doc, slot) {
  return uniqueSampleSpansForSet(doc, [slot & 0x3ff]);
}

/**
 * Classify a metainstrument's layer children for a cascade delete. A child still
 * layered by some OTHER used metainstrument is kept (it is in use elsewhere). The
 * rest split by addressability:
 *   * $100+ children — outside the 8-bit note-addressable range, so nothing but a
 *     meta layer can reach them; once their meta goes they are orphans and are
 *     auto-deleted (no pattern probe needed).
 *   * $01–$FF children — can still be played by pattern cells, so they are only
 *     OFFERED (with their pattern-reference count) — the caller decides.
 * Returns {autoChildren:[slot…], lowChildren:[{slot, patternRefs}…]}; both empty
 * for a non-meta.
 */
export function classifyMetaChildren(doc, metaSlot) {
  const m = metaSlot & 0x3ff;
  const inst = doc.instruments[m];
  if (!inst?.isMeta || !inst.metaLayers) return { autoChildren: [], lowChildren: [] };
  const used = doc.usedInstrumentSlots();
  const kids = [...new Set(inst.metaLayers.map((l) => l.instIdx & 0x3ff))].filter((k) => k !== m);
  const autoChildren = [];
  const lowChildren = [];
  for (const kid of kids) {
    const referencedElsewhere = used.some((o) => {
      if (o === m || o === kid) return false;
      const ml = doc.instruments[o].metaLayers;
      return ml && ml.some((l) => (l.instIdx & 0x3ff) === kid);
    });
    if (referencedElsewhere) continue; // still a layer of another meta — keep it
    if (kid >= 0x100) autoChildren.push(kid);
    else lowChildren.push({ slot: kid, patternRefs: instrumentCellRefs(doc, kid).length });
  }
  return { autoChildren, lowChildren };
}

/**
 * Plan deleting instrument `slot` (this feature). Zeroes its record, blanks its
 * INam entry, drops its Ixmp patches, rewires every SURVIVING metainstrument that
 * layered a deleted slot (that layer is repacked out; a meta reduced to zero
 * layers is removed too, since a 0-layer record decodes as neither meta nor
 * sample), and — when `freeSamples` — frees the sample bytes only the deleted
 * instruments used.
 *
 * When `slot` is a metainstrument the delete CASCADES to its now-orphaned sub-
 * instruments (classifyMetaChildren): $100+ orphans always, and — only when
 * `deleteLowChildren` — its $01–$FF children too (those can be played by
 * patterns, hence the opt-in).
 *
 * Pattern cells are the note references. The PRIMARY slot's notes are LEFT
 * pointing at the now-empty number (a "dangling instrument") unless `reassignTo`
 * ($01–$FF) moves them onto another number first (the global Change-instrument
 * op, folded into the same undo step); any deleted $01–$FF sub-instrument's notes
 * are left to dangle. $100+ slots can't be note-referenced.
 *
 * Returns {error} or a deleteInstrumentOp plan {image, inam, ixmp, cells, …} plus
 * a report the confirm dialog can show. The op rebuilds the Ixmp SECTION from
 * `ixmp` (like the renumber/cleanup ops), so the delete survives a save.
 */
export function planDeleteInstrument(doc, slot, { freeSamples = false, reassignTo = null, deleteLowChildren = false } = {}) {
  if (!doc.sampleInstImage) return { error: "This project has no sample+instrument image." };
  const s = slot & 0x3ff;
  if (!doc.usedInstrumentSlots().includes(s)) return { error: "That instrument slot is empty." };
  doc._rebuildInstRegion(); // flush pending inst edits into the image

  const { autoChildren, lowChildren } = classifyMetaChildren(doc, s);
  const deleteSet = new Set([s, ...autoChildren]);
  if (deleteLowChildren) for (const c of lowChildren) deleteSet.add(c.slot);

  const recOff = (x) => SAMPLEBIN_SIZE + x * 256;
  const image = doc.sampleInstImage.slice();
  for (const x of deleteSet) image.fill(0, recOff(x), recOff(x) + 256);

  // Rewire surviving metainstruments: repack any layer that pointed at a deleted
  // slot out of the table (a meta left with zero layers is removed too). Deleted
  // metas are skipped — their whole record is already zeroed.
  const rewiredMetas = [];
  const emptiedMetas = [];
  for (const o of doc.usedInstrumentSlots()) {
    if (deleteSet.has(o)) continue;
    const oi = doc.instruments[o];
    if (!oi.metaLayers || !oi.metaLayers.some((l) => deleteSet.has(l.instIdx & 0x3ff))) continue;
    const kept = oi.metaLayers.filter((l) => !deleteSet.has(l.instIdx & 0x3ff));
    if (kept.length === 0) {
      image.fill(0, recOff(o), recOff(o) + 256);
      emptiedMetas.push(o);
    } else {
      image.set(buildMetaRecord(kept, {
        strict: oi.metaStrict,
        percussion: (oi.metaRaw[0] & 0x02) !== 0,
      }), recOff(o));
      rewiredMetas.push(o);
    }
  }

  const removedSet = new Set([...deleteSet, ...emptiedMetas]);

  // Free sample bytes only the removed instruments used.
  let freedSampleBytes = 0, freedSamples = 0;
  if (freeSamples) {
    const pool = image.subarray(0, SAMPLEBIN_SIZE);
    for (const sp of uniqueSampleSpansForSet(doc, removedSet)) {
      for (let i = sp.ptr; i < sp.ptr + sp.len; i++) if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
      freedSamples++;
    }
  }

  // INam: blank every removed slot.
  const inamArr = doc._nameTable("INam").slice();
  for (const x of removedSet) if (x < inamArr.length) inamArr[x] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  // Ixmp: drop every removed slot's patch entries.
  const ixmp = doc.ixmp.filter((e) => !removedSet.has(e.instId & 0x3ff));

  // Note references: reassign only the PRIMARY slot (a deleted low sub-instrument
  // dangles). $100+ can't be note-referenced.
  const refs = s <= 0xff ? instrumentCellRefs(doc, s) : [];
  const doReassign = reassignTo !== null && s <= 0xff;
  const cells = doReassign ? refs.map((r) => ({ ...r, inst: reassignTo & 0xff })) : [];

  return {
    image, inam: encodeNameTable(inamArr), ixmp, cells, from: s,
    freedSamples, freedSampleBytes, rewiredMetas, emptiedMetas,
    autoChildren, deletedLowChildren: deleteLowChildren ? lowChildren.map((c) => c.slot) : [],
    danglingRefs: doReassign ? 0 : refs.length,
  };
}
