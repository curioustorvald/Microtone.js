// Row processing + cue advance — port of AudioAdapter.kt applyTrackerRow (2948),
// advanceTrackerCue (4101), resetPatternLoopState (4117), advanceRow (4343).

import { PATTERN_EMPTY, NUM_PATTERNS, NUM_CUES } from "./constants.js";
import { EffectOp, clamp } from "./tables.js";
import { TaudPlayData, INST_GOBACK, INST_SKIP, INST_JUMP } from "./state.js";
import {
  triggerMetaOrNote, applyDuplicateCheck, maybeSpawnBackgroundForNNA,
  cutLayerChildren, applyVolColumn, applyPanColumn,
} from "./trigger.js";
import { applyKeyLift } from "./envelope.js";
import { startFastFade } from "./sampler.js";
import { applyEffectRow } from "./effects.js";

export function applyTrackerRow(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  // Reset row-scope state before scanning channels.
  if (!ts.patternDelayActive) ts.sexWinningChannel = -1;
  ts.finePatternDelayExtra = 0;

  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rawRow = eng.patternRead(patIdx)[ts.rowIndex];
    const voice = ts.voices[vi];

    // ── Pattern Ditto (effect 7) row-time expansion ──
    const n = ts.rowIndex;
    const isArmer = rawRow.effect === EffectOp.OP_7 && rawRow.effectArg !== 0;
    if (isArmer) {
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        const patLen = cue.rowLimit();
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave previously-armed ditto state alone.
    }

    const dittoArmRow = voice.dittoSourceStart + voice.dittoLength;
    let row;
    if (voice.dittoActive && n >= dittoArmRow && n <= voice.dittoEndRow) {
      const rel = (n - voice.dittoSourceStart) % voice.dittoLength;
      const srcRow = voice.dittoSourceStart + rel;
      const src = eng.patternRead(patIdx)[srcRow];

      // Vol-/pan-column "no-op" sentinel is SEL_FINE (3) with value 0.
      const volIsSet = !(rawRow.volumeEff === 3 && rawRow.volume === 0);
      const panIsSet = !(rawRow.panEff === 3 && rawRow.pan === 0);

      const destOp = isArmer ? 0 : rawRow.effect;
      const destArg = isArmer ? 0 : rawRow.effectArg;
      let effOp, effArg;
      if (destOp !== 0) { effOp = destOp; effArg = destArg; }
      else if (src.effect !== EffectOp.OP_7) { effOp = src.effect; effArg = src.effectArg; }
      else { effOp = 0; effArg = 0; }

      row = new TaudPlayData();
      row.note = rawRow.note !== 0x0000 ? rawRow.note : src.note;
      row.instrment = rawRow.instrment !== 0 ? rawRow.instrment : src.instrment;
      row.volume = volIsSet ? rawRow.volume : src.volume;
      row.volumeEff = volIsSet ? rawRow.volumeEff : src.volumeEff;
      row.pan = panIsSet ? rawRow.pan : src.pan;
      row.panEff = panIsSet ? rawRow.panEff : src.panEff;
      row.effect = effOp;
      row.effectArg = effArg;
    } else {
      row = rawRow;
    }

    // Reset per-row transient state.
    voice.cutAtTick = -1;
    voice.noteDelayTick = -1;
    voice.slideMode = 0;
    voice.slideArg = 0;
    voice.arpActive = false;
    voice.tremorOn = 0;
    voice.vibratoActive = false;
    voice.tremoloActive = false;
    voice.panbrelloActive = false;
    voice.retrigActive = false;
    voice.tempoSlideDir = 0;
    voice.wSlideDir = 0;
    voice.volColSlideUp = 0; voice.volColSlideDown = 0;
    voice.panColSlideRight = 0; voice.panColSlideLeft = 0;
    voice.nSlideDir = 0;
    voice.rowEffect = row.effect;
    voice.rowEffectArg = row.effectArg;
    // Row boundary: rebase rowVolume to the persistent noteVolume.
    voice.rowVolume = voice.noteVolume;

    // ── Note ──
    // OP_L also takes a porta target without retriggering (continues a G porta).
    const toneG = row.effect === EffectOp.OP_G || row.effect === EffectOp.OP_L;
    const note = row.note;
    const sDelayTick = row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd
      ? (row.effectArg >>> 8) & 0xf : 0;

    if (note === 0x0000) {
      const pitchFx = row.effect === EffectOp.OP_E || row.effect === EffectOp.OP_F ||
        row.effect === EffectOp.OP_G;
      if (row.instrment !== 0 && pitchFx && voice.noteVal >= 0x20) {
        // Note 0 + instrument + a pitch effect (E porta-down / F porta-up /
        // G tone-porta) TRIGGERS the note at the voice's current pitch, so the
        // slide has a sounding note to move — previously this only latched the
        // instrument and stayed silent (item 43; needs the same TSVM fix).
        applyDuplicateCheck(eng, ts, vi, row.instrment, voice.noteVal);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, voice.noteVal, row.instrment, trigVol);
      } else if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
        // No note + instrument byte: latch instrument, re-seed from its DNV
        // (PT/FT2/IT/Schism all do this; see AudioAdapter.kt:3050-3061).
        voice.instrumentId = row.instrment;
        const newInst = eng.instruments[voice.instrumentId];
        const newPatch = newInst.resolvePatch(voice.noteVal, voice.noteVolume);
        // applyActiveSample without retrigger (Schism csf_instrument_change).
        applyInstrumentChange(eng, voice, newInst, newPatch);
      }
    } else if (note === 0x0001) {
      // Key-off (sub-row delay via S$Dx defers it).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0001;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.keyOff = true;
        applyKeyLift(voice, eng.instruments[voice.instrumentId]);
      }
    } else if (note === 0x0002) {
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0002;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.active = false;
        cutLayerChildren(ts, vi);
      }
    } else if (note === 0x0004) {
      // Fast note-fade (SF2 exclusiveClass choke).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0004;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startFastFade(voice, playhead);
      }
    } else if (note === 0x0003) {
      // IT-style note fade: fadeout without sustain release.
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0003;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.noteFading = true;
      }
    } else if (note >= 0x0005 && note <= 0x000f) {
      // reserved sentinel range, no engine handler
    } else if (note >= 0x0010 && note <= 0x001f) {
      // Int0..IntF: latch the interrupt for the host to drain.
      ts.pendingInterrupts |= 1 << (note - 0x0010);
    } else {
      if (toneG && voice.active) {
        // Tone porta: target the note, do not retrigger sample.
        voice.tonePortaTarget = note;
        // Inst byte on a porta row reloads the default volume + clears fade state
        // without retriggering (Schism csf_instrument_change semantics).
        if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
          voice.instrumentId = row.instrment;
          const newInst = eng.instruments[voice.instrumentId];
          const newPatch = newInst.resolvePatch(voice.noteVal, voice.noteVolume);
          applyInstrumentChange(eng, voice, newInst, newPatch);
        }
      } else if (row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd) {
        // Note delay: defer trigger; NNA fires when the deferred trigger executes.
        voice.noteDelayTick = (row.effectArg >>> 8) & 0xf;
        voice.delayedNote = note;
        voice.delayedInst = row.instrment;
        // Only a SEL_SET vol cell is an override on the deferred trigger.
        voice.delayedVol = row.volumeEff === 0 ? row.volume : -1;
      } else {
        applyDuplicateCheck(eng, ts, vi, row.instrment, note);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, note, row.instrment, trigVol);
      }
    }

    // ── Volume / pan columns ──
    applyVolColumn(voice, row.volume, row.volumeEff);
    applyPanColumn(voice, row.pan, row.panEff);

    // ── Effect column ──
    applyEffectRow(eng, ts, playhead, voice, vi, row.effect, row.effectArg);
  }
}

