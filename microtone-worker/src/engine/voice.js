// Voice + MemorySlots — port of AudioAdapter.kt:4497-4878. All fields are
// initialised in the constructor (monomorphic shape for the JIT); defaults
// match the Kotlin field initialisers exactly. Envelope point `offset` fields
// hold ThreeFiveMiniUfloat LUT indices.

import { SCOPE_BUFFER_SIZE } from "./constants.js";
import { envPoint } from "./inst.js";
import { ModGeom } from "./samplemod.js";

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
    this.z = 0;         // Z (spherical panning slide speed, #998.2)
  }
}

function makeActiveEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * Per-channel DSP history for a multi-channel (Ixmp 's') voice — item 90.
 * Channel 1 uses the Voice's OWN fields (so the mono path is untouched); this
 * mirrors the same field names for channel 2, which is why applyVoiceFilter /
 * applyTaudVoiceFx / fetchTrackerSample can take either object as their state
 * holder. Coefficients, envelopes and pitch stay shared — only the history
 * that must not be crossed between channels lives here.
 */
export class ChannelState {
  constructor() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  /** Trigger-time reset — mirrors what triggerNote does to the Voice's own. */
  reset() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  copyFrom(src) {
    this.filterY1 = src.filterY1;
    this.filterY2 = src.filterY2;
    this.filterX1 = src.filterX1;
    this.filterX2 = src.filterX2;
    this.bitcrusherCounter = src.bitcrusherCounter;
    this.bitcrusherHeld = src.bitcrusherHeld;
    this.nesDpcmCounter = src.nesDpcmCounter;
  }
}

