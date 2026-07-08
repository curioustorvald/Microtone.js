// Taud instrument data model — port of AudioAdapter.kt TaudInstEnvPoint (5246),
// TaudInstPatch (5261), MetaLayer (5312), TaudInst (5378-5766).
// Envelope point `offset` is the ThreeFiveMiniUfloat LUT index (0..255);
// use minifloatToDouble(pt.offset) for seconds.

export function envPoint(value, offset = 0) {
  return { value, offset };
}

function makeEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * One Ixmp "extra sample" patch — overlays sample-scope state on a base
 * instrument for a (noteVal, rowVolume) rectangle. Optional v/p/f/P/x blocks
 * additionally override envelopes and fadeout/cutoff/resonance; anything left
 * absent (null env / hasExtra=false) defers to the base TaudInst.
 * Sentinels: defaultPan 0xFF, defaultNoteVolume 0, vibratoWaveform 0xFF all
 * mean "inherit the base instrument's value".
 */
export function makeInstPatch(fields) {
  return {
    pitchStart: 0, pitchEnd: 0, volumeStart: 0, volumeEnd: 0,
    samplePtr: 0, sampleLength: 0, playStart: 0, loopStart: 0, loopEnd: 0,
    samplingRate: 0, sampleDetune: 0, loopMode: 0,
    defaultPan: 0xff, defaultNoteVolume: 0,
    vibratoSpeed: 0, vibratoSweep: 0, vibratoDepth: 0, vibratoRate: 0,
    vibratoWaveform: 0xff,
    volEnv: null, volEnvLoop: 0, volEnvSustain: 0,
    panEnv: null, panEnvLoop: 0, panEnvSustain: 0,
    filterEnv: null, filterEnvLoop: 0, filterEnvSustain: 0,
    pitchEnv: null, pitchEnvLoop: 0, pitchEnvSustain: 0,
    hasExtra: false, fadeoutStep: 0, filterSfMode: false,
    extraCutoff: 0xff, extraResonance: 0xff, extraInitialAttenOctet: 0,
    ...fields,
  };
}

export function patchSampleLoopSustain(patch) {
  return (patch.loopMode & 0x04) !== 0;
}

/** One layer of a Metainstrument. mixOctet is the raw PSO-dB octet (159 = unity). */
export function makeMetaLayer(instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd) {
  return { instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd };
}

/**
 * 256-byte instrument record (terranmon.txt:2001+). See AudioAdapter.kt:5322-5376
 * for the full byte layout. Envelopes have LOOP (always-active wrap) and SUSTAIN
 * (key-on-only wrap) words; playback priority matches schismtracker sndmix.c.
 */
export class TaudInst {
  constructor(index) {
    this.index = index;

    this.samplePtr = 0;
    this.sampleLength = 0;
    this.samplingRate = 0;
    this.samplePlayStart = 0;
    this.sampleLoopStart = 0;
    this.sampleLoopEnd = 0;
    this.loopMode = 0;            // byte 14: bits 0-1 mode, bit 2 sustain, bit 4 percussion
    this.volEnvLoop = 0;          // bytes 15-16 (LOOP word)
    this.panEnvLoop = 0;          // bytes 17-18
    this.pfEnvLoop = 0;           // bytes 19-20
    this.instGlobalVolume = 0xff;
    this.volEnvelopes = makeEnv(0x3f);
    this.panEnvelopes = makeEnv(0x80);
    this.pfEnvelopes = makeEnv(0x80);
    this.volumeFadeoutLow = 0;
    this.fadeoutHigh = 0;
    this.volumeSwing = 0;
    this.vibratoSpeed = 0;
    this.vibratoSweep = 0;
    this.defaultPan = 0x80;
    this.pitchPanCentre = 0x5000;
    this.pitchPanSeparation = 0;
    this.panSwing = 0;
    this.defaultCutoff = 0xff;
    this.defaultResonance = 0;    // matches Kotlin secondary-ctor default order
    this.sampleDetune = 0;
    this.instrumentFlag = 0;
    this.vibratoDepth = 0;
    this.vibratoRate = 0;
    this.volEnvSustainWord = 0;
    this.panEnvSustainWord = 0;
    this.pfEnvSustainWord = 0;
    this.dupCheckFlag = 0;
    this.defaultNoteVolume = 0;   // byte 196; 0 = legacy fall back to 0x3F
    this.pf2EnvLoop = 0;          // bytes 197-198
    this.pf2EnvSustainWord = 0;   // bytes 199-200
    this.pf2Envelopes = makeEnv(0x80); // bytes 201-250

    // Reserved padding at offsets 251..255; note the Kotlin indexing quirk:
    // getByte(252..255) reads reserved[offset-251] (reserved[0] unused), and
    // defaultCutoff16/defaultResonance16 read reserved[1]/reserved[2].
    this.reserved = new Uint8Array(5);
    this.initialAttenOctet = 0;   // byte 251; 0 = unity sentinel

    // Runtime notefx 5/6 overrides (-1 = none).
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;

    // Ixmp patches (null when none uploaded).
    this.extraPatches = null;

    // Metainstrument state.
    this.metaLayers = null;
    this.metaRaw = null;          // verbatim 256-byte record for lossless capture
    this.metaStrict = false;

    // Funk repeat (S$Fx00) XOR bit-mask over the loop region.
    this.funkMask = null;
  }