// Shared "instrument byte without retrigger" path (no-note-inst and porta+inst rows).
import { applyActiveSample, rowVolumeFromDefault } from "./trigger.js";
function applyInstrumentChange(eng, voice, newInst, newPatch) {
  applyActiveSample(voice, newInst, newPatch);
  const seedVol = rowVolumeFromDefault(newInst, newPatch);
  voice.noteVolume = seedVol;
  voice.rowVolume = seedVol;
  voice.keyOff = false;
  voice.noteFading = false;
  voice.fadeoutVolume = 1.0;
}

export function advanceTrackerCue(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  if (cue.isHalt()) { playhead.isPlaying = false; return; }
  const instr = cue.flowInstruction();
  switch (instr.type) {
    case INST_GOBACK: ts.cuePos = Math.max(ts.cuePos - instr.arg, 0); break;
    case INST_SKIP: ts.cuePos = Math.min(ts.cuePos + instr.arg, NUM_CUES - 1); break;
    case INST_JUMP: ts.cuePos = clamp(instr.arg, 0, NUM_CUES - 1); break;
    default: ts.cuePos = Math.min(ts.cuePos + 1, NUM_CUES - 1); break;
  }
  playhead.position = ts.cuePos;
}

/**
 * Rebuild each voice's Pattern-Ditto (effect 7) arm state as if the current
 * cue's pattern had been played from row 0 up to (but NOT including) startRow.
 * This lets playback that STARTS mid-pattern on a ghosted (repeated) row still
 * sound it — the ghost cells are painted from the same static expansion but the
 * engine only re-derives them at play time once dittoActive is set on the
 * arming row, so seeking past the arm left the ghosts silent (item 81).
 *
 * Faithful mirror of the arm branch in applyTrackerRow (reads RAW rows only, so
 * cascaded/re-armed regions resolve exactly like the running engine); call it
 * right after the play-time voice reset in setTrackerRow. [needs the same TSVM
 * + taut.js fix].
 */
