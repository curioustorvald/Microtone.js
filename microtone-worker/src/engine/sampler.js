// Sample fetch + interpolators + anti-click ramps — port of AudioAdapter.kt
// computePlaybackRate (1515), readSamplePoint (2211), fetchTrackerSample (2221),
// startRampOut (2341), startFastFade (2357), advanceVolumeRamp (2376).
//
// `eng` is the TaudEngine instance (carries sampleBin as a Uint8Array; playback
// addresses the 8 MB pool directly by samplePtr — banking is a device-protocol
// concern that does not exist here).

import {
  SAMPLING_RATE, MIDDLE_C, SAMPLE_BIN_TOTAL,
  INTERP_DEFAULT, INTERP_NONE, INTERP_A500, INTERP_A1200, INTERP_SNES, INTERP_NES_DPCM,
  SINC_WIDTH, RAMP_OUT_SAMPLES, FAST_FADE_SEC, VOL_RAMP_SAMPLES,
} from "./constants.js";
import { sincTap, SNES_GAUSS } from "./tables.js";

/** Active-sample-aware playback rate (patch-aware via the voice snapshot). */
export function computePlaybackRate(voice, noteVal) {
  return (voice.activeSamplingRate / SAMPLING_RATE) *
         2 ** ((noteVal - MIDDLE_C + voice.activeSampleDetune) / 4096.0);
}

/**
 * Read one PCM sample (in [-1,1]) at integer index idx, honouring the
 * instrument's funk-repeat mask. Caller wraps loop regions first.
 */
export function readSamplePoint(eng, voice, inst, idx, sampleLen, binMax) {
  const i = Math.min(Math.max(idx, 0), sampleLen - 1);
  let b = eng.sampleBin[Math.min(voice.activeSamplePtr + i, binMax)];
  if (inst.funkMask !== null && inst.sampleLoopEnd > inst.sampleLoopStart) {
    const ls = inst.sampleLoopStart;
    if (i >= ls && i < inst.sampleLoopEnd && inst.funkBit(i - ls)) b = b ^ 0xff;
  }
  return (b - 127.5) / 127.5;
}