export class Voice {
  constructor() {
    this.active = false;
    // Host-owned 256-step attenuator (0 = unity, 255 = silence/mute sentinel).
    this.fader = 0;
    this.samplePos = 0.0;
    this.playbackRate = 1.0;
    // Per-sample interpolation of the pitch (item 141). playbackRate is the
    // TARGET the tick just set; currentPlaybackRate is what the sampler steps
    // by, glided toward it across the tick so a slide or a vibrato is a
    // continuous bend rather than a staircase of 50 steps a second.
    this.currentPlaybackRate = 1.0;
    this.pitchRampSamples = 0;
    this.pitchRampStep = 0.0;
    this.snapPlaybackRate = true;
    this.forward = true;
    this.instrumentId = 0;
    // Display-only: the pattern-level instrument that triggered this voice (a
    // metainstrument's SLOT, not the layer-child it resolves to) — so the
    // Timeline voice header shows the number the user sees in the pattern. No
    // Kotlin counterpart (write-only, like renderPitch).
    this.displayInst = 0;

    // -1 for live foreground voices; 0..NUM_VOICES-1 = source channel for background ghosts.
    this.sourceChannel = -1;

    // ── Stem-export taps (item 93; JS-only, never read by the DSP) ──
    // Index into inst.extraPatches of the Ixmp patch this trigger resolved to,
    // -1 = the base record. Lets the exporter put each drum of a percussion
    // instrument on its own track.
    this.activePatchIndex = -1;
    // Memoised stem routing: stemKey is the (displayInst, instrumentId,
    // activePatchIndex) triple the exporter last resolved, stemIndex its answer.
    // Declared here so the Voice shape stays monomorphic.
    this.stemKey = -1;
    this.stemIndex = -1;

    // ── Metainstrument layering ──
    this.isLayerChild = false;
    this.layerRelDetune = 0;
    // How far this layer sits from the meta's centre (layer 0), in note-axis
    // units — the pan twin of layerRelDetune, re-added by the per-tick sync so
    // the arrangement ROTATES with the note rather than collapsing (item 118).
    this.layerRelPan = 0;
    this.layerRelElevation = 0;
    this.layerMixGain = 1.0;
    // The parent channel's per-tick pitch overlay (vibrato / glissando /
    // arpeggio), copied down by the per-tick sync so an effect that bends the
    // note bends the WHOLE metainstrument and not just layer 0 (item 154).
    this.layerPitchMod = 0;
    this.nnaOverride = -1;
    // Per-voice envelope gates (S $77..$7E).
    this.volEnvOn = true;
    this.panEnvOn = true;
    this.pitchEnvOn = true;
    this.filterEnvOn = true;
    this.metaForeground = false;
    this.noteFading = false;

    // Two-axis volume AND pan model (TAUD_NOTE_EFFECTS.md §3). Both axes work
    // the same way on either side: the instrument seeds the NOTE axis and the
    // pattern's channel commands own the CHANNEL axis, and the two combine at
    // the mixer — volume multiplies, pan adds.
    this.noteVolume = 0x3f;
    this.channelVolume = 0x3f;
    this.rowVolume = 63;
    this.channelPan = 0x80;
    this.rowPan = 32;
    // Note-pan axis: a signed OFFSET from the channel's position, in the same
    // 512-units-to-a-turn space as panAzimuth (so on the front arc it is just a
    // pan-byte delta). 0 = neutral, which is what keeps a song that never
    // touches it rendering exactly as it did under the single-register model.
    // Seeded by the Ixmp patch's `default pan` and written by the panning
    // column; nothing else may write it.
    this.notePan = 0;
    this.noteElevation = 0.0;      // the wide panning column's elevation half

    // ── Spatial position (#998) — used only when the song is planar/spatial.
    // channelPan stays the legacy integer (and the UI's mirror); panAzimuth is
    // the continuous 512-unit angle the mixer and the Z slide work in.
    this.panAzimuth = 128.0;       // 0 = left, 128 = front, 256 = right
    this.panElevation = 0.0;       // 128 units = 90°
    this.spatialTargetAz = 128.0;  // effect 4
    this.spatialTargetEl = 0.0;
    this.spatialSlideActive = false; // armed by Z for the current row
    // Mixer-side cache of the renderer gains: {az, el, chans, renderer, gains}.
    this.spatial = null;
    // The same, for the master strip's analysis bus (item 98) — a separate slot
    // so the two buses do not invalidate each other every sample.
    this.analysisSpatial = null;

    // Anti-click volume ramp.
    this.currentMixVolume = 1.0;
    this.volRampSamples = 0;
    this.volRampStep = 0.0;
    // …and of the pan (item 141), for the same reason: the pan law is evaluated
    // per sample but every input to it moves once a tick, so a slide, a
    // panbrello or a pan envelope stepped the gain 50 times a second.
    this.currentPan = 128.0;
    this.panRampSamples = 0;
    this.panRampStep = 0.0;
    this.snapPan = true;
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

    // Volume ramp for Attack (item 139). Counts down from ATTACK_RAMP_SAMPLES to 0
    // on every fresh triggerNote(); the mixer reads it as a half-cosine fade-in gain
    // and folds it into the same per-sample rampGain the sample-end ramp-out uses.
    this.attackRampSamples = 0;

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
    // Multi-channel view (Ixmp 's' block, item 90). 1 = mono — the only case
    // before stereo, and the only one the base instrument can express. 2 = the
    // sample is a stereo PAIR: chanPtr2 is the right channel's pool span, which
    // shares every geometry field above (length / play-start / loop / rate).
    // chanMode 0 = discrete L,R; 1 = matrix M,S (decoded at mix time).
    this.activeChanCount = 1;
    this.activeChanMode = 0;
    this.activeChanPtr2 = 0;
    this.right = new ChannelState();

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
    // This tick's pitch OVERLAY — vibrato / glissando / arpeggio, as a signed
    // delta on noteVal. A metainstrument's layer children read it off their
    // parent so the bend reaches every layer (item 154; layerPitchMod).
    this.pitchModDelta = 0;

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
    this.vibratoLfoPos = 0;   // 1088-step phase (lfoSampleWide), not the auto-vib 256
    this.vibratoWave = 0;
    this.vibratoRetrig = true;
    this.vibratoFineShift = 6; // 6 for H, 8 for U

    // Tremolo (R).
    this.tremoloActive = false;
    this.tremoloLfoPos = 0;
    this.tremoloWave = 0;
    this.tremoloRetrig = true;

    // Panbrello (Y). `panbrelloOffset` is a signed pan offset the mixer sums
    // alongside notePan and randomPanBias — an OFFSET rather than a write to
    // either axis, so the LFO swings around wherever the channel and the note
    // have put the voice without eating the instrument's own pan seed, and so
    // it reaches the surround path (voiceAzimuth) unchanged.
    this.panbrelloActive = false;
    this.panbrelloLfoPos = 0;
    this.panbrelloWave = 0;
    this.panbrelloRetrig = true;
    this.panbrelloOffset = 0;

    this.glissandoOn = false;

    // Q retrigger.
    this.retrigCounter = 0;
    this.retrigInterval = 0;
    this.retrigVolMod = 0;
    this.retrigActive = false;

    // Note delay (S$Dx) + its optional post-trigger action (S$Dxny, item 94;
    // JS-only so far — TSVM has no `n`/`y` handling yet, only `x`).
    this.noteDelayTick = -1;
    this.delayedNote = 0;
    this.delayedInst = 0;
    this.delayedVol = -1;
    this.noteActionTick = -1; // absolute tick-in-row for the S$Dxny follow-up ($x+$y)
    this.delayedAction = -1;  // the $n value (0..4), or -1 = none scheduled

    // Note cut (S$Cx).
    this.cutAtTick = -1;
    this.noteWasCut = false;

    // Funk repeat (S$Fx).
    this.funkSpeed = 0;
    this.funkAccumulator = 0;
    this.funkWritePos = 0;

    // Sample modification (notefx 2 / 3) — the operation and its region live on
    // the instrument; the channel only drives the clock. `modPeriod` is the step
    // period in TICKS (item 153.1), 0 = frozen, and modTickCount counts up to it.
    this.modPeriod = 0;
    this.modTickCount = 0;
    this.modWritePos = 0;
    // Countdown of the anti-click crossfade between the mapping the last step
    // replaced and the one it installed (item 153.5), in output samples.
    this.modXfade = 0;
    // This voice's resolved view of the instrument's region — the fractions cut
    // against the loop THIS voice is sounding. Rebuilt only when either moves.
    this.modGeom = new ModGeom();

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
    // Per-tick pan slides, one pair per axis — the pan twin of nSlideDir (N,
    // channel volume) vs volColSlide* (the volume column, note volume).
    this.panColSlideRight = 0;   // the panning column's, on the note axis
    this.panColSlideLeft = 0;
    this.chanPanSlideRight = 0;  // effect P's, on the channel axis
    this.chanPanSlideLeft = 0;
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
  /** True when this voice renders a stereo pair (see activeChanCount). */
  get isStereo() { return this.activeChanCount === 2; }
}
