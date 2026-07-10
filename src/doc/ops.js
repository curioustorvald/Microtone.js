// Invertible document operations. Every mutation is an op object
// {type, ..., apply(doc) → inverseOp, dirty(doc) → [tags]}; undo.js stacks the
// inverses, sync.js consumes the dirty tags. Gesture coalescing is keyed by
// op.coalesceKey (same key + same gestureId collapse in the undo stack).
//
// Dirty tags: {kind:"pattern", song, pat} | {kind:"cue", song, cue}
//           | {kind:"scalar", song, key}

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