export function fetchTrackerSample(eng, voice, inst, interpMode) {
  if (inst.index === 0) return 0.0;

  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const loopStart = voice.activeSampleLoopStart;
  const loopEnd = Math.max(voice.activeSampleLoopEnd, 1.0);
  const binMax = SAMPLE_BIN_TOTAL - 1;

  const i0 = Math.min(Math.max(Math.trunc(voice.samplePos), 0), sampleLen - 1);
  const frac = voice.samplePos - i0;

  let sample;
  switch (interpMode) {
    case INTERP_DEFAULT: {
      let acc = 0.0;
      for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
        const coeff = sincTap(frac, j);
        if (coeff !== 0.0) acc += readSamplePoint(eng, voice, inst, i0 + j, sampleLen, binMax) * coeff;
      }
      sample = acc;
      break;
    }
    case INTERP_SNES: {
      // SNES BRR 4-tap gaussian with the int16 mid-sum overflow "chirp" preserved.
      const oldest = Math.trunc(readSamplePoint(eng, voice, inst, i0 - 1, sampleLen, binMax) * 32767.0);
      const olders = Math.trunc(readSamplePoint(eng, voice, inst, i0, sampleLen, binMax) * 32767.0);
      const olds = Math.trunc(readSamplePoint(eng, voice, inst, i0 + 1, sampleLen, binMax) * 32767.0);
      const news = Math.trunc(readSamplePoint(eng, voice, inst, i0 + 2, sampleLen, binMax) * 32767.0);
      const offset = Math.min(Math.max(Math.trunc(frac * 256.0), 0), 255);
      let out = (SNES_GAUSS[0xff - offset] * oldest) >> 10;
      out += (SNES_GAUSS[0x1ff - offset] * olders) >> 10;
      out += (SNES_GAUSS[0x100 + offset] * olds) >> 10;
      out = (out << 16) >> 16; // int16 wrap (the hardware overflow)
      out += (SNES_GAUSS[offset] * news) >> 10;
      out = Math.min(Math.max(out, -32768), 32767);
      sample = (out >> 1) / 16384.0;
      break;
    }
    case INTERP_NES_DPCM: {
      // NES 2A03 DMC 1-bit sigma-delta simulation (±2 slew on a 7-bit counter).
      const target = readSamplePoint(eng, voice, inst, i0, sampleLen, binMax);
      const targetLevel = Math.min(Math.max(Math.trunc((target + 1.0) * 63.5), 0), 127);
      if (targetLevel > voice.nesDpcmCounter && voice.nesDpcmCounter <= 125) {
        voice.nesDpcmCounter += 2;
      } else if (targetLevel < voice.nesDpcmCounter && voice.nesDpcmCounter >= 2) {
        voice.nesDpcmCounter -= 2;
      }
      sample = (voice.nesDpcmCounter - 63.5) / 63.5;
      break;
    }
    case INTERP_NONE:
    case INTERP_A500:
    case INTERP_A1200:
    default:
      // Paula-style ZOH; aliasing removed by the post-mix Amiga LPFs.
      sample = readSamplePoint(eng, voice, inst, i0, sampleLen, binMax);
      break;
  }

  // While ramping out at sample end, hold position (mixer emits with decaying gain).
  if (voice.rampOutSamples > 0) return sample;

  if (voice.forward) {
    voice.samplePos += voice.playbackRate;
    // Sustain bit set + key-off ⇒ escape the loop (loopMode 0 semantics).
    const effectiveLoopMode =
      voice.activeSampleLoopSustain && voice.keyOff ? 0 : voice.activeLoopMode & 3;
    switch (effectiveLoopMode) {
      case 0:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
      case 1:
        if (voice.samplePos >= loopEnd) voice.samplePos -= Math.max(loopEnd - loopStart, 1.0);
        break;
      case 2:
        if (voice.samplePos >= loopEnd) { voice.samplePos = loopEnd; voice.forward = false; }
        break;
      case 3:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
    }
  } else {
    voice.samplePos -= voice.playbackRate;
    if (voice.samplePos < loopStart) { voice.samplePos = loopStart; voice.forward = true; }
  }
  return sample;
}

/** Engage the MilkyTracker-style sample-end ramp (no-op if already ramping). */
export function startRampOut(voice) {
  if (voice.rampOutSamples > 0) return;
  voice.rampOutSamples = RAMP_OUT_SAMPLES;
  voice.rampOutGain = 1.0;
  voice.rampOutStep = 1.0 / RAMP_OUT_SAMPLES;
}

/** Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke, ≈0.3 s). */
export function startFastFade(voice, playhead) {
  if (!voice.active) return;
  voice.noteFading = true;
  const ticks = Math.max(FAST_FADE_SEC * playhead.bpm * 0.4, 1.0);
  voice.activeFadeoutStep = Math.min(Math.max(Math.round(1024.0 / ticks), 1), 0xfff);
}

/** Per-sample volume-ramp tick toward (rowVolume/63)·(channelVolume/63). */
export function advanceVolumeRamp(voice) {
  const target = (voice.rowVolume / 63.0) * (voice.channelVolume / 63.0);
  if (voice.snapMixVolume) {
    voice.currentMixVolume = target;
    voice.volRampSamples = 0;
    voice.volRampStep = 0.0;
    voice.snapMixVolume = false;
    return;
  }
  if (voice.volRampSamples > 0) {
    voice.currentMixVolume += voice.volRampStep;
    voice.volRampSamples--;
    if (voice.volRampSamples === 0) voice.currentMixVolume = target;
  } else if (voice.currentMixVolume !== target) {
    voice.volRampStep = (target - voice.currentMixVolume) / VOL_RAMP_SAMPLES;
    voice.volRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentMixVolume += voice.volRampStep;
  }
}
