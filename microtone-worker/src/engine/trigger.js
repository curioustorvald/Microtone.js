// Trigger path + NNA/Metainstrument machinery — port of AudioAdapter.kt
// applyActiveSample (1529), resolveActiveEnvelopes (1574), attenGainOf (1629),
// rowVolumeFromDefault (2413), capBackgroundVoices (2421), release/cutLayerChildren
// (2431/2445), triggerMetaOrNote (2469), triggerNote (2524), applyDuplicateCheck
// (2693), maybeSpawnBackgroundForNNA (2748), ghostVoice (2768),
// applyPastNoteAction (2887), applyVolColumn (2905), applyPanColumn (2927).

import { MAX_BG_VOICES } from "./constants.js";
import { Voice } from "./voice.js";
import { patchIsStereo } from "./inst.js";
import { META_MIX_GAIN, attenGainOf, EffectOp, clamp } from "./tables.js";
import { envPresent, applyKeyLift, seedPfRole, pfIdxBox, pfTimeBox } from "./envelope.js";
import { computePlaybackRate } from "./sampler.js";
import { random } from "./rng.js";
import {
  applyPanSet, applyPanSlide, applyElevation, SURROUND_STEREO, SURROUND_SPATIAL,
  applyNotePanSet, applyNotePanSlide, applyNoteElevation,
} from "./spatial.js";

/**
 * Snapshot the sample-scope state for voice from the base instrument or a
 * resolved Ixmp patch. Patch sentinels: defaultPan 0xFF, defaultNoteVolume 0,
 * vibratoWaveform 0xFF defer to the base instrument.
 */
export function applyActiveSample(voice, inst, patch) {
  // Stem-export tap (item 93): which patch sounded. indexOf runs once per
  // trigger over a handful of patches; nothing in the DSP reads it back.
  voice.activePatchIndex =
    patch === null || inst.extraPatches === null ? -1 : inst.extraPatches.indexOf(patch);
  if (patch === null) {
    voice.activeSamplePtr = inst.samplePtr;
    voice.activeSampleLength = inst.sampleLength;
    voice.activeSamplePlayStart = inst.samplePlayStart;
    voice.activeSampleLoopStart = inst.sampleLoopStart;
    voice.activeSampleLoopEnd = inst.sampleLoopEnd;
    voice.activeSamplingRate = inst.samplingRate;
    voice.activeSampleDetune = inst.sampleDetuneSigned;
    voice.activeLoopMode = inst.loopMode;
    voice.activeVibratoSpeed = inst.vibratoSpeed;
    voice.activeVibratoSweep = inst.vibratoSweep;
    voice.activeVibratoDepth = inst.vibratoDepth;
    voice.activeVibratoRate = inst.vibratoRate;
    voice.activeVibratoWaveform = inst.vibratoWaveform;
    // A base instrument record has no channel block: always mono.
    voice.activeChanCount = 1;
    voice.activeChanMode = 0;
    voice.activeChanPtr2 = 0;
  } else {
    voice.activeSamplePtr = patch.samplePtr;
    voice.activeSampleLength = patch.sampleLength;
    voice.activeSamplePlayStart = patch.playStart;
    voice.activeSampleLoopStart = patch.loopStart;
    voice.activeSampleLoopEnd = patch.loopEnd;
    voice.activeSamplingRate = patch.samplingRate;
    voice.activeSampleDetune = patch.sampleDetune;
    voice.activeLoopMode = patch.loopMode;
    voice.activeVibratoSpeed = patch.vibratoSpeed;
    voice.activeVibratoSweep = patch.vibratoSweep;
    voice.activeVibratoDepth = patch.vibratoDepth;
    voice.activeVibratoRate = patch.vibratoRate;
    voice.activeVibratoWaveform =
      patch.vibratoWaveform === 0xff ? inst.vibratoWaveform : patch.vibratoWaveform;
    // Ixmp 's' block (item 90). Only the stereo case is rendered; a patch with
    // more channels (quad / ambisonic — TODO #998) plays its first channel as
    // mono rather than guessing a downmix.
    if (patchIsStereo(patch)) {
      voice.activeChanCount = 2;
      voice.activeChanMode = patch.chanMode;
      voice.activeChanPtr2 = patch.chanPtrs[0];
    } else {
      voice.activeChanCount = 1;
      voice.activeChanMode = 0;
      voice.activeChanPtr2 = 0;
    }
  }
  resolveActiveEnvelopes(voice, inst, patch);
}

