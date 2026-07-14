// Voice + MemorySlots — port of AudioAdapter.kt:4497-4878. All fields are
// initialised in the constructor (monomorphic shape for the JIT); defaults
// match the Kotlin field initialisers exactly. Envelope point `offset` fields
// hold ThreeFiveMiniUfloat LUT indices.

import { SCOPE_BUFFER_SIZE } from "./constants.js";
import { envPoint } from "./inst.js";

/** Per-channel effect memory cohorts and private slots (TAUD_NOTE_EFFECTS.md §6). */
export class MemorySlots {
  constructor() {
    this.ef = 0;        // shared E/F (pitch slide)
    this.g = 0;         // G (tone porta) private speed
    this.huSpeed = 0;   // shared H/U vibrato
    this.huDepth = 0;
    this.rSpeed = 0;    // R (tremolo)
    this.rDepth = 0;
    this.ySpeed = 0;    // Y (panbrello)
    this.yDepth = 0;
    this.d = 0;
    this.i = 0;
    this.j = 0;
    this.o = 0;
    this.q = 0;
    this.tslide = 0;
    this.w = 0;
    this.k = 0;
    this.l = 0;
    this.n = 0;
    this.p = 0;
  }
}

function makeActiveEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

export class Voice {
  constructor() {
    this.active = false;
    // Host-owned 256-step attenuator (0 = unity, 255 = silence/mute sentinel).
    this.fader = 0;
    this.samplePos = 0.0;
    this.playbackRate = 1.0;
    this.forward = true;
    this.instrumentId = 0;
    // Display-only: the pattern-level instrument that triggered this voice (a
    // metainstrument's SLOT, not the layer-child it resolves to) — so the
    // Timeline voice header shows the number the user sees in the pattern. No
    // Kotlin counterpart (write-only, like renderPitch).
    this.displayInst = 0;

    // -1 for live foreground voices; 0..NUM_VOICES-1 = source channel for background ghosts.
    this.sourceChannel = -1;

    // ── Metainstrument layering ──
    this.isLayerChild = false;
    this.layerRelDetune = 0;
    this.layerMixGain = 1.0;
    this.nnaOverride = -1;
    // Per-voice envelope gates (S $77..$7E).
    this.volEnvOn = true;
    this.panEnvOn = true;
    this.pitchEnvOn = true;
    this.filterEnvOn = true;
    this.metaForeground = false;
    this.noteFading = false;

    // Two-volume model (TAUD_NOTE_EFFECTS.md §3).
    this.noteVolume = 0x3f;
    this.channelVolume = 0x3f;
    this.rowVolume = 63;
    this.channelPan = 0x80;
    this.rowPan = 32;

    // Anti-click volume ramp.
    this.currentMixVolume = 1.0;
    this.volRampSamples = 0;
    this.volRampStep = 0.0;
    this.snapMixVolume = false;

    this.keyOff = false;
    this.envIndex = 0;
    this.envTimeSec = 0.0;
    this.envVolume = 1.0;
    // Per-sample smoothed copy of envVolume (see AudioAdapter.kt:4615-4624).
    this.envVolMix = 1.0;
    this.envVolStep = 0.0;
    this.envPanIndex = 0;
    this.envPanTimeSec = 0.0;
    this.envPan = 0.5;
    this.hasPanEnv = false;

    // Pitch and filter envelopes (0.5 = unity).
    this.hasPitchEnv = false;
    this.envPitchIndex = 0;
    this.envPitchTimeSec = 0.0;
    this.envPitchValue = 0.5;
    this.hasFilterEnv = false;
    this.envFilterIndex = 0;
    this.envFilterTimeSec = 0.0;
    this.envFilterValue = 0.5;

    this.fadeoutVolume = 1.0;

    // MilkyTracker-style anti-click ramp-out.
    this.rampOutSamples = 0;
    this.rampOutGain = 0.0;
    this.rampOutStep = 0.0;

    // Auto-vibrato.
    this.autoVibPhase = 0;
    this.autoVibTicksSinceTrigger = 0;

    // Active-sample view (snapshot by applyActiveSample at trigger).
    this.activeSamplePtr = 0;
    this.activeSampleLength = 0;
    this.activeSamplePlayStart = 0;
    this.activeSampleLoopStart = 0;
    this.activeSampleLoopEnd = 0;
    this.activeSamplingRate = 0;
    this.activeSampleDetune = 0; // signed 4096-TET
    this.activeLoopMode = 0;     // bits 0-1 direction, bit 2 sustain
    this.activeVibratoSpeed = 0;
    this.activeVibratoSweep = 0;
    this.activeVibratoDepth = 0;
    this.activeVibratoRate = 0;
    this.activeVibratoWaveform = 0;

    // Active-envelope view (snapshot by resolveActiveEnvelopes at trigger).
    this.activeVolEnv = makeActiveEnv(0x3f);
    this.activeVolEnvLoop = 0;
    this.activeVolEnvSustain = 0;
    this.activePanEnv = makeActiveEnv(0x80);
    this.activePanEnvLoop = 0;
    this.activePanEnvSustain = 0;
    this.activePitchEnv = makeActiveEnv(0x80);
    this.activePitchEnvLoop = 0;
    this.activePitchEnvSustain = 0;
    this.activeFilterEnv = makeActiveEnv(0x80);
    this.activeFilterEnvLoop = 0;
    this.activeFilterEnvSustain = 0;
    this.activeFadeoutStep = 0;
    this.activeDefaultCutoff = 0xff;
    this.activeDefaultResonance = 0xff;
    // false = IT filter units (bytes), true = SoundFont (cents / centibels).
    this.filterSfMode = false;
    this.activeAttenGain = 1.0;

    // NES 2A03 DMC counter for INTERP_NES_DPCM.
    this.nesDpcmCounter = 63;

    // Filter state.
    this.currentCutoff = 0xff;
    this.currentResonance = 0xff;
    this.filterActive = false;
    // IT 2-pole IIR-only: y[n] = A0·x[n] + B0·y[n-1] + B1·y[n-2]
    this.filterA0 = 1.0;
    this.filterB0 = 0.0;
    this.filterB1 = 0.0;
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    // SF2 RBJ biquad: y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] − a1·y[n-1] − a2·y[n-2]
    this.filterIsBiquad = false;
    this.filterBqB02 = 0.0;
    this.filterBqB1 = 0.0;
    this.filterBqA1 = 0.0;
    this.filterBqA2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.filterCutoffCached = -1;
    this.filterResonanceCached = -1;

    // Per-trigger random vol/pan swing biases.
    this.randomVolBias = 0;
    this.randomPanBias = 0;

    // Pitch state (4096-TET).
    this.noteVal = 0x0000;
    this.basePitch = 0x4000;
    this.amigaPeriod = -1.0; // -1.0 = needs reseed
    this.linearFreq = -1.0;
    // JS-only display tap (no Kotlin counterpart): the last per-tick sounding
    // pitch (finalPitch — after slides/arpeggio/vibrato/pitch-env), so the
    // Timeline header can show what the voice is ACTUALLY playing per tick, not
    // just the row-triggered noteVal. Never read by the DSP.
    this.renderPitch = 0x0000;

    // Per-row effect state.
    this.rowEffect = 0;
    this.rowEffectArg = 0;
    this.slideMode = 0;
    this.slideArg = 0;
    this.tonePortaTarget = -1;
    this.tonePortaSpeed = 0;
    this.arpOff1 = 0;
    this.arpOff2 = 0;
    this.arpActive = false;
    this.lastArpVoice = 0;
    this.tremorOn = 0;
    this.tremorOnTime = 1;
    this.tremorOffTime = 1;
    this.tremorPhaseOn = true;
    this.tremorTickInPhase = 0;

    // Vibrato (H / U).
    this.vibratoActive = false;
    this.vibratoLfoPos = 0;
    this.vibratoWave = 0;
    this.vibratoRetrig = true;
    this.vibratoFineShift = 6; // 6 for H, 8 for U

    // Tremolo (R).
    this.tremoloActive = false;
    this.tremoloLfoPos = 0;
    this.tremoloWave = 0;
    this.tremoloRetrig = true;

    // Panbrello (Y).
    this.panbrelloActive = false;
    this.panbrelloLfoPos = 0;
    this.panbrelloWave = 0;
    this.panbrelloRetrig = true;

    this.glissandoOn = false;

    // Q retrigger.
    this.retrigCounter = 0;
    this.retrigInterval = 0;
    this.retrigVolMod = 0;
    this.retrigActive = false;

    // Note delay (S$Dx).
    this.noteDelayTick = -1;
    this.delayedNote = 0;
    this.delayedInst = 0;
    this.delayedVol = -1;

    // Note cut (S$Cx).
    this.cutAtTick = -1;
    this.noteWasCut = false;

    // Funk repeat (S$Fx).
    this.funkSpeed = 0;
    this.funkAccumulator = 0;
    this.funkWritePos = 0;

    // Pattern loop (S$Bx).
    this.loopStartRow = 0;
    this.loopCount = 0;

    // Pattern ditto (effect 7).
    this.dittoActive = false;
    this.dittoSourceStart = 0;
    this.dittoLength = 0;
    this.dittoEndRow = 0;

    // Tempo slide (T $00xy).
    this.tempoSlideDir = 0;
    this.tempoSlideAmount = 0;

    // Global volume slide (W $xy00).
    this.wSlideDir = 0;
    this.wSlideAmount = 0;

    // Volume / pan column slides.
    this.volColSlideUp = 0;
    this.volColSlideDown = 0;
    this.panColSlideRight = 0;
    this.panColSlideLeft = 0;
    this.nSlideDir = 0;

    // Bitcrusher (8) / Overdrive (9).
    this.clipMode = 0;
    this.bitcrusherDepth = 0;
    this.bitcrusherSkip = 0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.overdriveAmp = 0;

    this.mem = new MemorySlots();

    // Soundscope ring buffer (visualisation only).
    this.scopeBuffer = new Float32Array(SCOPE_BUFFER_SIZE);
    this.scopeWritePos = 0;
  }

  get activeSampleLoopSustain() { return (this.activeLoopMode & 0x04) !== 0; }
}
