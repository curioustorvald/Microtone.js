// Effect-column dispatch — port of AudioAdapter.kt resolveArg (3214),
// applyEffectRow (3216), applySEffect (3538), forEachEnvTarget (3633),
// applyFilterParamEffect (3650), applyRetrigVolMod (4090).
// Behavioural contract: TAUD_NOTE_EFFECTS.md; implementation truth: the Kotlin.

import { NUM_CUES, INTERP_A500, INTERP_A1200 } from "./constants.js";
import {
  EffectOp, FINETUNE_OFFSET,
  amigaSlideOnce, linearFreqSlideOnce, clamp,
} from "./tables.js";
import { computePlaybackRate } from "./sampler.js";
import { applyPastNoteAction } from "./trigger.js";

/** Resolve a non-zero argument or recall from cohort memory. */
export function resolveArg(arg, mem) { return arg !== 0 ? arg : mem; }

export function applyEffectRow(eng, ts, playhead, voice, vi, op, rawArg) {
  switch (op) {
    case EffectOp.OP_NONE: break;
    case EffectOp.OP_7:
      // Pattern Ditto marker — consumed by applyTrackerRow's row-time expansion.
      break;
    case EffectOp.OP_1: {
      // 1 $xx00 — Global behaviour flags in the high byte.
      const flags = rawArg >>> 8;
      playhead.updateTrackerGlobalBehaviour(flags);
      break;
    }
    case EffectOp.OP_5: applyFilterParamEffect(eng, ts, voice, vi, rawArg, false); break;
    case EffectOp.OP_6: applyFilterParamEffect(eng, ts, voice, vi, rawArg, true); break;
    case EffectOp.OP_8: {
      // 8 $xyzz — Bitcrusher: x = clip mode, y = bit depth, zz = sample-skip.
      const x = (rawArg >>> 12) & 0xf;
      const y = (rawArg >>> 8) & 0xf;
      const z = rawArg & 0xff;
      voice.clipMode = x & 3;
      if (rawArg === 0) {
        voice.bitcrusherDepth = 0;
        voice.bitcrusherSkip = 0;
        voice.bitcrusherCounter = 0;
      } else if (y === 0 && z === 0) {
        // x000 — clip mode only.
      } else {
        voice.bitcrusherDepth = y;
        voice.bitcrusherSkip = z;
        voice.bitcrusherCounter = 0;
      }
      break;
    }
    case EffectOp.OP_9: {
      // 9 $x0zz — Overdrive: x = clip mode, zz = amplification index.
      const x = (rawArg >>> 12) & 0xf;
      const z = rawArg & 0xff;
      voice.clipMode = x & 3;
      if (rawArg === 0) voice.overdriveAmp = 0;
      else if (z !== 0) voice.overdriveAmp = z;
      break;
    }
    case EffectOp.OP_A: {
      const tr = (rawArg >>> 8) & 0xff;
      if (tr !== 0) playhead.tickRate = tr;
      break;
    }
    case EffectOp.OP_B:
      if (ts.pendingOrderJump < 0) ts.pendingOrderJump = clamp(rawArg, 0, NUM_CUES - 1);
      break;
    case EffectOp.OP_C:
      if (ts.pendingRowJump < 0) ts.pendingRowJump = clamp(rawArg, 0, 63);
      break;
    case EffectOp.OP_D: {
      // Per-note volume slide: fine forms at tick 0, coarse arms slideMode 5.
      const arg = resolveArg(rawArg, voice.mem.d);
      if (rawArg !== 0) voice.mem.d = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) {
        voice.noteVolume = Math.min(voice.noteVolume + 0xf, 0x3f); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0xf && lo !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - lo, 0); voice.rowVolume = voice.noteVolume;
      } else if (lo === 0xf && hin !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + hin, 0x3f); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0 && lo !== 0) {
        voice.slideMode = 5; voice.slideArg = -lo;
      } else if (lo === 0 && hin !== 0) {
        voice.slideMode = 5; voice.slideArg = hin;
      }
      break;
    }
    case EffectOp.OP_E: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, -mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, -mag);
        else nv = voice.noteVal - mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal);
      } else {
        voice.slideMode = 1; voice.slideArg = -arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_F: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, mag);
        else nv = voice.noteVal + mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal);
      } else {
        voice.slideMode = 2; voice.slideArg = arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_G: {
      const arg = resolveArg(rawArg, voice.mem.g);
      if (rawArg !== 0) voice.mem.g = arg;
      voice.tonePortaSpeed = arg;
      break;
    }
    case EffectOp.OP_H: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      break;
    }
    case EffectOp.OP_I: {
      const arg = resolveArg(rawArg, voice.mem.i);
      if (rawArg !== 0) voice.mem.i = arg;
      voice.tremorOn = 1;
      voice.tremorOnTime = ((arg >>> 8) & 0xff) + 1;
      voice.tremorOffTime = (arg & 0xff) + 1;
      break;
    }
    case EffectOp.OP_J: {
      const arg = resolveArg(rawArg, voice.mem.j);
      if (rawArg !== 0) voice.mem.j = arg;
      voice.arpActive = true;
      voice.arpOff1 = (arg >>> 8) & 0xff;
      voice.arpOff2 = arg & 0xff;
      break;
    }
    case EffectOp.OP_K: {
      // K $xy00 — vibrato continuation + volume slide (down wins, ST3 quirk).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.k = raw) : voice.mem.k;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_L: {
      // L $xy00 — tone-porta continuation + volume slide (porta speed from G's memory).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.l = raw) : voice.mem.l;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.tonePortaSpeed = voice.mem.g;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_M:
      // M $xx00 — set channel volume (literal, no recall; IT $40 clamps to $3F).
      voice.channelVolume = Math.min((rawArg >>> 8) & 0xff, 0x3f);
      break;
    case EffectOp.OP_N: {
      // N $xy00 — channel-volume slide (D nibble decoding, channel axis only).
      const arg = resolveArg(rawArg, voice.mem.n);
      if (rawArg !== 0) voice.mem.n = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) voice.channelVolume = Math.min(voice.channelVolume + 0xf, 0x3f);
      else if (hin === 0xf && lo !== 0) voice.channelVolume = Math.max(voice.channelVolume - lo, 0);
      else if (lo === 0xf && hin !== 0) voice.channelVolume = Math.min(voice.channelVolume + hin, 0x3f);
      else if (hin === 0 && lo !== 0) voice.nSlideDir = -lo;
      else if (lo === 0 && hin !== 0) voice.nSlideDir = hin;
      break;
    }
    case EffectOp.OP_P: {
      // P $xy00 — channel-panning slide (IT convention: low nibble right, high left).
      const arg = resolveArg(rawArg, voice.mem.p);
      if (rawArg !== 0) voice.mem.p = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) {
        voice.channelPan = Math.max(voice.channelPan - 0xf, 0);
        voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
      } else if (hin === 0xf && lo !== 0) {
        voice.channelPan = Math.min(voice.channelPan + lo, 0xff);
        voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
      } else if (lo === 0xf && hin !== 0) {
        voice.channelPan = Math.max(voice.channelPan - hin, 0);
        voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
      } else if (hin === 0 && lo !== 0) {
        voice.panColSlideRight = lo;
      } else if (lo === 0 && hin !== 0) {
        voice.panColSlideLeft = hin;
      }
      break;
    }
    case EffectOp.OP_O: {
      // Sample offset — clamps into the active sample's loop region.
      const arg = resolveArg(rawArg, voice.mem.o);
      if (rawArg !== 0) voice.mem.o = arg;
      let off = arg;
      if ((voice.activeLoopMode & 3) !== 0 &&
          voice.activeSampleLoopEnd > voice.activeSampleLoopStart &&
          off > voice.activeSampleLoopEnd) {
        const loopLen = Math.max(voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1);
        off = voice.activeSampleLoopStart + ((off - voice.activeSampleLoopStart) % loopLen);
      }
      voice.samplePos = off;
      break;
    }
    case EffectOp.OP_Q: {
      const arg = resolveArg(rawArg, voice.mem.q);
      const y = arg & 0xff;
      if (y !== 0) {
        voice.mem.q = arg;
        voice.retrigInterval = y;
        voice.retrigVolMod = (arg >>> 8) & 0xf;
        voice.retrigActive = true;
        // Counter persists across rows per spec.
      }
      // y == 0 → entire effect ignored, even memory.
      break;
    }
    case EffectOp.OP_R: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.rSpeed = sp;
      if (dp !== 0) voice.mem.rDepth = dp;
      voice.tremoloActive = true;
      break;
    }
    case EffectOp.OP_S: applySEffect(eng, ts, voice, vi, rawArg); break;
    case EffectOp.OP_T: {
      const hi = (rawArg >>> 8) & 0xff;
      if (hi === 0xff) {
        // T $FFxx — extended set-tempo: BPM = $xx + $118 (280..535).
        playhead.bpm = clamp((rawArg & 0xff) + 0x118, 25, 535);
      } else if (hi !== 0) {
        // T $xx00 — set-tempo: BPM = $xx + $19 (25..280).
        playhead.bpm = clamp(hi + 0x19, 25, 535);
      } else {
        const low = rawArg & 0xff;
        switch (low & 0xf0) {
          case 0x00: voice.tempoSlideDir = -1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
          case 0x10: voice.tempoSlideDir = +1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
        }
      }
      break;
    }
    case EffectOp.OP_U: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 8;
      break;
    }
    case EffectOp.OP_V:
      playhead.globalVolume = (rawArg >>> 8) & 0xff;
      break;
    case EffectOp.OP_W: {
      const arg = resolveArg(rawArg, voice.mem.w);
      if (rawArg !== 0) voice.mem.w = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff) playhead.globalVolume = Math.min(playhead.globalVolume + 0xf, 0xff);
      else if (hin === 0xf && lo !== 0) playhead.globalVolume = Math.max(playhead.globalVolume - lo, 0);
      else if (lo === 0xf && hin !== 0) playhead.globalVolume = Math.min(playhead.globalVolume + hin, 0xff);
      else if (hin === 0 && lo !== 0) { voice.wSlideDir = -1; voice.wSlideAmount = lo; }
      else if (lo === 0 && hin !== 0) { voice.wSlideDir = +1; voice.wSlideAmount = hin; }
      break;
    }
    case EffectOp.OP_Y: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.ySpeed = sp;
      if (dp !== 0) voice.mem.yDepth = dp;
      voice.panbrelloActive = true;
      break;
    }
  }
}