/**
 * Snapshot the active vol/pan/pitch/filter envelopes + fadeout/cutoff/resonance
 * scalars onto voice, from the base instrument or a resolved Ixmp patch. The
 * base instrument's two pf-env slots are routed by their m-bit (LOOP bit 7:
 * 0 = pitch, 1 = filter); a patch's 'P'/'f' blocks override the matching role.
 */
export function resolveActiveEnvelopes(voice, inst, patch) {
  const volEnv = patch !== null ? patch.volEnv : null;
  if (volEnv !== null) {
    voice.activeVolEnv = volEnv;
    voice.activeVolEnvLoop = patch.volEnvLoop;
    voice.activeVolEnvSustain = patch.volEnvSustain;
  } else {
    voice.activeVolEnv = inst.volEnvelopes;
    voice.activeVolEnvLoop = inst.volEnvLoop;
    voice.activeVolEnvSustain = inst.volEnvSustainWord;
  }
  const panEnv = patch !== null ? patch.panEnv : null;
  if (panEnv !== null) {
    voice.activePanEnv = panEnv;
    voice.activePanEnvLoop = patch.panEnvLoop;
    voice.activePanEnvSustain = patch.panEnvSustain;
  } else {
    voice.activePanEnv = inst.panEnvelopes;
    voice.activePanEnvLoop = inst.panEnvLoop;
    voice.activePanEnvSustain = inst.panEnvSustainWord;
  }

  let pitEnv = inst.pfEnvelopes, pitLoop = 0, pitSus = 0, pitOn = false;
  let filEnv = inst.pfEnvelopes, filLoop = 0, filSus = 0, filOn = false;
  // base slot 1 (bytes 19..)
  if (envPresent(inst.pfEnvLoop)) {
    if (((inst.pfEnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pfEnvelopes; filLoop = inst.pfEnvLoop; filSus = inst.pfEnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pfEnvelopes; pitLoop = inst.pfEnvLoop; pitSus = inst.pfEnvSustainWord; pitOn = true;
    }
  }
  // base slot 2 (bytes 197..)
  if (envPresent(inst.pf2EnvLoop)) {
    if (((inst.pf2EnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pf2Envelopes; filLoop = inst.pf2EnvLoop; filSus = inst.pf2EnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pf2Envelopes; pitLoop = inst.pf2EnvLoop; pitSus = inst.pf2EnvSustainWord; pitOn = true;
    }
  }
  // patch overrides by role
  const pPit = patch !== null ? patch.pitchEnv : null;
  if (pPit !== null) {
    pitEnv = pPit; pitLoop = patch.pitchEnvLoop; pitSus = patch.pitchEnvSustain;
    pitOn = envPresent(patch.pitchEnvLoop);
  }
  const pFil = patch !== null ? patch.filterEnv : null;
  if (pFil !== null) {
    filEnv = pFil; filLoop = patch.filterEnvLoop; filSus = patch.filterEnvSustain;
    filOn = envPresent(patch.filterEnvLoop);
  }
  voice.activePitchEnv = pitEnv; voice.activePitchEnvLoop = pitLoop;
  voice.activePitchEnvSustain = pitSus; voice.hasPitchEnv = pitOn;
  voice.activeFilterEnv = filEnv; voice.activeFilterEnvLoop = filLoop;
  voice.activeFilterEnvSustain = filSus; voice.hasFilterEnv = filOn;

  if (patch !== null && patch.hasExtra) {
    voice.activeFadeoutStep = patch.fadeoutStep;
    voice.filterSfMode = patch.filterSfMode;
    voice.activeDefaultCutoff = patch.extraCutoff;
    voice.activeDefaultResonance = patch.extraResonance;
    voice.activeAttenGain = attenGainOf(patch.extraInitialAttenOctet);
  } else {
    voice.activeFadeoutStep = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
    voice.filterSfMode = inst.filterSfMode;
    voice.activeDefaultCutoff = inst.defaultCutoff16;
    voice.activeDefaultResonance = inst.defaultResonance16;
    voice.activeAttenGain = attenGainOf(inst.initialAttenOctet);
  }
}

/** Trigger-time noteVolume seed from Default Note Volume (byte 196; 0 = legacy
 *  full volume). The record's field is 8-bit: a 6-bit column narrows it, a wide
 *  cell's 8-bit volume state takes it as it stands. */
export function rowVolumeFromDefault(inst, patch = null, volMax = 0x3f) {
  const patchDnv = patch !== null && patch.defaultNoteVolume !== 0 ? patch.defaultNoteVolume : null;
  const dnv = patchDnv !== null ? patchDnv : inst.defaultNoteVolume;
  if (dnv === 0) return volMax;
  return volMax === 0xff ? dnv : Math.trunc((dnv * 63 + 127) / 255);
}

/** Cap backgroundVoices to MAX_BG_VOICES, preferring to evict the oldest NON-layer ghost. */
export function capBackgroundVoices(ts) {
  while (ts.backgroundVoices.length > MAX_BG_VOICES) {
    const idx = ts.backgroundVoices.findIndex((v) => !v.isLayerChild);
    if (idx >= 0) ts.backgroundVoices.splice(idx, 1);
    else ts.backgroundVoices.shift();
  }
}

/** Release channel vi's layer children (fresh trigger): detach + apply their own NNA. */
export function releaseLayerChildren(eng, ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (!bg.isLayerChild || bg.sourceChannel !== vi) continue;
    bg.isLayerChild = false;
    switch (eng.instruments[bg.instrumentId].newNoteAction) {
      case 0:
        if (!bg.keyOff) { bg.keyOff = true; applyKeyLift(bg, eng.instruments[bg.instrumentId]); }
        break;
      case 1: bg.active = false; break; // note cut
      case 3: bg.noteFading = true; break; // note fade
      // 2 = continue
    }
  }
}

/** Hard-cut channel vi's layer children (pattern note-cut 0x0002). */
export function cutLayerChildren(ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) bg.active = false;
  }
}

/**
 * Trigger noteVal/instId on channel vi's foreground voice; a Metainstrument
 * fans out into layer children. rowVolOverride is the V-column trigger velocity
 * (or -1), used for velocity-conditional layer/patch resolution.
 */
export function triggerMetaOrNote(eng, ts, voice, vi, noteVal, instId, rowVolOverride) {
  // Remember the pattern-level instrument for the Timeline header (a meta's slot,
  // not the layer child triggerNote resolves it to). A note with no instrument
  // byte keeps the last one, matching what the pattern shows.
  if (instId !== 0) voice.displayInst = instId;
  releaseLayerChildren(eng, ts, vi);
  const inst = instId !== 0 ? eng.instruments[instId] : eng.instruments[voice.instrumentId];
  if (!inst.isMeta) {
    triggerNote(eng, ts, voice, noteVal, instId, rowVolOverride);
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.isLayerChild = false;
    return;
  }
  // Layer gating is an INSTRUMENT-side rectangle, so the axis is 6-bit whatever
  // the column's width: narrow a wide cell's volume to it.
  const gateVol = ts.wideCells ? rowVolOverride >> 2 : rowVolOverride;
  const seedVol = gateVol >= 0 && gateVol <= 0x3f ? gateVol : 0x3f;
  let layers = inst.resolveMetaLayers(noteVal, seedVol);
  // STRICT layering: drop layers whose patches don't cover the note (the gating
  // bbox is loose; strict converters emit each layer's canonical into its patches).
  if (inst.metaStrict) {
    layers = layers.filter((l) =>
      eng.instruments[l.instIdx].resolvePatch(clamp(noteVal + l.detune, 0x20, 0xffff), seedVol) !== null);
  }
  if (layers.length === 0) { // no layer sounds this note: silence
    voice.active = false;
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    return;
  }
  const l0 = layers[0];
  // Channel pan context as it stands BEFORE layer 0 retriggers. Each child is
  // seeded with this and then triggered, so a layer's own default pan (its
  // instrument's byte 177 or its Ixmp patch's) lands on the child instead of
  // being overwritten by layer 0's result — while a channel pan the pattern set
  // still carries to every layer that has no default of its own (item 116).
  const chanPan = voice.channelPan, chanRowPan = voice.rowPan;
  const chanAzimuth = voice.panAzimuth, chanElevation = voice.panElevation;
  // The note axis as it stands before layer 0 retriggers, for the same reason
  // and with the same caveat as chanPan: it may still hold the PREVIOUS note's
  // zone pan, which a pan-less layer then inherits. Faithful to the pre-split
  // engine, quirk included (see CLAUDE.TODOLIST.md item 118).
  const chanNotePan = voice.notePan, chanNoteEl = voice.noteElevation;
  triggerNote(eng, ts, voice, clamp(noteVal + l0.detune, 0x20, 0xffff), l0.instIdx, rowVolOverride);
  voice.layerMixGain = META_MIX_GAIN[l0.mixOctet & 0xff];
  voice.layerRelDetune = 0;
  voice.isLayerChild = false;
  voice.metaForeground = true;
  for (let k = 1; k < layers.length; k++) {
    const lk = layers[k];
    const child = new Voice();
    // Match layer 0's channel context so M/pan and the first tick agree; the
    // trigger below may then move the child's pan to its own default.
    child.channelVolume = voice.channelVolume;
    child.channelPan = chanPan;
    child.rowPan = chanRowPan;
    child.panAzimuth = chanAzimuth;
    child.panElevation = chanElevation;
    child.notePan = chanNotePan;
    child.noteElevation = chanNoteEl;
    triggerNote(eng, ts, child, clamp(noteVal + lk.detune, 0x20, 0xffff), lk.instIdx, rowVolOverride);
    child.isLayerChild = true;
    child.sourceChannel = vi;
    child.displayInst = voice.displayInst; // export/display tap: the meta SLOT, not the layer's inst
    child.layerRelDetune = lk.detune - l0.detune;
    child.layerMixGain = META_MIX_GAIN[lk.mixOctet & 0xff];
    ts.backgroundVoices.push(child);
  }
  capBackgroundVoices(ts);
}

/**
 * Narrow a note volume onto the Ixmp/meta rectangle's velocity axis. That axis
 * is INSTRUMENT data and stays 6-bit in every format version (file format §5.5),
 * so a wide cell's 8-bit volume must be scaled down for it — 255 → 63. Every
 * resolvePatch/resolveMetaLayers call site goes through here; one that forgets
 * silently misses every patch in a v3 song (item 116).
 */
export function narrowVolAxis(ts, v) {
  return clamp(ts.wideCells ? v >> 2 : v, 0, 0x3f);
}

export function triggerNote(eng, ts, voice, noteVal, instId, volOverride) {
  if (instId !== 0) voice.instrumentId = instId;
  const inst = eng.instruments[voice.instrumentId];
  // Resolve the Ixmp patch for this trigger (volume axis = pre-patch seed).
  const narrow = (v) => narrowVolAxis(ts, v);
  let seedVolForLookup;
  if (volOverride >= 0) seedVolForLookup = narrow(volOverride);
  else if (instId !== 0) seedVolForLookup = rowVolumeFromDefault(inst, null);
  else seedVolForLookup = narrow(voice.noteVolume);
  const patch = inst.resolvePatch(noteVal, seedVolForLookup);
  applyActiveSample(voice, inst, patch);
  voice.tonePortaTarget = -1; // fresh note trigger cancels any running porta
  voice.samplePos = voice.activeSamplePlayStart;
  voice.forward = true;
  voice.active = true;
  voice.keyOff = false;
  voice.envIndex = 0;
  voice.envTimeSec = 0.0;
  voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
  // Snap the per-sample-smoothed envelope so attacks land at node-0 immediately.
  voice.envVolMix = voice.envVolume;
  voice.envVolStep = 0.0;
  voice.envPanIndex = 0;
  voice.envPanTimeSec = 0.0;
  voice.envPan = voice.activePanEnv[0].value / 255.0;
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (voice.hasPitchEnv) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  } else {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  }
  if (voice.hasFilterEnv) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  } else {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  }
  voice.fadeoutVolume = 1.0;
  // Cancel any leftover sample-end ramp — a fresh attack must not be muted.
  voice.rampOutSamples = 0;
  voice.rampOutGain = 0.0;
  voice.autoVibPhase = 0;
  voice.autoVibTicksSinceTrigger = 0;
  voice.nesDpcmCounter = 63;
  voice.right.reset(); // stereo channel 2's filter/crusher/DPCM history
  // Funk repeat: PT2 resets n_wavestart on fresh trigger; speed/accumulator persist.
  voice.funkWritePos = 0;
  // Random vol/pan swing biases — seeded once per trigger.
  voice.randomVolBias = inst.volumeSwing !== 0
    ? Math.trunc(random() * (2 * inst.volumeSwing + 1)) - inst.volumeSwing : 0;
  voice.randomPanBias = inst.panSwing !== 0
    ? Math.trunc(random() * (2 * inst.panSwing + 1)) - inst.panSwing : 0;
  // Default pan / pitch-pan separation: only when the row carried an instrument byte.
  if (instId !== 0) {
    // Everything an INSTRUMENT says about panning lands on the note axis (item
    // 117), never on the channel's own position — the exact mirror of the
    // volume side, where an instrument seeds `note_vol` and only M / N may
    // touch `channel_vol`. That is what lets `S $80xx` ROTATE a zone-panned
    // instrument instead of being flattened by its next note: the channel says
    // where the part sits, the instrument says where the note sits within it.
    //
    // Two sources, in specificity order, and mutually EXCLUSIVE because they
    // are the same statement at two levels — an SF2 bank that applied its
    // record pan AND its zone pan would double every displacement:
    //
    //  - An Ixmp patch's default pan is per-ZONE, so a patched instrument's pan
    //    changes with the note being played. It carries its own sentinel
    //    (0xFF = no override) and applies whether or not 'p' is set: the patch
    //    is free to bring its own pan envelope, whose LOOP word REPLACES the
    //    base record's, so gating a patch override on 'p' would let the patch
    //    disable its own pan (item 116). SF2-derived banks are the common case.
    //  - Otherwise pan LOOP word bit 7 = 'p' ("use default pan") gates the base
    //    record's byte 177.
    //
    // The seed gate is unchanged: a trigger that brings NEITHER leaves the note
    // axis alone, so a pan column SET survives it exactly as it did when both
    // axes lived in one register.
    const patchPan = patch !== null && patch.defaultPan !== 0xff ? patch.defaultPan : null;
    if (patchPan !== null) {
      applyNotePanSet(ts, voice, patchPan);
    } else if (((voice.activePanEnvLoop >>> 7) & 1) !== 0) {
      if (ts.surroundModel === SURROUND_STEREO) {
        applyNotePanSet(ts, voice, inst.defaultPan);
      } else {
        // Surround: the instrument's default is a POSITION (#998). Its azimuth
        // is nine bits (byte 177 + byte 14's `A`), so it can sit behind the
        // listener, and its elevation comes from record byte 254. Both are read
        // as offsets from the channel's direction, so an instrument that wants
        // to sound half-left of wherever the part is placed can say so.
        applyNotePanSet(ts, voice, inst.defaultAzimuth);
        applyNoteElevation(ts, voice, inst.defaultElevation);
      }
    }
    // Pitch-pan separation — an instrument property, and pitch-derived, so it
    // shifts the note axis on top of whichever seed above ran. It still
    // ACCUMULATES across notes on an instrument that brings no default pan of
    // its own, which is IT's arithmetic (IT adds PPS to the pan it is holding
    // and only the default pan re-seeds that); it accumulates in note-axis
    // units now instead of channel-axis ones.
    if (inst.pitchPanSeparation !== 0) {
      const noteDelta = (noteVal - inst.pitchPanCentre) / 4096.0;
      const panShift = Math.trunc(noteDelta * inst.pitchPanSeparation * 4.0);
      applyNotePanSlide(ts, voice, panShift);
    }
  }
  // Filter defaults (ACTIVE values; patch 'x' block overrides base inst).
  voice.currentCutoff = voice.activeDefaultCutoff;
  voice.currentResonance = voice.activeDefaultResonance;
  voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0;
  voice.filterCutoffCached = -1;
  voice.filterResonanceCached = -1;
  voice.noteVal = noteVal;
  voice.basePitch = noteVal;
  voice.renderPitch = noteVal; // display tap: seed before the first tick runs
  voice.amigaPeriod = -1.0;
  voice.linearFreq = -1.0;
  voice.playbackRate = computePlaybackRate(voice, noteVal, ts.tuningRatio);
  // noteVolume seed (IT `chan->volume = psmp->volume` rule; channelVolume survives).
  if (volOverride >= 0) voice.noteVolume = clamp(volOverride, 0, ts.volMax);
  else if (instId !== 0) voice.noteVolume = rowVolumeFromDefault(inst, patch, ts.volMax);
  // else: note-only retrigger inherits the channel's existing note volume.
  voice.rowVolume = voice.noteVolume;
  // Deferred anti-click ramp snap (applyVolColumn/applyEffectRow run after this).
  voice.snapMixVolume = true;
  voice.volRampSamples = 0;
  voice.volRampStep = 0.0;
  voice.noteWasCut = false;
  voice.noteFading = false;
  // S $73..$7E per-note overrides reset on each fresh trigger.
  voice.nnaOverride = -1;
  voice.volEnvOn = true;
  voice.panEnvOn = true;
  voice.pitchEnvOn = true;
  voice.filterEnvOn = true;
  voice.metaForeground = false; // triggerMetaOrNote re-sets for the meta path
  if (voice.vibratoRetrig) voice.vibratoLfoPos = 0;
  if (voice.tremoloRetrig) voice.tremoloLfoPos = 0;
  if (voice.panbrelloRetrig) voice.panbrelloLfoPos = 0;
}

