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