  get sampleLoopSustain() { return (this.loopMode & 0x04) !== 0; }
  get isPercussion() {
    return this.metaRaw !== null
      ? (this.metaRaw[0] & 0x02) !== 0
      : (this.loopMode & 0x10) !== 0;
  }
  get nnaKeyLift() { return ((this.instrumentFlag >>> 5) & 1) !== 0; }
  /** 0=note off, 1=note cut, 2=continue, 3=note fade. */
  get newNoteAction() { return this.instrumentFlag & 0x03; }
  /** 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2). */
  get vibratoWaveform() { return (this.instrumentFlag >>> 2) & 0x07; }
  get sampleDetuneSigned() {
    const v = this.sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  get duplicateCheckType() { return this.dupCheckFlag & 0x03; }
  get duplicateCheckAction() { return (this.dupCheckFlag >>> 2) & 0x03; }
  /** byte 173 bit 4: false = ImpulseTracker filter units, true = SoundFont. */
  get filterSfMode() { return ((this.fadeoutHigh >>> 4) & 1) !== 0; }
  get isMeta() { return this.metaLayers !== null; }

  get defaultCutoff16() {
    if (this.cutoffOverride >= 0) return this.cutoffOverride;
    return this.filterSfMode
      ? ((this.defaultCutoff & 0xff) << 8) | (this.reserved[1] & 0xff)
      : this.defaultCutoff;
  }
  get defaultResonance16() {
    if (this.resonanceOverride >= 0) return this.resonanceOverride;
    return this.filterSfMode
      ? ((this.defaultResonance & 0xff) << 8) | (this.reserved[2] & 0xff)
      : this.defaultResonance;
  }

  /** First Ixmp patch whose pitch+volume rectangle contains the trigger, else null. */
  resolvePatch(noteVal, rowVolume) {
    const patches = this.extraPatches;
    if (patches === null) return null;
    for (const p of patches) {
      if (noteVal >= p.pitchStart && noteVal <= p.pitchEnd &&
          rowVolume >= p.volumeStart && rowVolume <= p.volumeEnd) return p;
    }
    return null;
  }

  /** All meta layers whose rectangle contains the trigger, in record order. */
  resolveMetaLayers(noteVal, rowVolume) {
    const layers = this.metaLayers;
    if (layers === null) return [];
    return layers.filter(
      (l) => noteVal >= l.pitchStart && noteVal <= l.pitchEnd &&
             rowVolume >= l.volStart && rowVolume <= l.volEnd
    );
  }

  /** Load a full 256-byte record; detects the Metainstrument sentinel
   *  (samplePtr high 16 bits == 0xFFFF) and parses its layer table. */
  loadRecord(b) {
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;
    const sp = ((b[0] & 0xff) | ((b[1] & 0xff) << 8) | ((b[2] & 0xff) << 16)) + (b[3] & 0xff) * 0x1000000;
    if (((sp >>> 16) & 0xffff) === 0xffff) {
      const count = (sp >>> 8) & 0xff; // byte 1 = layer count
      const layers = [];
      let o = 4;
      for (let n = 0; n < count; n++) {
        if (o + 10 > b.length) break;
        // 10-bit layer inst index: low 8 in byte 0, bits 8..9 in bits 6..7 of vol-start (+8).
        const instIdx = (b[o] & 0xff) | (((b[o + 8] >>> 6) & 0x3) << 8);
        const mixOctet = b[o + 1] & 0xff;
        const detRaw = (b[o + 2] & 0xff) | ((b[o + 3] & 0xff) << 8);
        const detune = detRaw >= 0x8000 ? detRaw - 0x10000 : detRaw;
        const pStart = (b[o + 4] & 0xff) | ((b[o + 5] & 0xff) << 8);
        const pEnd = (b[o + 6] & 0xff) | ((b[o + 7] & 0xff) << 8);
        const vStart = b[o + 8] & 0x3f;
        const vEnd = b[o + 9] & 0x3f;
        if (instIdx >= 1 && instIdx <= 1023 && instIdx !== this.index) {
          layers.push(makeMetaLayer(instIdx, mixOctet, detune, pStart, pEnd, vStart, vEnd));
        }
        o += 10;
      }
      this.metaLayers = layers.length === 0 ? null : layers;
      this.metaRaw = this.metaLayers !== null ? Uint8Array.from(b.slice(0, 256)) : null;
      this.metaStrict = this.metaLayers !== null && (b[0] & 0x01) !== 0;
      this.extraPatches = null;
    } else {
      this.metaLayers = null;
      this.metaRaw = null;
      this.metaStrict = false;
      const n = Math.min(256, b.length);
      for (let i = 0; i < n; i++) this.setByte(i, b[i] & 0xff);
    }
  }

  // Funk repeat mask — sized for the loop length; stale masks are discarded.
  toggleFunkBit(loopOffset) {
    const len = Math.max(this.sampleLoopEnd - this.sampleLoopStart, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.funkMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.funkMask = mask;
    }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
  }

  funkBit(loopOffset) {
    const mask = this.funkMask;
    if (mask === null) return false;
    const len = Math.max(this.sampleLoopEnd - this.sampleLoopStart, 1);
    if (mask.length !== (len + 7) >> 3) { this.funkMask = null; return false; }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    return ((mask[idx >> 3] >>> (idx & 7)) & 1) !== 0;
  }

  _envPointGet(env, base, offset) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    return (rel & 1) === 0 ? pt.value & 0xff : pt.offset & 0xff;
  }