/**
 * IT-style Duplicate Check (DCT/DCA), run BEFORE NNA on every fresh foreground
 * trigger. Reference: schismtracker effects.c:1664-1764.
 */
export function applyDuplicateCheck(eng, ts, channel, newInstId, newNote) {
  if (newInstId === 0) return;
  const newInst = eng.instruments[newInstId];
  const newPatch = newInst.resolvePatch(newNote, 0x3f);
  const newSmpPtr = newPatch !== null ? newPatch.samplePtr : newInst.samplePtr;
  const newSmpLen = newPatch !== null ? newPatch.sampleLength : newInst.sampleLength;

  const isDuplicate = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckType) {
      case 1: return v.noteVal === newNote && v.instrumentId === newInstId;
      case 2: return v.instrumentId === newInstId &&
                     v.activeSamplePtr === newSmpPtr &&
                     v.activeSampleLength === newSmpLen;
      case 3: return v.instrumentId === newInstId;
      default: return false;
    }
  };

  const applyAction = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckAction) {
      case 0: v.fadeoutVolume = 0.0; v.active = false; break;
      case 1: v.keyOff = true; applyKeyLift(v, existInst); break;
      case 2: v.noteFading = true; break;
    }
  };

  const fg = ts.voices[channel];
  if (fg.active && eng.instruments[fg.instrumentId].duplicateCheckType !== 0 && isDuplicate(fg)) {
    applyAction(fg);
  }

  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (bg.sourceChannel !== channel || !bg.active) continue;
    if (eng.instruments[bg.instrumentId].duplicateCheckType === 0) continue;
    if (!isDuplicate(bg)) continue;
    applyAction(bg);
    if (!bg.active) ts.backgroundVoices.splice(i, 1);
  }
}

