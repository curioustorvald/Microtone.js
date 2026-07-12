// Invertible document operations. Every mutation is an op object
// {type, ..., apply(doc) → inverseOp, dirty(doc) → [tags]}; undo.js stacks the
// inverses, sync.js consumes the dirty tags. Gesture coalescing is keyed by
// op.coalesceKey (same key + same gestureId collapse in the undo stack).
//
// Dirty tags: {kind:"pattern", song, pat} | {kind:"cue", song, cue}
//           | {kind:"scalar", song, key} | {kind:"inst", slot} | {kind:"bank"}

import { applyPlan, captureBankState, restoreBankState } from "./bankmerge.js";
import { TaudPlayData } from "../engine/state.js";
import { CUE_EMPTY, MAX_VOICES, NUM_CUES, NUM_CUES_64 } from "../format/taud-const.js";

export function setCellOp(song, pat, row, fields, gestureId = null) {
  return {
    type: "setCell",
    song, pat, row, fields, gestureId,
    coalesceKey: `cell:${song}:${pat}:${row}`,
    apply(doc) {
      const cell = doc.songs[song].patterns[pat][row];
      const prev = {};
      for (const k of Object.keys(fields)) {
        prev[k] = cell[k];
        cell[k] = fields[k];
      }
      doc.dirty = true;
      return setCellOp(song, pat, row, prev, gestureId);
    },
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

export function setCueWordOp(song, cue, ch, value, gestureId = null) {
  return {
    type: "setCueWord",
    song, cue, ch, value, gestureId,
    coalesceKey: `cue:${song}:${cue}:${ch}`,
    apply(doc) {
      const words = doc.songs[song].cues[cue];
      const prev = words[ch];
      words[ch] = value & 0xffff;
      doc.dirty = true;
      return setCueWordOp(song, cue, ch, prev, gestureId);
    },
    dirty: () => [{ kind: "cue", song, cue }],
  };
}

/** Replace a whole cue's words (used by the CueCmd popup / instruction edits). */
export function setCueOp(song, cue, words, gestureId = null) {
  return {
    type: "setCue",
    song, cue, words, gestureId,
    coalesceKey: `cueAll:${song}:${cue}`,
    apply(doc) {
      const target = doc.songs[song].cues[cue];
      const prev = Uint16Array.from(target);
      target.set(words);
      doc.dirty = true;
      return setCueOp(song, cue, prev, gestureId);
    },
    dirty: () => [{ kind: "cue", song, cue }],
  };
}

/** Highest cue index the doc's channel mode can address (format-limited). */
function cueLimit(doc) { return doc.is64Channel ? NUM_CUES_64 : NUM_CUES; }

/**
 * Bulk cue-word writer that GROWS the cue list (append-only at the tail) to
 * cover any cue index the writes reach — this is what lets the Cues view edit
 * or paste past the last stored cue (past a HALT, or a brand-new song's single
 * cue 0). `writes` is [{cue, ch, value}] with `value` a full 16-bit cue word
 * (pattern index | command sign bit). The inverse restores each cell's previous
 * word AND truncates any cues this op appended, so growth undoes cleanly.
 * Feature reference: taut.js editCuePtn + ordersMaxRow (one blank row past the
 * last active cue). Used by every Cues-view edit: pattern entry, delete, block
 * paste/cut/delete, and the command popup.
 */
export function setCuesOp(song, writes, gestureId = null) {
  return {
    type: "setCues",
    song, writes, gestureId,
    coalesceKey: `cues:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const oldLen = s.cues.length;
      const limit = cueLimit(doc);
      let maxCue = -1;
      for (const w of writes) if (w.cue > maxCue) maxCue = w.cue;
      const target = Math.min(maxCue + 1, limit);
      while (s.cues.length < target) {
        s.cues.push(new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));
      }
      const inverse = [];
      for (const w of writes) {
        if (w.cue >= s.cues.length) continue; // past the format limit — dropped
        const words = s.cues[w.cue];
        inverse.push({ cue: w.cue, ch: w.ch, value: words[w.ch] });
        words[w.ch] = w.value & 0xffff;
      }
      doc.dirty = true;
      return restoreCuesOp(song, inverse, oldLen, gestureId);
    },
    // Post-apply: one tag per WRITTEN cue (auto-created gap-filler cues stay
    // empty and are never uploaded — the engine's cueSheet is blanked past the
    // song's length on load, so a fresh gap can't hold stale data). These same
    // tags drive the eager cue upload on undo too — a written index truncated
    // away then reads an all-empty image from cueBytes(), blanking the copy.
    dirty(doc) {
      const s = doc.songs[song];
      const cues = new Set();
      for (const w of writes) if (w.cue < s.cues.length) cues.add(w.cue);
      return [...cues].map((cue) => ({ kind: "cue", song, cue }));
    },
  };
}

/** Inverse of setCuesOp: restore previous words, then pop any appended cues. */
function restoreCuesOp(song, prevWrites, truncateTo, gestureId = null) {
  return {
    type: "restoreCues",
    song, prevWrites, truncateTo, gestureId,
    coalesceKey: `cues:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      // Capture the current (forward-applied) values so redo reproduces the
      // original writes — including the ones in the cues we are about to pop.
      const forward = prevWrites.map((w) => ({
        cue: w.cue, ch: w.ch, value: s.cues[w.cue][w.ch],
      }));
      for (const w of prevWrites) s.cues[w.cue][w.ch] = w.value & 0xffff;
      while (s.cues.length > truncateTo) s.cues.pop();
      doc.dirty = true;
      return setCuesOp(song, forward, gestureId);
    },
    dirty() {
      const cues = new Set(prevWrites.map((w) => w.cue));
      return [...cues].map((cue) => ({ kind: "cue", song, cue }));
    },
  };
}

/** Instrument-scope field (TaudInst property, e.g. instGlobalVolume, defaultPan,
 *  instrumentFlag, volumeFadeoutLow…). Dirty {kind:"inst", slot} → uploadInstrument. */
export function setInstFieldOp(slot, key, value, gestureId = null) {
  return {
    type: "setInstField",
    slot, key, value, gestureId,
    coalesceKey: `inst:${slot}:${key}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = inst[key];
      inst[key] = value;
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setInstFieldOp(slot, key, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Write one or more raw record bytes atomically (for fields split across
 *  bytes that are not single decoded properties — e.g. the SoundFont filter
 *  cutoff/resonance whose low byte lives in the reserved region). `pairs` is
 *  [[offset, byte], …]; the inverse restores all touched bytes in one step, so
 *  a slider drag coalesces cleanly. */
export function setInstBytesOp(slot, pairs, gestureId = null) {
  return {
    type: "setInstBytes",
    slot, pairs, gestureId,
    coalesceKey: `instbytes:${slot}:${pairs.map((p) => p[0]).join(",")}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = pairs.map(([o]) => [o, inst.getByteNormal(o)]);
      for (const [o, b] of pairs) inst.setByte(o, b & 0xff);
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setInstBytesOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Write raw metaRaw bytes of a Metainstrument (its layer table), re-deriving
 *  metaLayers via loadRecord. setInstBytesOp/setByte can't be used for metas —
 *  their setByte writes the DECODED sample fields, which a meta ignores (getByte
 *  serves metaRaw verbatim). `pairs` is [[offset, byte], …]; inverse restores. */
export function setMetaBytesOp(slot, pairs, gestureId = null) {
  return {
    type: "setMetaBytes",
    slot, pairs, gestureId,
    coalesceKey: `metabytes:${slot}:${pairs.map((p) => p[0]).join(",")}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = pairs.map(([o]) => [o, inst.metaRaw[o]]);
      const raw = Uint8Array.from(inst.metaRaw);
      for (const [o, b] of pairs) raw[o] = b & 0xff;
      inst.loadRecord(raw); // re-derive metaLayers (+ a fresh metaRaw copy)
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setMetaBytesOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** One envelope node on an instrument envelope array (volEnvelopes /
 *  panEnvelopes / pfEnvelopes / pf2Envelopes): sets value and/or offset
 *  (ThreeFiveMiniUfloat LUT index). */
export function setEnvPointOp(slot, envKey, idx, point, gestureId = null) {
  return {
    type: "setEnvPoint",
    slot, envKey, idx, point, gestureId,
    coalesceKey: `env:${slot}:${envKey}:${idx}`,
    apply(doc) {
      const node = doc.instruments[slot & 0x3ff][envKey][idx];
      const prev = { value: node.value, offset: node.offset };
      if (point.value !== undefined) node.value = point.value;
      if (point.offset !== undefined) node.offset = point.offset;
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvPointOp(slot, envKey, idx, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Envelope-node DRAG: one op for the 2D gesture — value of node idx plus the
 *  duration of the preceding segment (env[idx-1].offset, minifloat index).
 *  Single coalesce key so a drag is one undo step. */
export function setEnvDragOp(slot, envKey, idx, change, gestureId = null) {
  return {
    type: "setEnvDrag",
    slot, envKey, idx, change, gestureId,
    coalesceKey: `envdrag:${slot}:${envKey}:${idx}`,
    apply(doc) {
      const env = doc.instruments[slot & 0x3ff][envKey];
      const prev = {};
      if (change.value !== undefined) {
        prev.value = env[idx].value;
        env[idx].value = change.value;
      }
      if (change.prevOffset !== undefined && idx > 0) {
        prev.prevOffset = env[idx - 1].offset;
        env[idx - 1].offset = change.prevOffset;
      }
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvDragOp(slot, envKey, idx, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Replace an entire 25-node envelope array (add/remove node structural edit).
 *  newNodes is [{value, offset}]×25; inverse restores the previous array. */
export function setEnvArrayOp(slot, envKey, newNodes, gestureId = null) {
  return {
    type: "setEnvArray",
    slot, envKey, newNodes, gestureId,
    coalesceKey: `envarray:${slot}:${envKey}`,
    apply(doc) {
      const env = doc.instruments[slot & 0x3ff][envKey];
      const prev = env.map((n) => ({ value: n.value, offset: n.offset }));
      for (let i = 0; i < env.length; i++) {
        env[i].value = newNodes[i].value;
        env[i].offset = newNodes[i].offset;
      }
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvArrayOp(slot, envKey, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Replace a whole pattern's 512-byte image (lengthen/shorten-style edits). */
export function setPatternBytesOp(song, pat, bytes, gestureId = null) {
  return {
    type: "setPatternBytes",
    song, pat, bytes, gestureId,
    coalesceKey: `patbytes:${song}:${pat}`,
    apply(doc) {
      const rows = doc.songs[song].patterns[pat];
      const prev = new Uint8Array(512);
      for (let r = 0; r < 64; r++) {
        for (let b = 0; b < 8; b++) {
          prev[r * 8 + b] = rows[r].getByte(b);
          rows[r].setByte(b, bytes[r * 8 + b]);
        }
      }
      doc.dirty = true;
      return setPatternBytesOp(song, pat, prev, gestureId);
    },
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

/** Write raw 8-byte images to a set of cells across (possibly several)
 *  patterns in one undo step — block paste / cut / delete-selection. `writes`
 *  is [{pat, row, bytes: Uint8Array(8)}]; the inverse restores each cell's
 *  previous bytes. Dirty tags cover every touched pattern. */
export function setCellsBytesOp(song, writes, gestureId = null) {
  return {
    type: "setCellsBytes",
    song, writes, gestureId,
    coalesceKey: `cellsbytes:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const inverse = new Array(writes.length);
      for (let i = 0; i < writes.length; i++) {
        const { pat, row, bytes } = writes[i];
        const cell = s.patterns[pat][row];
        const prev = new Uint8Array(8);
        for (let b = 0; b < 8; b++) { prev[b] = cell.getByte(b); cell.setByte(b, bytes[b]); }
        inverse[i] = { pat, row, bytes: prev };
      }
      doc.dirty = true;
      return setCellsBytesOp(song, inverse, gestureId);
    },
    dirty() {
      const pats = new Set(writes.map((w) => w.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Append a new pattern (512-byte image) at the end of the song's list —
 *  the Pattern view's Duplicate. Inverse pops it again; that is safe in the
 *  LIFO undo order because any later op that references the new index (a cue
 *  edit, say) is necessarily undone first. */
export function appendPatternOp(song, bytes, gestureId = null) {
  return {
    type: "appendPattern",
    song, bytes, gestureId,
    coalesceKey: `addpat:${song}`,
    apply(doc) {
      const rows = new Array(64);
      for (let r = 0; r < 64; r++) {
        const cell = new TaudPlayData();
        for (let b = 0; b < 8; b++) cell.setByte(b, bytes[r * 8 + b]);
        rows[r] = cell;
      }
      doc.songs[song].patterns.push(rows);
      doc.dirty = true;
      return removeLastPatternOp(song, gestureId);
    },
    // called post-apply: length-1 IS the new pattern's index
    dirty: (doc) => [{ kind: "pattern", song, pat: doc.songs[song].patterns.length - 1 }],
  };
}

function removeLastPatternOp(song, gestureId = null) {
  return {
    type: "removeLastPattern",
    song, gestureId,
    coalesceKey: `addpat:${song}`,
    apply(doc) {
      const removed = doc.songs[song].patterns.pop();
      const bytes = new Uint8Array(512);
      for (let r = 0; r < 64; r++) {
        for (let b = 0; b < 8; b++) bytes[r * 8 + b] = removed[r].getByte(b);
      }
      doc.dirty = true;
      return appendPatternOp(song, bytes, gestureId);
    },
    // post-apply: the removed index (patternBytes serves an empty image for
    // it, so the sync flush blanks the worklet's copy)
    dirty: (doc) => [{ kind: "pattern", song, pat: doc.songs[song].patterns.length }],
  };
}

/** Bulk note edit driven by a mutator: `fn(songObj)` changes cell notes and
 *  returns [{pat, row, prev}] (the retuneAllPatterns contract). Transpose
 *  uses this; the inverse is a plain note restore. */
export function bulkNotesOp(song, fn, gestureId = null) {
  return {
    type: "bulkNotes",
    song, gestureId,
    coalesceKey: `bulknotes:${song}`,
    apply(doc) {
      this._changes = fn(doc.songs[song]);
      doc.dirty = true;
      return restoreNotesOp(song, this._changes, gestureId);
    },
    dirty(doc) {
      const pats = new Set((this._changes ?? []).map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Bulk note restore (the inverse of a retune): sets each {pat,row} note back. */
export function restoreNotesOp(song, changes, gestureId = null) {
  return {
    type: "restoreNotes",
    song, changes, gestureId,
    coalesceKey: `retune:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const inverse = [];
      for (const c of changes) {
        const cell = s.patterns[c.pat][c.row];
        inverse.push({ pat: c.pat, row: c.row, prev: cell.note });
        cell.note = c.prev;
      }
      doc.dirty = true;
      return restoreNotesOp(song, inverse, gestureId);
    },
    dirty(doc) {
      const pats = new Set(changes.map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Retune every pattern note to a new pitch table (nearest-pitch snap). */
export function retuneOp(song, newPreset, percSlots, retuneFn, gestureId = null) {
  return {
    type: "retune",
    song, gestureId,
    coalesceKey: `retune:${song}`,
    apply(doc) {
      const changes = retuneFn(doc.songs[song], newPreset, percSlots);
      this._changes = changes;
      doc.dirty = true;
      return restoreNotesOp(song, changes, gestureId);
    },
    dirty(doc) {
      const pats = new Set((this._changes ?? []).map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Import instruments from another bank (bankmerge.planImport plan). The
 *  inverse is a full snapshot swap of everything the plan touches (pool
 *  spans, inst records, ixmp list, INam/SNam/Ixmp sections) — capture is
 *  cheap because only the touched spans/slots are stored. Dirty {kind:"bank"}
 *  → DocSync re-uploads the whole image + patch blobs. */
export function importBankOp(plan, gestureId = null) {
  return {
    type: "importBank",
    plan, gestureId,
    coalesceKey: "importBank",
    apply(doc) {
      const prev = captureBankState(doc, plan);
      applyPlan(doc, plan);
      return restoreBankSnapshotOp(plan, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

function restoreBankSnapshotOp(plan, state, gestureId) {
  return {
    type: "restoreBankSnapshot",
    plan, state, gestureId,
    coalesceKey: "importBank",
    apply(doc) {
      const prev = captureBankState(doc, plan);
      restoreBankState(doc, state);
      return restoreBankSnapshotOp(plan, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/** Overwrite a sample-pool span (sample editor DSP ops). The inverse restores
 *  the previous bytes; dirty {kind:"bank"} re-uploads the image, so playback
 *  hears the edit immediately. */
export function setSampleBytesOp(ptr, bytes, gestureId = null) {
  return {
    type: "setSampleBytes",
    ptr, bytes, gestureId,
    coalesceKey: `smpbytes:${ptr}:${bytes.length}`,
    apply(doc) {
      const prev = Uint8Array.from(doc.sampleBin.subarray(ptr, ptr + bytes.length));
      doc.sampleBin.set(bytes, ptr);
      doc.dirty = true;
      return setSampleBytesOp(ptr, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/** Raw record bytes across SEVERAL instruments in one undo step — the sample
 *  editor writes shared loop/play fields to every base-instrument user of a
 *  sample at once. edits = [{slot, pairs: [[offset, byte], …]}]. */
export function multiInstBytesOp(edits, gestureId = null) {
  return {
    type: "multiInstBytes",
    edits, gestureId,
    coalesceKey: `minst:${edits.map((e) => e.slot).join(",")}:${edits[0]?.pairs.map((p) => p[0]).join(",") ?? ""}`,
    apply(doc) {
      const inverse = edits.map(({ slot, pairs }) => {
        const inst = doc.instruments[slot & 0x3ff];
        const prev = pairs.map(([o]) => [o, inst.getByteNormal(o)]);
        for (const [o, b] of pairs) inst.setByte(o, b & 0xff);
        doc.markInstUsed(slot);
        return { slot, pairs: prev };
      });
      doc.dirty = true;
      return multiInstBytesOp(inverse, gestureId);
    },
    dirty: () => edits.map(({ slot }) => ({ kind: "inst", slot })),
  };
}

/** Replace a Project-Data section payload (name tables: SNam/INam/PNam) as one
 *  invertible step. `payload` null removes the section; the inverse restores
 *  the exact previous payload (or removes it if there was none). Dirty
 *  {kind:"section"} has no device effect (names are cosmetic) — DocSync
 *  ignores it, but the edit/undo/dirty flow still fires. */
export function setSectionOp(fourcc, payload, gestureId = null) {
  return {
    type: "setSection",
    fourcc, payload, gestureId,
    coalesceKey: `section:${fourcc}`,
    apply(doc) {
      const i = doc.projSections.findIndex((s) => s.fourcc === fourcc);
      const prev = i >= 0 ? doc.projSections[i].payload : null;
      doc.setSection(fourcc, payload);
      doc.dirty = true;
      return setSectionOp(fourcc, prev, gestureId);
    },
    dirty: () => [{ kind: "section", fourcc }],
  };
}

/** Song-scope scalar (bpm, tickRate, globalVolume, mixingVolume, globalFlags, …). */
export function setSongScalarOp(song, key, value, gestureId = null) {
  return {
    type: "setSongScalar",
    song, key, value, gestureId,
    coalesceKey: `scalar:${song}:${key}`,
    apply(doc) {
      const s = doc.songs[song];
      const prev = s[key];
      s[key] = value;
      doc.dirty = true;
      return setSongScalarOp(song, key, prev, gestureId);
    },
    dirty: () => [{ kind: "scalar", song, key }],
  };
}
