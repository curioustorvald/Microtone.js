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
  SINC_WIDTH, RAMP_OUT_SAMPLES, ATTACK_RAMP_SAMPLES, FAST_FADE_SEC, VOL_RAMP_SAMPLES,
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
  // Loop points come from the ACTIVE view: an Ixmp patch replaces them, and the
  // funk mask is sized and indexed against whichever loop is sounding (item 116).
  const ls = voice.activeSampleLoopStart;
  const le = voice.activeSampleLoopEnd;
  if (inst.funkMask !== null && le > ls) {
    if (i >= ls && i < le && inst.funkBit(i - ls, le - ls)) b = b ^ 0xff;
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
    voice.samplePos += voice.currentPlaybackRate;
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
    voice.samplePos -= voice.currentPlaybackRate;
    if (voice.samplePos < loopStart) { voice.samplePos = loopStart; voice.forward = true; }
  }
}

/** Engage a linear ramp to silence over `samples`, and stop there. No-op if one
 *  is already running — a voice that is already fading does not restart. */
function beginRampOut(voice, samples) {
  if (voice.rampOutSamples > 0) return;
  voice.rampOutSamples = samples;
  voice.rampOutGain = 1.0;
  voice.rampOutStep = 1.0 / samples;
}

/** Engage the MilkyTracker-style sample-end ramp (no-op if already ramping). */
export function startRampOut(voice) {
  beginRampOut(voice, RAMP_OUT_SAMPLES);
}

/**
 * Note-cut ramp (note word 0x0002, and S $Dxny's $n=1). A cut used to drop
 * `active` on the spot, so a cut landing mid-cycle stepped straight to zero and
 * clicked — audible on anything with body to it.
 *
 * The ramp is the ATTACK one's 32 samples (~0.67 ms at 48 kHz), not the 8 ms
 * sample-end ramp: a cut is a rhythmic event, often on a fast row, and 8 ms
 * would round off the very transient the cut is being used to place. Short
 * enough to still read as a cut, long enough to have no edge in it.
 *
 * Note the sample position FREEZES while ramping (see the caller of
 * advanceSamplePos), so this is the last sample held and faded rather than
 * playback continuing under a fade — which is what the sample-end ramp does
 * too, and over 32 samples the difference is inaudible.
 */
export function startCutRamp(voice) {
  beginRampOut(voice, ATTACK_RAMP_SAMPLES);
}

/** Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke, ≈0.3 s). */
export function startFastFade(voice, playhead) {
  if (!voice.active) return;
  voice.noteFading = true;
  const ticks = Math.max(FAST_FADE_SEC * playhead.bpm * 0.4, 1.0);
  voice.activeFadeoutStep = Math.min(Math.max(Math.round(1024.0 / ticks), 1), 0xfff);
}

/**
 * Per-sample pitch glide toward the tick's playbackRate, spread over one tick
 * (`spt` samples) so the control signal is INTERPOLATED rather than stepped.
 * A fresh trigger snaps: a new note starts at its own pitch, it does not bend
 * up from whatever the channel was last playing.
 */
export function advancePitchRamp(voice, spt) {
  const target = voice.playbackRate;
  if (voice.snapPlaybackRate) {
    voice.currentPlaybackRate = target;
    voice.pitchRampSamples = 0;
    voice.pitchRampStep = 0.0;
    voice.snapPlaybackRate = false;
    return;
  }
  if (voice.pitchRampSamples > 0) {
    voice.currentPlaybackRate += voice.pitchRampStep;
    voice.pitchRampSamples--;
    if (voice.pitchRampSamples === 0) voice.currentPlaybackRate = target;
  } else if (voice.currentPlaybackRate !== target) {
    const n = spt >= 1 ? Math.round(spt) : 1;
    voice.pitchRampStep = (target - voice.currentPlaybackRate) / n;
    voice.pitchRampSamples = n - 1;
    voice.currentPlaybackRate += voice.pitchRampStep;
  }
}

/**
 * Per-sample pan ramp toward `target` (0..255), the sibling of the volume ramp
 * and over the same 2 ms. Ramping the PAN rather than the two gains means one
 * ramp covers everything that moves it — the slide, the panbrello, the pan
 * envelope, the pan column and S $80xx all feed this one number.
 *
 * Returns the value to use this sample.
 */
export function advancePanRamp(voice, target, wrap = false) {
  // A surround azimuth WRAPS at AZIMUTH_TURN (512 units, the 9-bit S $8xxx
  // circle — NOT the stereo pan's 256): ramping 500 -> 12 the arithmetic way
  // would sweep the long way round the whole circle. Take the short way.
  if (wrap && !voice.snapPan) {
    const d = target - voice.currentPan;
    if (d > 256) voice.currentPan += 512;
    else if (d < -256) voice.currentPan -= 512;
  }
  if (voice.snapPan) {
    voice.currentPan = target;
    voice.panRampSamples = 0;
    voice.panRampStep = 0.0;
    voice.snapPan = false;
    return target;
  }
  if (voice.panRampSamples > 0) {
    voice.currentPan += voice.panRampStep;
    voice.panRampSamples--;
    if (voice.panRampSamples === 0) voice.currentPan = target;
  } else if (voice.currentPan !== target) {
    voice.panRampStep = (target - voice.currentPan) / VOL_RAMP_SAMPLES;
    voice.panRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentPan += voice.panRampStep;
  }
  if (wrap) {
    if (voice.currentPan < 0) voice.currentPan += 512;
    else if (voice.currentPan >= 512) voice.currentPan -= 512;
  }
  return voice.currentPan;
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
