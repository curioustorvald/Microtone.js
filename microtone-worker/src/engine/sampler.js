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

/**
 * Active-sample-aware playback rate (patch-aware via the voice snapshot).
 *
 * `tuningRatio` is the song's tuning (item 77, ts.tuningRatio) — a whole-song
 * frequency scale applied last. Concert-tuned songs pass exactly 1.0, which is
 * an identity multiply, so they render bit-for-bit as if tuning did not exist.
 */
export function computePlaybackRate(voice, noteVal, tuningRatio = 1.0) {
  return (voice.activeSamplingRate / SAMPLING_RATE) *
         2 ** ((noteVal - MIDDLE_C + voice.activeSampleDetune) / 4096.0) *
         tuningRatio;
}

/**
 * Read one PCM sample (in [-1,1]) at integer index idx, honouring the
 * instrument's funk-repeat mask. Caller wraps loop regions first.
 * `basePtr` is the pool address of the channel being read — voice.activeSamplePtr
 * for a mono voice or the first channel of a stereo pair, voice.activeChanPtr2
 * for its right channel (both channels share the funk mask and geometry).
 */
export function readSamplePoint(eng, voice, inst, idx, sampleLen, binMax,
                                basePtr = voice.activeSamplePtr) {
  const i = Math.min(Math.max(idx, 0), sampleLen - 1);
  let b = eng.sampleBin[Math.min(basePtr + i, binMax)];
  if (inst.funkMask !== null && inst.sampleLoopEnd > inst.sampleLoopStart) {
    const ls = inst.sampleLoopStart;
    if (i >= ls && i < inst.sampleLoopEnd && inst.funkBit(i - ls)) b = b ^ 0xff;
  }
  return (b - 127.5) / 127.5;
}

/**
 * Promote a [-1,1] PCM sample to the SNES DSP's signed 15-bit domain
 * (-4000h..+3FFFh). The gaussian's four coefficients sum to ~800h while every
 * tap is only SAR 10, so the running sum sits at ~2x the sample and stays
 * inside int16 ONLY while the input is 15-bit — feed the DSP 16-bit samples and
 * the mid-sum wrap fires on everything past half scale, folding loud waveforms
 * inside out instead of chirping on the rare hardware case. -1.0 must map to
 * exactly -16384, which is what arms the documented 801h overflow (three
 * max-negative samples read back as +3FF8h).
 */
function pcmTo15Bit(x) {
  return Math.min(Math.round(x * 16384.0), 16383);
}

/**
 * Interpolate ONE channel at the voice's current position WITHOUT advancing it.
 * `basePtr` selects the channel's pool span and `st` its DPCM counter (the
 * Voice itself for channel 1, voice.right for a stereo right channel).
 */
function interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st) {
  const i0 = Math.min(Math.max(Math.trunc(voice.samplePos), 0), sampleLen - 1);
  const frac = voice.samplePos - i0;

  switch (interpMode) {
    case INTERP_DEFAULT: {
      let acc = 0.0;
      for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
        const coeff = sincTap(frac, j);
        if (coeff !== 0.0) acc += readSamplePoint(eng, voice, inst, i0 + j, sampleLen, binMax, basePtr) * coeff;
      }
      return acc;
    }
    case INTERP_SNES: {
      // SNES BRR 4-tap gaussian, with the hardware's partial overflow handling
      // preserved: of the three additions the 2nd WRAPS (the gauss "chirp") and
      // only the 3rd saturates (fullsnes §snesapudspbrrpitch).
      const oldest = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 - 1, sampleLen, binMax, basePtr));
      const olders = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr));
      const olds = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 1, sampleLen, binMax, basePtr));
      const news = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 2, sampleLen, binMax, basePtr));
      const offset = Math.min(Math.max(Math.trunc(frac * 256.0), 0), 255);
      let out = (SNES_GAUSS[0xff - offset] * oldest) >> 10;
      out += (SNES_GAUSS[0x1ff - offset] * olders) >> 10;   // 1st add: cannot overflow
      out += (SNES_GAUSS[0x100 + offset] * olds) >> 10;     // 2nd add: overflows for i<0x20…
      out = (out << 16) >> 16;                              // …and the hardware lets it wrap
      out += (SNES_GAUSS[offset] * news) >> 10;             // 3rd add: saturated, not wrapped
      out = Math.min(Math.max(out, -32768), 32767);
      return (out >> 1) / 16384.0;
    }
    case INTERP_NES_DPCM: {
      // NES 2A03 DMC 1-bit sigma-delta simulation (±2 slew on a 7-bit counter).
      const target = readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
      const targetLevel = Math.min(Math.max(Math.trunc((target + 1.0) * 63.5), 0), 127);
      if (targetLevel > st.nesDpcmCounter && st.nesDpcmCounter <= 125) {
        st.nesDpcmCounter += 2;
      } else if (targetLevel < st.nesDpcmCounter && st.nesDpcmCounter >= 2) {
        st.nesDpcmCounter -= 2;
      }
      return (st.nesDpcmCounter - 63.5) / 63.5;
    }
    case INTERP_NONE:
    case INTERP_A500:
    case INTERP_A1200:
    default:
      // Paula-style ZOH; aliasing removed by the post-mix Amiga LPFs.
      return readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
  }
}

/**
 * Fetch BOTH channels of a stereo voice at one position, then advance once —
 * the pair is one sample of one voice, so pitch, loop wrapping and the
 * sample-end ramp are shared. Writes [ch1, ch2] into `out` (a length-2 array
 * the mixer recycles). Channel meaning is the patch's chanMode: discrete L,R
 * or matrix M,S (the mixer decodes).
 */
export function fetchTrackerSampleStereo(eng, voice, inst, interpMode, out) {
  if (inst.index === 0) { out[0] = 0.0; out[1] = 0.0; return out; }
  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  out[0] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);
  out[1] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeChanPtr2, voice.right);
  if (voice.rampOutSamples <= 0) advanceSamplePos(voice, sampleLen);
  return out;
}

export function fetchTrackerSample(eng, voice, inst, interpMode) {
  if (inst.index === 0) return 0.0;

  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  const sample = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);

  // While ramping out at sample end, hold position (mixer emits with decaying gain).
  if (voice.rampOutSamples > 0) return sample;
  advanceSamplePos(voice, sampleLen);
  return sample;
}

/** Step samplePos by the playback rate and apply the loop/end rules. */
function advanceSamplePos(voice, sampleLen) {
  const loopStart = voice.activeSampleLoopStart;
  const loopEnd = Math.max(voice.activeSampleLoopEnd, 1.0);
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

/** Per-sample volume-ramp tick toward (rowVolume/max)·(channelVolume/max).
 *  `div` is the volume column's ceiling: 63 as ever, 255 for a wide cell. */
export function advanceVolumeRamp(voice, div = 63.0) {
  const target = (voice.rowVolume / div) * (voice.channelVolume / div);
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