export function applySEffect(eng, ts, voice, vi, arg) {
  const sub = (arg >>> 12) & 0xf;
  const x = (arg >>> 8) & 0xf;
  switch (sub) {
    case 0x0:
      // S $0000 = LED filter on, S $0100 = off (PT E00/E01); Amiga modes only.
      if (ts.interpolationMode === INTERP_A500 || ts.interpolationMode === INTERP_A1200) {
        ts.ledFilterOn = x === 0;
      }
      break;
    case 0x1: voice.glissandoOn = x !== 0; break;
    case 0x2:
      voice.noteVal = clamp(voice.noteVal + FINETUNE_OFFSET[x], 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
      voice.amigaPeriod = -1.0;
      voice.linearFreq = -1.0;
      voice.playbackRate = computePlaybackRate(voice, voice.noteVal);
      break;
    case 0x3: voice.vibratoWave = x & 3; voice.vibratoRetrig = (x & 4) === 0; break;
    case 0x4: voice.tremoloWave = x & 3; voice.tremoloRetrig = (x & 4) === 0; break;
    case 0x5: voice.panbrelloWave = x & 3; voice.panbrelloRetrig = (x & 4) === 0; break;
    case 0x6: ts.finePatternDelayExtra += x; break;
    case 0x7: {
      // S$7x — Note/Instrument actions. $0..$6 are no-ops on a metainstrument;
      // $7..$E fan out across the meta's constituents (forEachEnvTarget).
      const isMeta = voice.metaForeground;
      switch (x) {
        case 0x0: if (!isMeta) applyPastNoteAction(eng, ts, vi, 0); break;
        case 0x1: if (!isMeta) applyPastNoteAction(eng, ts, vi, 1); break;
        case 0x2: if (!isMeta) applyPastNoteAction(eng, ts, vi, 2); break;
        case 0x3: if (!isMeta) voice.nnaOverride = 1; break; // NNA Note Cut
        case 0x4: if (!isMeta) voice.nnaOverride = 2; break; // NNA Note Continue
        case 0x5: if (!isMeta) voice.nnaOverride = 0; break; // NNA Note Off
        case 0x6: if (!isMeta) voice.nnaOverride = 3; break; // NNA Note Fade
        case 0x7: forEachEnvTarget(ts, voice, vi, (v) => { v.volEnvOn = false; }); break;
        case 0x8: forEachEnvTarget(ts, voice, vi, (v) => { v.volEnvOn = true; }); break;
        case 0x9: forEachEnvTarget(ts, voice, vi, (v) => { v.panEnvOn = false; }); break;
        case 0xa: forEachEnvTarget(ts, voice, vi, (v) => { v.panEnvOn = true; }); break;
        // $B/$C: pitch env when defined, else filter env (IT "pitch or filter").
        case 0xb: forEachEnvTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = false; else if (v.hasFilterEnv) v.filterEnvOn = false;
        }); break;
        case 0xc: forEachEnvTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = true; else if (v.hasFilterEnv) v.filterEnvOn = true;
        }); break;
        case 0xd: forEachEnvTarget(ts, voice, vi, (v) => { v.filterEnvOn = false; }); break;
        case 0xe: forEachEnvTarget(ts, voice, vi, (v) => { v.filterEnvOn = true; }); break;
      }
      break;
    }
    case 0x8:
      // S$80xx — full 8-bit pan.
      voice.channelPan = arg & 0xff;
      voice.rowPan = clamp(voice.channelPan >> 2, 0, 63);
      break;
    case 0xb:
      if (x === 0) voice.loopStartRow = ts.rowIndex;
      else {
        if (voice.loopCount === 0) {
          voice.loopCount = x;
          ts.pendingRowJump = voice.loopStartRow;
          ts.pendingRowJumpLocal = true;
        } else if (!ts.patternDelayActive) {
          voice.loopCount--;
          if (voice.loopCount > 0) {
            ts.pendingRowJump = voice.loopStartRow;
            ts.pendingRowJumpLocal = true;
          }
        }
      }
      break;
    case 0xc: if (x !== 0) voice.cutAtTick = x; break;
    case 0xd: break; // note delay — handled in the row's note section
    case 0xe:
      // Pattern delay — first SEx in ascending channel order wins.
      if (ts.sexWinningChannel < 0) {
        ts.sexWinningChannel = vi;
        ts.patternDelayRemaining = x;
      }
      break;
    case 0xf:
      voice.funkSpeed = arg & 0xff;
      if (x === 0) voice.funkAccumulator = 0;
      break;
  }
}