/**
 * On a fresh foreground trigger, migrate the existing voice into the background
 * pool per the New Note Action (instrument default unless S $73..$76 override).
 */
export function maybeSpawnBackgroundForNNA(eng, ts, voice, channel) {
  if (!voice.active) return;
  const nna = voice.nnaOverride >= 0
    ? voice.nnaOverride
    : eng.instruments[voice.instrumentId].newNoteAction;
  if (nna === 1) return; // Note Cut — no background needed.

  const bg = ghostVoice(voice, channel);
  if (nna === 0) { // Note Off
    bg.keyOff = true;
    applyKeyLift(bg, eng.instruments[bg.instrumentId]);
  } else if (nna === 3) { // Note Fade
    bg.noteFading = true;
  }
  // 2 (Continue) — ghost continues unchanged.
  ts.backgroundVoices.push(bg);
  capBackgroundVoices(ts);
}

/** Snapshot the playback-relevant state of src into a fresh Voice for channel.
 *  MUST copy the full active-sample + active-envelope views AND both filter
 *  state sets (incl. SF2 biquad coefficients/history) — see the port notes. */
export function ghostVoice(src, channel) {
  const v = new Voice();
  v.active = true;
  v.fader = src.fader;
  v.instrumentId = src.instrumentId;
  v.displayInst = src.displayInst;       // export/display tap: the ghost is still "that" instrument
  v.samplePos = src.samplePos;
  v.playbackRate = src.playbackRate;
  v.forward = src.forward;
  v.noteVolume = src.noteVolume;
  v.channelVolume = src.channelVolume;
  v.rowVolume = src.rowVolume;
  v.channelPan = src.channelPan;
  v.rowPan = src.rowPan;
  // Spatial position travels with the ghost: it keeps sounding where it was —
  // both axes, since the note it is still sounding brought its own offset.
  v.panAzimuth = src.panAzimuth;
  v.panElevation = src.panElevation;
  v.notePan = src.notePan;
  v.noteElevation = src.noteElevation;
  v.spatialTargetAz = src.spatialTargetAz;
  v.spatialTargetEl = src.spatialTargetEl;
  v.currentMixVolume = src.currentMixVolume;
  v.keyOff = src.keyOff;
  v.envIndex = src.envIndex;
  v.envTimeSec = src.envTimeSec;
  v.envVolume = src.envVolume;
  v.envVolMix = src.envVolMix;
  v.envVolStep = src.envVolStep;
  v.envPanIndex = src.envPanIndex;
  v.envPanTimeSec = src.envPanTimeSec;
  v.envPan = src.envPan;
  v.hasPanEnv = src.hasPanEnv;
  v.hasPitchEnv = src.hasPitchEnv;
  v.envPitchIndex = src.envPitchIndex;
  v.envPitchTimeSec = src.envPitchTimeSec;
  v.envPitchValue = src.envPitchValue;
  v.hasFilterEnv = src.hasFilterEnv;
  v.envFilterIndex = src.envFilterIndex;
  v.envFilterTimeSec = src.envFilterTimeSec;
  v.envFilterValue = src.envFilterValue;
  v.fadeoutVolume = src.fadeoutVolume;
  v.autoVibPhase = src.autoVibPhase;
  v.autoVibTicksSinceTrigger = src.autoVibTicksSinceTrigger;
  v.currentCutoff = src.currentCutoff;
  v.currentResonance = src.currentResonance;
  v.filterSfMode = src.filterSfMode;
  v.filterActive = src.filterActive;
  v.filterA0 = src.filterA0;
  v.filterB0 = src.filterB0;
  v.filterB1 = src.filterB1;
  v.filterY1 = src.filterY1;
  v.filterY2 = src.filterY2;
  v.filterIsBiquad = src.filterIsBiquad;
  v.filterBqB02 = src.filterBqB02;
  v.filterBqB1 = src.filterBqB1;
  v.filterBqA1 = src.filterBqA1;
  v.filterBqA2 = src.filterBqA2;
  v.filterX1 = src.filterX1;
  v.filterX2 = src.filterX2;
  v.filterCutoffCached = src.filterCutoffCached;
  v.filterResonanceCached = src.filterResonanceCached;
  v.randomVolBias = src.randomVolBias;
  v.randomPanBias = src.randomPanBias;
  v.noteVal = src.noteVal;
  v.basePitch = src.basePitch;
  v.amigaPeriod = src.amigaPeriod;
  v.linearFreq = src.linearFreq;
  v.volEnvOn = src.volEnvOn;
  v.panEnvOn = src.panEnvOn;
  v.pitchEnvOn = src.pitchEnvOn;
  v.filterEnvOn = src.filterEnvOn;
  v.metaForeground = src.metaForeground;
  v.noteFading = src.noteFading;
  v.layerMixGain = src.layerMixGain;
  v.clipMode = src.clipMode;
  v.bitcrusherDepth = src.bitcrusherDepth;
  v.bitcrusherSkip = src.bitcrusherSkip;
  v.bitcrusherCounter = src.bitcrusherCounter;
  v.bitcrusherHeld = src.bitcrusherHeld;
  v.overdriveAmp = src.overdriveAmp;
  v.sourceChannel = channel;
  // Active-sample snapshot follows the foreground voice.
  v.activeSamplePtr = src.activeSamplePtr;
  v.activeSampleLength = src.activeSampleLength;
  v.activeSamplePlayStart = src.activeSamplePlayStart;
  v.activeSampleLoopStart = src.activeSampleLoopStart;
  v.activeSampleLoopEnd = src.activeSampleLoopEnd;
  v.activeSamplingRate = src.activeSamplingRate;
  v.activeSampleDetune = src.activeSampleDetune;
  v.activeLoopMode = src.activeLoopMode;
  v.activeVibratoSpeed = src.activeVibratoSpeed;
  v.activeVibratoSweep = src.activeVibratoSweep;
  v.activeVibratoDepth = src.activeVibratoDepth;
  v.activeVibratoRate = src.activeVibratoRate;
  v.activeVibratoWaveform = src.activeVibratoWaveform;
  v.activePatchIndex = src.activePatchIndex; // stem tap: the ghost keeps the patch it sounded
  // A ghost of a stereo note keeps playing BOTH channels, with its own copy of
  // the second channel's filter/crusher history (same rule as the voice's own).
  v.activeChanCount = src.activeChanCount;
  v.activeChanMode = src.activeChanMode;
  v.activeChanPtr2 = src.activeChanPtr2;
  v.right.copyFrom(src.right);
  // Active-envelope view follows too — ghosts keep their patch's envelopes.
  v.activeVolEnv = src.activeVolEnv;
  v.activeVolEnvLoop = src.activeVolEnvLoop;
  v.activeVolEnvSustain = src.activeVolEnvSustain;
  v.activePanEnv = src.activePanEnv;
  v.activePanEnvLoop = src.activePanEnvLoop;
  v.activePanEnvSustain = src.activePanEnvSustain;
  v.activePitchEnv = src.activePitchEnv;
  v.activePitchEnvLoop = src.activePitchEnvLoop;
  v.activePitchEnvSustain = src.activePitchEnvSustain;
  v.activeFilterEnv = src.activeFilterEnv;
  v.activeFilterEnvLoop = src.activeFilterEnvLoop;
  v.activeFilterEnvSustain = src.activeFilterEnvSustain;
  v.activeFadeoutStep = src.activeFadeoutStep;
  v.activeDefaultCutoff = src.activeDefaultCutoff;
  v.activeDefaultResonance = src.activeDefaultResonance;
  v.activeAttenGain = src.activeAttenGain;
  return v;
}

