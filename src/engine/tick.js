// Per-tick voice processing — port of AudioAdapter.kt applyTrackerTick (3689-4087).
//
// CRITICAL: after a mid-tick note-delay trigger (S$Dx) fires, the local `inst`
// binding MUST be re-fetched — triggerNote may have swapped the voice's
// instrument, and the rest of the tick (playback-rate recompute, envelopes,
// fadeout) must see the instrument that just fired (AudioAdapter.kt:3727-3733).

import { SAMPLING_RATE } from "./constants.js";
import {
  lfoSample, amigaSlideTick, linearFreqSlideTick, noteValToFreqHz, freqHzToNoteVal,
  clamp,
} from "./tables.js";
import { computePlaybackRate, startFastFade } from "./sampler.js";
import { refreshVoiceFilter } from "./filter.js";
import {
  advanceEnvelope, advancePitchEnvelope, advanceFilterEnvelope,
  advanceAutoVibrato, applyKeyLift, seedPfRole, pfIdxBox, pfTimeBox,
} from "./envelope.js";
import {
  triggerMetaOrNote, applyDuplicateCheck, maybeSpawnBackgroundForNNA, cutLayerChildren,
} from "./trigger.js";
import { applyRetrigVolMod } from "./effects.js";

export function applyTrackerTick(eng, ts, playhead) {
  const tickSec = 2.5 / playhead.bpm;
  // Samples-per-tick — used to spread the per-tick envVolume jump across the
  // upcoming tick interval. Recomputed every tick (BPM can change mid-row).
  const spt = SAMPLING_RATE * tickSec;
  for (let vi = 0; vi < ts.voices.length; vi++) {
    const voice = ts.voices[vi];
    if (!voice.active && voice.noteDelayTick < 0) continue;
    let inst = eng.instruments[voice.instrumentId];

    // Note cut: zero noteVolume/rowVolume, leave channelVolume alone.
    if (voice.cutAtTick === ts.tickInRow) {
      voice.noteVolume = 0;
      voice.rowVolume = 0;
      voice.noteWasCut = true;
    }

    // Note delay — fire the deferred event when the requested tick arrives.
    if (voice.noteDelayTick === ts.tickInRow) {
      switch (voice.delayedNote) {
        case 0x0001: // delayed KEY_OFF
          voice.keyOff = true;
          applyKeyLift(voice, eng.instruments[voice.instrumentId]);
          break;
        case 0x0002: // delayed note cut
          voice.active = false;
          cutLayerChildren(ts, vi);
          break;
        case 0x0003: // delayed note fade
          voice.noteFading = true;
          break;
        case 0x0004: // delayed fast fade
          startFastFade(voice, playhead);
          break;
        default:
          applyDuplicateCheck(eng, ts, vi, voice.delayedInst, voice.delayedNote);
          maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
          triggerMetaOrNote(eng, ts, voice, vi, voice.delayedNote, voice.delayedInst, voice.delayedVol);
          break;
      }
      voice.noteDelayTick = -1;
      // Re-bind: triggerNote may have swapped in a new instrument (see header note).
      inst = eng.instruments[voice.instrumentId];
    }

    if (!voice.active) {
      advanceEnvelope(voice, tickSec);
      voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
      continue;
    }

    // Pitch slides (E/F coarse on tick > 0).
    if (ts.tickInRow > 0 && (voice.slideMode === 1 || voice.slideMode === 2)) {
      let nv;
      if (ts.toneMode === 1) nv = amigaSlideTick(voice, voice.slideArg);
      else if (ts.toneMode === 2) nv = linearFreqSlideTick(voice, voice.slideArg);
      else nv = voice.noteVal + voice.slideArg;
      voice.noteVal = clamp(nv, 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
    }

    // Tone portamento (G).
    if (voice.tonePortaTarget >= 0 && ts.tickInRow > 0) {
      const target = voice.tonePortaTarget;
      const sp = voice.tonePortaSpeed;
      if (ts.toneMode === 2) {
        if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
        const targetFreq = noteValToFreqHz(target);
        const dir = targetFreq > voice.linearFreq ? +1.0 : -1.0;
        voice.linearFreq += dir * sp;
        if ((dir > 0 && voice.linearFreq >= targetFreq) ||
            (dir < 0 && voice.linearFreq <= targetFreq)) {
          voice.linearFreq = targetFreq;
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        } else {
          voice.noteVal = clamp(freqHzToNoteVal(voice.linearFreq), 0x20, 0xffff);
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
      } else {
        const delta = target > voice.noteVal ? sp : -sp;
        voice.noteVal += delta;
        if ((delta > 0 && voice.noteVal >= target) || (delta < 0 && voice.noteVal <= target)) {
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0; // porta works in linear noteVal space
        voice.linearFreq = -1.0;
      }
    }

    // Volume slides (D coarse on tick > 0).
    if (ts.tickInRow > 0 && voice.slideMode === 5) {
      voice.noteVolume = clamp(voice.noteVolume + voice.slideArg, 0, 0x3f);
      voice.rowVolume = voice.noteVolume;
    }

    // Vol-col slides (selectors 1/2) + N coarse slide + pan-col slides.
    if (ts.tickInRow > 0) {
      if (voice.volColSlideUp !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + voice.volColSlideUp, 0x3f);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.volColSlideDown !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - voice.volColSlideDown, 0);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.nSlideDir !== 0) {
        voice.channelVolume = clamp(voice.channelVolume + voice.nSlideDir, 0, 0x3f);
      }
      if (voice.panColSlideRight !== 0) {
        voice.channelPan = Math.min(voice.channelPan + voice.panColSlideRight, 0xff);
        voice.rowPan = clamp(voice.channelPan >> 2, 0, 63);
      }
      if (voice.panColSlideLeft !== 0) {
        voice.channelPan = Math.max(voice.channelPan - voice.panColSlideLeft, 0);
        voice.rowPan = clamp(voice.channelPan >> 2, 0, 63);
      }
    }

    // Tremor (I) — gates output volume.
    if (voice.tremorOn !== 0) {
      voice.tremorTickInPhase++;
      const limit = voice.tremorPhaseOn ? voice.tremorOnTime : voice.tremorOffTime;
      if (voice.tremorTickInPhase >= limit) {
        voice.tremorTickInPhase = 0;
        voice.tremorPhaseOn = !voice.tremorPhaseOn;
      }
      if (!voice.tremorPhaseOn) voice.rowVolume = 0;
    }

    // Vibrato (H/U) — base-pitch overlay.
    let pitchToMixer = voice.noteVal;
    if (voice.vibratoActive) {
      const sine = lfoSample(voice.vibratoLfoPos, voice.vibratoWave);
      const pitchDelta = (sine * voice.mem.huDepth) >> voice.vibratoFineShift;
      pitchToMixer = clamp(voice.noteVal + pitchDelta, 0x20, 0xffff);
      voice.vibratoLfoPos = (voice.vibratoLfoPos + voice.mem.huSpeed * 4) & 0xff;
    }

    // Glissando (S$1x) — snap pitchToMixer to nearest semitone (noteVal stays smooth).
    if (voice.glissandoOn) {
      const semis = Math.trunc((pitchToMixer * 12 + 2048) / 4096);
      pitchToMixer = clamp(Math.trunc((semis * 4096) / 12), 0x20, 0xffff);
    }

    // Tremolo (R) — modulates rowVolume around noteVolume (IT semantics).
    if (voice.tremoloActive) {
      const sine = lfoSample(voice.tremoloLfoPos, voice.tremoloWave);
      const volDelta = (sine * voice.mem.rDepth) >> 9;
      voice.rowVolume = clamp(voice.noteVolume + volDelta, 0, 0x3f);
      voice.tremoloLfoPos = (voice.tremoloLfoPos + voice.mem.rSpeed * 4) & 0xff;
    }

    // Panbrello (Y).
    if (voice.panbrelloActive) {
      const sine = lfoSample(voice.panbrelloLfoPos, voice.panbrelloWave);
      const panDelta = (sine * voice.mem.yDepth) >> 9;
      voice.rowPan = clamp((voice.channelPan >>> 2) + panDelta, 0, 0x3f);
      voice.panbrelloLfoPos = (voice.panbrelloLfoPos + voice.mem.ySpeed * 4) & 0xff;
    }

    // Arpeggio (J) — overrides pitchToMixer for this tick.
    if (voice.arpActive) {
      const voiceIdx = ts.tickInRow % 3;
      const arpDelta = voiceIdx === 1 ? voice.arpOff1 << 8 : voiceIdx === 2 ? voice.arpOff2 << 8 : 0;
      pitchToMixer = clamp(voice.basePitch + arpDelta, 0x20, 0xffff);
      voice.lastArpVoice = voiceIdx;
    }

    // Q retrigger.
    if (voice.retrigActive && !voice.noteWasCut) {
      voice.retrigCounter++;
      if (voice.retrigCounter >= voice.retrigInterval) {
        voice.retrigCounter = 0;
        voice.samplePos = voice.activeSamplePlayStart; // patch-aware
        voice.keyOff = false;
        voice.envIndex = 0; voice.envTimeSec = 0.0;
        voice.envPanIndex = 0; voice.envPanTimeSec = 0.0;
        voice.envPan = voice.activePanEnv[0].value / 255.0;
        // Re-seed pf-envs past leading zero-duration nodes (as at fresh trigger).
        if (voice.hasPitchEnv) {
          voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
            voice.activePitchEnvSustain);
          voice.envPitchIndex = pfIdxBox[0]; voice.envPitchTimeSec = pfTimeBox[0];
        } else {
          voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
        }
        if (voice.hasFilterEnv) {
          voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
            voice.activeFilterEnvSustain);
          voice.envFilterIndex = pfIdxBox[0]; voice.envFilterTimeSec = pfTimeBox[0];
        } else {
          voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
        }
        voice.fadeoutVolume = 1.0;
        voice.autoVibPhase = 0;
        voice.autoVibTicksSinceTrigger = 0;
        voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0;
        voice.noteVolume = applyRetrigVolMod(voice.noteVolume, voice.retrigVolMod);
        voice.rowVolume = voice.noteVolume;
      }
    }

    // Auto-vibrato — added on top of pitchToMixer.
    const autoVibDelta = advanceAutoVibrato(voice, inst);

    // Pitch envelope contribution (±16 semitones full-scale; Schism sndmix.c:455-462).
    const pitchEnvDelta = voice.hasPitchEnv && voice.pitchEnvOn
      ? Math.trunc(((voice.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;

    const finalPitch = clamp(pitchToMixer + autoVibDelta + pitchEnvDelta, 0x20, 0xffff);
    voice.playbackRate = computePlaybackRate(voice, finalPitch);

    // Filter envelope: currentCutoff = baseCut × envFilterValue (0.5 = unity at IFC).
    if (voice.hasFilterEnv && voice.filterEnvOn) {
      if (voice.filterSfMode) {
        const baseCut = voice.activeDefaultCutoff < 0xffff ? voice.activeDefaultCutoff : 13500;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = voice.activeDefaultCutoff < 255 ? voice.activeDefaultCutoff : 254;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 254);
      }
    }

    // Refresh filter coefficients once per tick (recomputes only when changed).
    refreshVoiceFilter(voice);

    // Volume fadeout: after key-off OR Note-Fade NNA, decrement per tick.
    if (voice.keyOff || voice.noteFading) {
      const fadeStep = voice.activeFadeoutStep;
      if (fadeStep > 0) {
        voice.fadeoutVolume = Math.max(voice.fadeoutVolume - fadeStep / 1024.0, 0.0);
        if (voice.fadeoutVolume <= 0.0) voice.active = false;
      }
    }

    advanceEnvelope(voice, tickSec);
    // Per-sample slope so envVolMix walks smoothly to the new envVolume.
    voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
    advancePitchEnvelope(voice, tickSec);
    advanceFilterEnvelope(voice, tickSec);
  }

  // Tempo slide — applied once per tick at the playhead level.
  for (const voice of ts.voices) {
    if (voice.tempoSlideDir !== 0 && ts.tickInRow > 0) {
      const tempoByte = clamp(
        playhead.bpm - 0x19 + voice.tempoSlideDir * voice.tempoSlideAmount, 0, 0xff);
      playhead.bpm = clamp(tempoByte + 0x19, 25, 280);
    }
  }

  // Global volume slide (W coarse) — once per non-first tick per armed channel.
  if (ts.tickInRow > 0) {
    for (const voice of ts.voices) {
      if (voice.wSlideDir !== 0) {
        playhead.globalVolume = clamp(
          playhead.globalVolume + voice.wSlideDir * voice.wSlideAmount, 0, 0xff);
      }
    }
  }

  // Funk repeat (S$Fx) — advance the per-instrument XOR mask (PT2 updateFunk).
  for (const voice of ts.voices) {
    if (voice.funkSpeed === 0 || !voice.active) continue;
    const inst = eng.instruments[voice.instrumentId];
    if (inst.sampleLoopEnd <= inst.sampleLoopStart) continue;
    voice.funkAccumulator += voice.funkSpeed;
    if (voice.funkAccumulator >= 0x80) {
      voice.funkAccumulator = 0;
      const loopLen = Math.max(inst.sampleLoopEnd - inst.sampleLoopStart, 1);
      voice.funkWritePos = (voice.funkWritePos + 1) % loopLen;
      inst.toggleFunkBit(voice.funkWritePos);
    }
  }

  // Background (NNA-ghost) voices: passive maintenance only.
  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (!bg.active) { ts.backgroundVoices.splice(i, 1); continue; }
    // Layer child: re-sync pitch / key-off / volume / pan from the parent each tick.
    if (bg.isLayerChild) {
      const parent = bg.sourceChannel >= 0 && bg.sourceChannel < ts.voices.length
        ? ts.voices[bg.sourceChannel] : null;
      if (parent === null || !parent.active) {
        // Parent ended. If it was RELEASED and its fast fadeout deactivated it in
        // the SAME tick the release fired, the sync below never ran — inherit the
        // release before detaching (the meta KEY_OFF race fix; AudioAdapter.kt:4020-4035).
        if (parent !== null && !bg.keyOff && !bg.noteFading) {
          if (parent.keyOff) {
            bg.keyOff = true;
            applyKeyLift(bg, eng.instruments[bg.instrumentId]);
          } else if (parent.noteFading) {
            bg.noteFading = true;
          }
        }
        bg.isLayerChild = false;
      } else {
        bg.noteVal = clamp(parent.noteVal + bg.layerRelDetune, 0x20, 0xffff);
        bg.basePitch = bg.noteVal;
        bg.amigaPeriod = -1.0;
        bg.linearFreq = -1.0;
        if (parent.keyOff && !bg.keyOff) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
        if (parent.noteFading && !bg.noteFading) bg.noteFading = true;
        bg.channelVolume = parent.channelVolume;
        bg.noteVolume = parent.noteVolume;
        bg.rowVolume = parent.rowVolume;
        bg.channelPan = parent.channelPan;
        bg.rowPan = parent.rowPan;
      }
    }
    const inst = eng.instruments[bg.instrumentId];
    advanceEnvelope(bg, tickSec);
    bg.envVolStep = spt > 0.0 ? (bg.envVolume - bg.envVolMix) / spt : 0.0;
    advancePitchEnvelope(bg, tickSec);
    advanceFilterEnvelope(bg, tickSec);
    if (bg.keyOff || bg.noteFading) {
      const fadeStep = bg.activeFadeoutStep;
      if (fadeStep > 0) {
        bg.fadeoutVolume = Math.max(bg.fadeoutVolume - fadeStep / 1024.0, 0.0);
      }
    }
    // Auto-vibrato keeps running on backgrounds.
    const autoVibDelta = advanceAutoVibrato(bg, inst);
    const pitchEnvDelta = bg.hasPitchEnv && bg.pitchEnvOn
      ? Math.trunc(((bg.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;
    const finalPitch = clamp(bg.noteVal + autoVibDelta + pitchEnvDelta, 0x20, 0xffff);
    bg.playbackRate = computePlaybackRate(bg, finalPitch);
    // Filter envelope — MUST branch on SF mode too (cents vs IT byte range).
    if (bg.hasFilterEnv && bg.filterEnvOn) {
      if (bg.filterSfMode) {
        const baseCut = bg.activeDefaultCutoff < 0xffff ? bg.activeDefaultCutoff : 13500;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = bg.activeDefaultCutoff < 255 ? bg.activeDefaultCutoff : 254;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 254);
      }
    }
    refreshVoiceFilter(bg);
    // Reap fully-faded ghosts.
    if ((bg.keyOff || bg.noteFading) && bg.fadeoutVolume <= 0.0) {
      bg.active = false;
      ts.backgroundVoices.splice(i, 1);
    }
  }
}