/** Apply an env toggle to the foreground voice + (for a meta) its layer children. */
export function forEachEnvTarget(ts, voice, vi, action) {
  action(voice);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) action(bg);
  }
}

/**
 * notefx 5 (cutoff) / 6 (resonance) — instrument-wide filter parameter control.
 * $FFFF clears the override; IT mode takes the high byte, SF mode the full 16 bits.
 */
export function applyFilterParamEffect(eng, ts, voice, vi, rawArg, isResonance) {
  const targets = new Set();
  targets.add(voice.instrumentId);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) targets.add(bg.instrumentId);
  }

  for (const id of targets) {
    const ti = eng.instruments[id];
    let value;
    if (rawArg === 0xffff) value = -1;
    else if (ti.filterSfMode) value = rawArg & 0xffff;
    else value = (rawArg >>> 8) & 0xff;
    if (isResonance) ti.resonanceOverride = value;
    else ti.cutoffOverride = value;
  }

  const push = (v) => {
    if (!targets.has(v.instrumentId)) return;
    const ti = eng.instruments[v.instrumentId];
    v.filterSfMode = ti.filterSfMode;
    if (isResonance) {
      v.activeDefaultResonance = ti.defaultResonance16;
      v.currentResonance = v.activeDefaultResonance;
    } else {
      v.activeDefaultCutoff = ti.defaultCutoff16;
      v.currentCutoff = v.activeDefaultCutoff;
    }
    v.filterCutoffCached = -1;
    v.filterResonanceCached = -1;
  };
  for (const v of ts.voices) if (v.active) push(v);
  for (const bg of ts.backgroundVoices) if (bg.active) push(bg);
}

export function applyRetrigVolMod(vol, x) {
  let v;
  switch (x & 0xf) {
    case 0: case 8: v = vol; break;
    case 1: v = vol - 0x01; break;
    case 2: v = vol - 0x02; break;
    case 3: v = vol - 0x04; break;
    case 4: v = vol - 0x08; break;
    case 5: v = vol - 0x10; break;
    case 6: v = Math.trunc((vol * 2) / 3); break;
    case 7: v = vol >> 1; break;
    case 9: v = vol + 0x01; break;
    case 0xa: v = vol + 0x02; break;
    case 0xb: v = vol + 0x04; break;
    case 0xc: v = vol + 0x08; break;
    case 0xd: v = vol + 0x10; break;
    case 0xe: v = Math.trunc((vol * 3) / 2); break;
    case 0xf: v = vol << 1; break;
    default: v = vol; break;
  }
  return clamp(v, 0, 0x3f);
}