/** Past-note action (S $70..$72) on all background voices spawned by channel. */
export function applyPastNoteAction(eng, ts, channel, action) {
  switch (action) {
    case 0: { // Past Note Cut — drop them.
      for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
        if (ts.backgroundVoices[i].sourceChannel === channel) ts.backgroundVoices.splice(i, 1);
      }
      break;
    }
    case 1: // Past Note Off — sustain release.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
      }
      break;
    case 2: // Past Note Fade.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) bg.noteFading = true;
      }
      break;
  }
}

/** Volume column (value = 6-bit field, sel = 2-bit selector). */
export function applyVolColumn(ts, voice, value, sel) {
  // FINE packs its direction into the TOP bit of the column's value field, so
  // the flag and the magnitude mask move with the field's width (bit 5 of six,
  // bit 7 of eight). Everything else is the same in both formats — a wide
  // cell's numbers are simply four times as fine.
  const dirBit = ts.wideCells ? 0x80 : 0x20;
  switch (sel) {
    case 0:
      voice.noteVolume = clamp(value, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
      break;
    case 1: voice.volColSlideUp = value; break;
    case 2: voice.volColSlideDown = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & (dirBit - 1);
      voice.noteVolume = (value & dirBit) !== 0
        ? Math.min(voice.noteVolume + mag, ts.volMax)
        : Math.max(voice.noteVolume - mag, 0);
      voice.rowVolume = voice.noteVolume;
      break;
    }
  }
}