  _envPointSet(env, base, offset, byte) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    if ((rel & 1) === 0) pt.value = byte;
    else pt.offset = byte & 0xff;
  }

  /** Read one record byte (0..255). Metainstruments serve verbatim metaRaw. */
  getByte(offset) {
    if (this.metaRaw !== null) return this.metaRaw[offset] & 0xff;
    return this.getByteNormal(offset);
  }

  getByteNormal(o) {
    if (o >= 21 && o <= 70) return this._envPointGet(this.volEnvelopes, 21, o);
    if (o >= 71 && o <= 120) return this._envPointGet(this.panEnvelopes, 71, o);
    if (o >= 121 && o <= 170) return this._envPointGet(this.pfEnvelopes, 121, o);
    if (o >= 201 && o <= 250) return this._envPointGet(this.pf2Envelopes, 201, o);
    if (o >= 252 && o <= 255) return this.reserved[o - 251];
    switch (o) {
      case 0: return this.samplePtr & 0xff;
      case 1: return (this.samplePtr >>> 8) & 0xff;
      case 2: return (this.samplePtr >>> 16) & 0xff;
      case 3: return (this.samplePtr >>> 24) & 0xff;
      case 4: return this.sampleLength & 0xff;
      case 5: return (this.sampleLength >>> 8) & 0xff;
      case 6: return this.samplingRate & 0xff;
      case 7: return (this.samplingRate >>> 8) & 0xff;
      case 8: return this.samplePlayStart & 0xff;
      case 9: return (this.samplePlayStart >>> 8) & 0xff;
      case 10: return this.sampleLoopStart & 0xff;
      case 11: return (this.sampleLoopStart >>> 8) & 0xff;
      case 12: return this.sampleLoopEnd & 0xff;
      case 13: return (this.sampleLoopEnd >>> 8) & 0xff;
      case 14: return this.loopMode & 0x17;
      case 15: return this.volEnvLoop & 0xff;
      case 16: return (this.volEnvLoop >>> 8) & 0xff;
      case 17: return this.panEnvLoop & 0xff;
      case 18: return (this.panEnvLoop >>> 8) & 0xff;
      case 19: return this.pfEnvLoop & 0xff;
      case 20: return (this.pfEnvLoop >>> 8) & 0xff;
      case 171: return this.instGlobalVolume & 0xff;
      case 172: return this.volumeFadeoutLow & 0xff;
      case 173: return this.fadeoutHigh & 0xff;
      case 174: return this.volumeSwing & 0xff;
      case 175: return this.vibratoSpeed & 0xff;
      case 176: return this.vibratoSweep & 0xff;
      case 177: return this.defaultPan & 0xff;
      case 178: return this.pitchPanCentre & 0xff;
      case 179: return (this.pitchPanCentre >>> 8) & 0xff;
      case 180: return this.pitchPanSeparation & 0xff;
      case 181: return this.panSwing & 0xff;
      case 182: return this.defaultCutoff & 0xff;
      case 183: return this.defaultResonance & 0xff;
      case 184: return this.sampleDetune & 0xff;
      case 185: return (this.sampleDetune >>> 8) & 0xff;
      case 186: return this.instrumentFlag & 0xff;
      case 187: return this.vibratoDepth & 0xff;
      case 188: return this.vibratoRate & 0xff;
      case 189: return this.volEnvSustainWord & 0xff;
      case 190: return (this.volEnvSustainWord >>> 8) & 0xff;
      case 191: return this.panEnvSustainWord & 0xff;
      case 192: return (this.panEnvSustainWord >>> 8) & 0xff;
      case 193: return this.pfEnvSustainWord & 0xff;
      case 194: return (this.pfEnvSustainWord >>> 8) & 0xff;
      case 195: return this.dupCheckFlag & 0xff;
      case 196: return this.defaultNoteVolume & 0xff;
      case 197: return this.pf2EnvLoop & 0xff;
      case 198: return (this.pf2EnvLoop >>> 8) & 0xff;
      case 199: return this.pf2EnvSustainWord & 0xff;
      case 200: return (this.pf2EnvSustainWord >>> 8) & 0xff;
      case 251: return this.initialAttenOctet & 0xff;
      default: throw new Error(`Bad offset ${o}`);
    }
  }

  setByte(o, byte) {
    if (o >= 21 && o <= 70) return this._envPointSet(this.volEnvelopes, 21, o, byte);
    if (o >= 71 && o <= 120) return this._envPointSet(this.panEnvelopes, 71, o, byte);
    if (o >= 121 && o <= 170) return this._envPointSet(this.pfEnvelopes, 121, o, byte);
    if (o >= 201 && o <= 250) return this._envPointSet(this.pf2Envelopes, 201, o, byte);
    if (o >= 252 && o <= 255) { this.reserved[o - 251] = byte & 0xff; return; }
    switch (o) {
      case 0: this.samplePtr = (this.samplePtr & 0xffffff00) | byte; break;
      case 1: this.samplePtr = (this.samplePtr & 0xffff00ff) | (byte << 8); break;
      case 2: this.samplePtr = (this.samplePtr & 0xff00ffff) | (byte << 16); break;
      case 3: this.samplePtr = ((this.samplePtr & 0x00ffffff) | (byte << 24)) >>> 0; break;
      case 4: this.sampleLength = (this.sampleLength & 0xff00) | byte; break;
      case 5: this.sampleLength = (this.sampleLength & 0x00ff) | (byte << 8); break;
      case 6: this.samplingRate = (this.samplingRate & 0xff00) | byte; break;
      case 7: this.samplingRate = (this.samplingRate & 0x00ff) | (byte << 8); break;
      case 8: this.samplePlayStart = (this.samplePlayStart & 0xff00) | byte; break;
      case 9: this.samplePlayStart = (this.samplePlayStart & 0x00ff) | (byte << 8); break;
      case 10: this.sampleLoopStart = (this.sampleLoopStart & 0xff00) | byte; break;
      case 11: this.sampleLoopStart = (this.sampleLoopStart & 0x00ff) | (byte << 8); break;
      case 12: this.sampleLoopEnd = (this.sampleLoopEnd & 0xff00) | byte; break;
      case 13: this.sampleLoopEnd = (this.sampleLoopEnd & 0x00ff) | (byte << 8); break;
      case 14: this.loopMode = byte & 0x17; break;
      case 15: this.volEnvLoop = (this.volEnvLoop & 0xff00) | byte; break;
      case 16: this.volEnvLoop = (this.volEnvLoop & 0x00ff) | (byte << 8); break;
      case 17: this.panEnvLoop = (this.panEnvLoop & 0xff00) | byte; break;
      case 18: this.panEnvLoop = (this.panEnvLoop & 0x00ff) | (byte << 8); break;
      case 19: this.pfEnvLoop = (this.pfEnvLoop & 0xff00) | byte; break;
      case 20: this.pfEnvLoop = (this.pfEnvLoop & 0x00ff) | (byte << 8); break;
      case 171: this.instGlobalVolume = byte & 0xff; break;
      case 172: this.volumeFadeoutLow = byte & 0xff; break;
      case 173: this.fadeoutHigh = byte & 0x1f; break; // bits 0-3 fadeout high, bit 4 SF filter mode
      case 174: this.volumeSwing = byte & 0xff; break;
      case 175: this.vibratoSpeed = byte & 0xff; break;
      case 176: this.vibratoSweep = byte & 0xff; break;
      case 177: this.defaultPan = byte & 0xff; break;
      case 178: this.pitchPanCentre = (this.pitchPanCentre & 0xff00) | byte; break;
      case 179: this.pitchPanCentre = (this.pitchPanCentre & 0x00ff) | (byte << 8); break;
      case 180: this.pitchPanSeparation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 181: this.panSwing = byte & 0xff; break;
      case 182: this.defaultCutoff = byte & 0xff; break;
      case 183: this.defaultResonance = byte & 0xff; break;
      case 184: this.sampleDetune = (this.sampleDetune & 0xff00) | byte; break;
      case 185: this.sampleDetune = (this.sampleDetune & 0x00ff) | (byte << 8); break;
      case 186: this.instrumentFlag = byte & 0xff; break;
      case 187: this.vibratoDepth = byte & 0xff; break;
      case 188: this.vibratoRate = byte & 0xff; break;
      case 189: this.volEnvSustainWord = (this.volEnvSustainWord & 0xff00) | byte; break;
      case 190: this.volEnvSustainWord = (this.volEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 191: this.panEnvSustainWord = (this.panEnvSustainWord & 0xff00) | byte; break;
      case 192: this.panEnvSustainWord = (this.panEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 193: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0xff00) | byte; break;
      case 194: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 195: this.dupCheckFlag = byte & 0x0f; break;
      case 196: this.defaultNoteVolume = byte & 0xff; break;
      case 197: this.pf2EnvLoop = (this.pf2EnvLoop & 0xff00) | byte; break;
      case 198: this.pf2EnvLoop = (this.pf2EnvLoop & 0x00ff) | (byte << 8); break;
      case 199: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0xff00) | byte; break;
      case 200: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0x00ff) | (byte << 8); break;
      case 251: this.initialAttenOctet = byte & 0xff; break;
      default: throw new Error(`Bad offset ${o}`);
    }
  }
}
