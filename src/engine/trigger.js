// Trigger path + NNA/Metainstrument machinery — port of AudioAdapter.kt
// applyActiveSample (1529), resolveActiveEnvelopes (1574), attenGainOf (1629),
// rowVolumeFromDefault (2413), capBackgroundVoices (2421), release/cutLayerChildren
// (2431/2445), triggerMetaOrNote (2469), triggerNote (2524), applyDuplicateCheck
// (2693), maybeSpawnBackgroundForNNA (2748), ghostVoice (2768),
// applyPastNoteAction (2887), applyVolColumn (2905), applyPanColumn (2927).

import { MAX_BG_VOICES } from "./constants.js";
import { Voice } from "./voice.js";
import { META_MIX_GAIN, attenGainOf, EffectOp, clamp } from "./tables.js";
import { envPresent, applyKeyLift, seedPfRole, pfIdxBox, pfTimeBox } from "./envelope.js";
import { computePlaybackRate } from "./sampler.js";
import { random } from "./rng.js";

/**
 * Snapshot the sample-scope state for voice from the base instrument or a
 * resolved Ixmp patch. Patch sentinels: defaultPan 0xFF, defaultNoteVolume 0,
 * vibratoWaveform 0xFF defer to the base instrument.
 */
export function applyActiveSample(voice, inst, patch) {
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

/** Trigger-time noteVolume seed from Default Note Volume (byte 196; 0 = legacy 0x3F). */
export function rowVolumeFromDefault(inst, patch = null) {
  const patchDnv = patch !== null && patch.defaultNoteVolume !== 0 ? patch.defaultNoteVolume : null;
  const dnv = patchDnv !== null ? patchDnv : inst.defaultNoteVolume;
  return dnv === 0 ? 0x3f : Math.trunc((dnv * 63 + 127) / 255);
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
  releaseLayerChildren(eng, ts, vi);
  const inst = instId !== 0 ? eng.instruments[instId] : eng.instruments[voice.instrumentId];
  if (!inst.isMeta) {
    triggerNote(eng, voice, noteVal, instId, rowVolOverride);
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.isLayerChild = false;
    return;
  }
  const seedVol = rowVolOverride >= 0 && rowVolOverride <= 0x3f ? rowVolOverride : 0x3f;
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
  triggerNote(eng, voice, clamp(noteVal + l0.detune, 0x20, 0xffff), l0.instIdx, rowVolOverride);
  voice.layerMixGain = META_MIX_GAIN[l0.mixOctet & 0xff];
  voice.layerRelDetune = 0;
  voice.isLayerChild = false;
  voice.metaForeground = true;
  for (let k = 1; k < layers.length; k++) {
    const lk = layers[k];
    const child = new Voice();
    triggerNote(eng, child, clamp(noteVal + lk.detune, 0x20, 0xffff), lk.instIdx, rowVolOverride);
    child.isLayerChild = true;
    child.sourceChannel = vi;
    child.layerRelDetune = lk.detune - l0.detune;
    child.layerMixGain = META_MIX_GAIN[lk.mixOctet & 0xff];
    child.channelVolume = voice.channelVolume;
    child.channelPan = voice.channelPan;
    child.rowPan = voice.rowPan;
    ts.backgroundVoices.push(child);
  }
  capBackgroundVoices(ts);
}

export function triggerNote(eng, voice, noteVal, instId, volOverride) {
  if (instId !== 0) voice.instrumentId = instId;
  const inst = eng.instruments[voice.instrumentId];
  // Resolve the Ixmp patch for this trigger (volume axis = pre-patch seed).
  let seedVolForLookup;
  if (volOverride >= 0) seedVolForLookup = clamp(volOverride, 0, 0x3f);
  else if (instId !== 0) seedVolForLookup = rowVolumeFromDefault(inst, null);
  else seedVolForLookup = clamp(voice.noteVolume, 0, 0x3f);
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
  // Funk repeat: PT2 resets n_wavestart on fresh trigger; speed/accumulator persist.
  voice.funkWritePos = 0;
  // Random vol/pan swing biases — seeded once per trigger.
  voice.randomVolBias = inst.volumeSwing !== 0
    ? Math.trunc(random() * (2 * inst.volumeSwing + 1)) - inst.volumeSwing : 0;
  voice.randomPanBias = inst.panSwing !== 0
    ? Math.trunc(random() * (2 * inst.panSwing + 1)) - inst.panSwing : 0;
  // Default pan / pitch-pan separation: only when the row carried an instrument byte.
  if (instId !== 0) {
    // Pan LOOP word bit 7 = 'p' ("use default pan"); patch defaultPan wins unless 0xFF.
    if (((voice.activePanEnvLoop >>> 7) & 1) !== 0) {
      const patchPan = patch !== null && patch.defaultPan !== 0xff ? patch.defaultPan : null;
      voice.channelPan = patchPan !== null ? patchPan : inst.defaultPan;
      voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
    }
    // Pitch-pan separation.
    if (inst.pitchPanSeparation !== 0) {
      const noteDelta = (noteVal - inst.pitchPanCentre) / 4096.0;
      const panShift = Math.trunc(noteDelta * inst.pitchPanSeparation * 4.0);
      voice.channelPan = clamp(voice.channelPan + panShift, 0, 255);
      voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
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
  voice.amigaPeriod = -1.0;
  voice.linearFreq = -1.0;
  voice.playbackRate = computePlaybackRate(voice, noteVal);
  // noteVolume seed (IT `chan->volume = psmp->volume` rule; channelVolume survives).
  if (volOverride >= 0) voice.noteVolume = clamp(volOverride, 0, 0x3f);
  else if (instId !== 0) voice.noteVolume = rowVolumeFromDefault(inst, patch);
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
  v.samplePos = src.samplePos;
  v.playbackRate = src.playbackRate;
  v.forward = src.forward;
  v.noteVolume = src.noteVolume;
  v.channelVolume = src.channelVolume;
  v.rowVolume = src.rowVolume;
  v.channelPan = src.channelPan;
  v.rowPan = src.rowPan;
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
export function applyVolColumn(voice, value, sel) {
  switch (sel) {
    case 0:
      voice.noteVolume = clamp(value, 0, 0x3f);
      voice.rowVolume = voice.noteVolume;
      break;
    case 1: voice.volColSlideUp = value; break;
    case 2: voice.volColSlideDown = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      voice.noteVolume = (value & 0x20) !== 0
        ? Math.min(voice.noteVolume + mag, 0x3f)
        : Math.max(voice.noteVolume - mag, 0);
      voice.rowVolume = voice.noteVolume;
      break;
    }
  }
}

/** Pan column. S $80xx on the same row wins over the 6-bit SET here. */
export function applyPanColumn(voice, value, sel) {
  const rowHasS80 = voice.rowEffect === EffectOp.OP_S &&
                    ((voice.rowEffectArg >>> 12) & 0xf) === 0x8;
  switch (sel) {
    case 0:
      if (!rowHasS80) {
        voice.channelPan = (value << 2) | (value >>> 4);
        voice.rowPan = clamp(voice.channelPan >> 2, 0, 63);
      }
      break;
    case 1: voice.panColSlideRight = value; break;
    case 2: voice.panColSlideLeft = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      voice.channelPan = (value & 0x20) !== 0
        ? Math.min(voice.channelPan + mag, 0xff)
        : Math.max(voice.channelPan - mag, 0);
      voice.rowPan = clamp(voice.channelPan >> 2, 0, 63);
      break;
    }
  }
}