/**
 * Pan column — the NOTE pan axis (item 117), the exact counterpart of the
 * volume column owning `note_vol` while M / N own `channel_vol`. All four
 * selectors write it, so a column SET places THIS note and leaves the channel's
 * own position (S $80xx, P, X, Z) standing underneath: on a zone-panned Ixmp
 * instrument the SET is what overrides the zone, and the channel commands are
 * what rotate it. There is consequently nothing left to arbitrate when a row
 * carries both a SET and an S $80xx — they address different registers, so both
 * apply.
 *
 * The 6-bit SET keeps its front-arc mapping in every surround model — the
 * column has no room for a 360° angle, and S $8xxx / X are the commands that
 * do. The slides, however, wrap with the rest of the pan machinery.
 */
export function applyPanColumn(ts, voice, value, sel) {
  switch (sel) {
    case 0:
      applyNotePanSet(ts, voice, (value << 2) | (value >>> 4));
      break;
    case 1: voice.panColSlideRight = value; break;
    case 2: voice.panColSlideLeft = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      applyNotePanSlide(ts, voice, (value & 0x20) !== 0 ? mag : -mag);
      break;
    }
  }
}

/**
 * A WIDE cell's panning column (format version 3): a 9-bit azimuth and a signed
 * elevation, so the column alone can place a source anywhere on the sphere —
 * the six bits of the narrow cell only ever reached the front arc.
 *
 * Like the narrow column it is the NOTE axis (item 117) — the wide cell is the
 * same two lanes at higher resolution, exactly as its volume column is still
 * `note_vol` with a whole byte instead of six bits — so its azimuth and
 * elevation are both offsets from wherever the channel is pointing.
 *
 * The one exception is a `Z` slide on the same row, which turns the SET into
 * that slide's TARGET rather than a jump (the column says what effect `4` would
 * have said, and outranks a `4` on the same row for being the more specific
 * statement). A Z target names an absolute direction for the CHANNEL to travel
 * to, so on those rows — and only those — the column speaks for the channel.
 */
export function applyPanColumnWide(ts, voice, row) {
  switch (row.panEff) {
    case 0: {
      if (rowSlidesSpatially(row)) {
        voice.spatialTargetAz = row.azimuth;
        voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? row.elevation : 0;
      } else {
        applyNotePanSet(ts, voice, row.azimuth);
        applyNoteElevation(ts, voice, row.elevation);
      }
      break;
    }
    // Slides rotate the azimuth by the LOW byte per tick; the elevation byte is
    // reserved for these selectors.
    case 1: voice.panColSlideRight = row.azimuth & 0xff; break;
    case 2: voice.panColSlideLeft = row.azimuth & 0xff; break;
    case 3: {
      const mag = row.azimuth & 0xff;
      if (mag === 0) return;
      applyNotePanSlide(ts, voice, (row.azimuth & 0x100) !== 0 ? mag : -mag);
      break;
    }
  }
}

/** Does this row arm a Z slide (in either effect slot)? */
function rowSlidesSpatially(row) {
  return (row.effect === EffectOp.OP_Z && (row.effectArg & 0xfff) !== 0) ||
         (row.effect2 === EffectOp.OP_Z && (row.effectArg2 & 0xfff) !== 0);
}