export function reconstructDittoState(eng, ts, startRow) {
  const cue = eng.cueSheet[ts.cuePos];
  const patLen = cue.rowLimit();
  const limit = Math.min(startRow, patLen);
  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const voice = ts.voices[vi];
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rows = eng.patternRead(patIdx);
    for (let n = 0; n < limit; n++) {
      const rawRow = rows[n];
      if (rawRow.effect !== EffectOp.OP_7 || rawRow.effectArg === 0) continue;
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave a previously-armed ditto alone.
    }
  }
}

/** Per-pattern voice state reset (S$Bx loop counters + ditto), on every cue advance. */
export function resetPatternLoopState(ts) {
  for (const voice of ts.voices) {
    voice.loopStartRow = 0;
    voice.loopCount = 0;
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
  }
}

/**
 * Advance to the next row: resolves pending B/C jumps and pattern-delay repeats.
 * Called once when tickInRow has just wrapped past tickRate.
 */
export function advanceRow(eng, ts, playhead) {
  // Pattern delay (S$Ex): replay the same row patternDelayRemaining more times.
  if (ts.patternDelayRemaining > 0) {
    ts.patternDelayRemaining--;
    ts.patternDelayActive = true;
    applyTrackerRow(eng, ts, playhead);
    return;
  }
  ts.patternDelayActive = false;

  const pendingB = ts.pendingOrderJump;
  const pendingC = ts.pendingRowJump;
  const pendingLocal = ts.pendingRowJumpLocal;
  ts.pendingOrderJump = -1;
  ts.pendingRowJump = -1;
  ts.pendingRowJumpLocal = false;

  if (pendingB >= 0) {
    ts.cuePos = Math.min(pendingB, NUM_CUES - 1);
    ts.rowIndex = pendingC >= 0 ? pendingC : 0;
    playhead.position = ts.cuePos;
    resetPatternLoopState(ts);
  } else if (pendingC >= 0 && pendingLocal) {
    // S$Bx pattern loop — stay in the current cue, rewind the row.
    ts.rowIndex = clamp(pendingC, 0, 63);
  } else if (pendingC >= 0) {
    // C$xx pattern break — advance cue then jump to row.
    advanceTrackerCue(eng, ts, playhead);
    ts.rowIndex = clamp(pendingC, 0, 63);
    resetPatternLoopState(ts);
  } else {
    ts.rowIndex++;
    // LEN / "halt at x" shorten the effective row count.
    const rowLimit = eng.cueSheet[ts.cuePos].rowLimit();
    if (ts.rowIndex >= rowLimit) {
      ts.rowIndex = 0;
      advanceTrackerCue(eng, ts, playhead);
      resetPatternLoopState(ts);
    }
  }
  applyTrackerRow(eng, ts, playhead);
}
