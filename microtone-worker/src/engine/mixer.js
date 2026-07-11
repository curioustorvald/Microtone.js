// Mixer + output quantiser — port of AudioAdapter.kt generateTrackerAudio
// (4128-4315) and pcm32fToPcm8 (839-873).
//
// The mix bus is Float32 (ts.mixLeft/mixRight Float32Array; typed-array stores
// round like Kotlin's .toFloat()). pcm32fToPcm8 runs Kotlin-Float semantics via
// Math.fround at every arithmetic step, and draws its TPDF dither from the
// engine's seeded xorshift32 stream — so the U8 output is deterministic.

import {
  SAMPLING_RATE, TRACKER_CHUNK, SCOPE_BUFFER_SIZE,
  INTERP_A500, INTERP_A1200,
} from "./constants.js";
import {
  AMIGA_A500_A0, AMIGA_A500_B1,
  AMIGA_LED_A1, AMIGA_LED_A2, AMIGA_LED_B1, AMIGA_LED_B2,
} from "./tables.js";
import { fetchTrackerSample, advanceVolumeRamp } from "./sampler.js";
import { applyVoiceFilter, applyTaudVoiceFx } from "./filter.js";
import { applyTrackerRow, advanceRow } from "./row.js";
import { applyTrackerTick } from "./tick.js";

const fround = Math.fround;

/** urand: (xorshift32() & 0xFFFFFF) / 16777216 — exact in Float32. */
function urand(eng) {
  return (eng.xorshift32() & 0xffffff) / 16777216.0;
}

/** TPDF noise in [-1, +1) — difference of two urands, exact in Float32. */
function tpdf1(eng) {
  return urand(eng) - urand(eng);
}

/**
 * Noise-shaped dither 32f → interleaved U8, writing into out (length ≥ 2·sampleCount).
 * State: eng.ditherError = Float32Array(4) [L0, L1, R0, R1].
 */
export function pcm32fToPcm8(eng, fleft, fright, sampleCount, out) {
  const b1 = 1.5;
  const b2 = -0.75;
  const scale = 127.5;
  const bias = 128;
  const ditherScale = 0.2; // fround(0.2) applied at the multiply below
  const err = eng.ditherError;

  for (let i = 0; i < sampleCount; i++) {
    // --- LEFT channel ---
    const feedbackL = fround(fround(b1 * err[0]) + fround(b2 * err[1]));
    const ditherL = fround(fround(ditherScale) * tpdf1(eng));
    let shapedL = fround(fround(fleft[i] + feedbackL) + fround(ditherL / scale));
    shapedL = shapedL < -1.0 ? -1.0 : shapedL > 1.0 ? 1.0 : shapedL;

    let qL = Math.round(fround(shapedL * scale));
    qL = qL < -128 ? -128 : qL > 127 ? 127 : qL;
    out[i * 2] = (qL + bias) & 0xff;

    const qerrL = fround(shapedL - fround(qL / scale));
    err[1] = err[0];
    err[0] = qerrL;

    // --- RIGHT channel ---
    const feedbackR = fround(fround(b1 * err[2]) + fround(b2 * err[3]));
    const ditherR = fround(fround(ditherScale) * tpdf1(eng));
    let shapedR = fround(fround(fright[i] + feedbackR) + fround(ditherR / scale));
    shapedR = shapedR < -1.0 ? -1.0 : shapedR > 1.0 ? 1.0 : shapedR;

    let qR = Math.round(fround(shapedR * scale));
    qR = qR < -128 ? -128 : qR > 127 ? 127 : qR;
    out[i * 2 + 1] = (qR + bias) & 0xff;

    const qerrR = fround(shapedR - fround(qR / scale));
    err[3] = err[2];
    err[2] = qerrR;
  }
}

/**
 * Render one 512-frame chunk for playhead into out (Uint8Array(1024), interleaved
 * U8 L,R). Returns null when the playhead has no tracker state.
 */
export function generateTrackerAudio(eng, playhead, out) {
  const ts = playhead.trackerState;
  if (ts === null) return null;

  // Jam mode mixes voices without advancing rows/cues.
  const advancing = playhead.isPlaying;

  if (advancing && ts.firstRow) {
    ts.firstRow = false;
    applyTrackerRow(eng, ts, playhead);
  }

  for (let n = 0; n < TRACKER_CHUNK; n++) {
    // Recompute samples-per-tick every iteration (T/T-slide mutate BPM mid-row).
    const spt = (SAMPLING_RATE * 2.5) / playhead.bpm;
    if (advancing) {
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
        ts.tickInRow++;
        if (ts.tickInRow >= playhead.tickRate + ts.finePatternDelayExtra) {
          ts.tickInRow = 0;
          advanceRow(eng, ts, playhead);
        }
      }
    } else { // jamActive: evolve envelopes only, never advance the song
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
      }
    }

    let mixL = 0.0;
    let mixR = 0.0;
    const gvol = playhead.globalVolume / 255.0;
    const mvol = playhead.mixingVolume / 255.0;
    for (const voice of ts.voices) {
      if (!voice.active || voice.fader === 255) {
        // Keep the soundscope flat between notes / while muted.
        voice.scopeBuffer[voice.scopeWritePos] = 0;
        voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
        continue;
      }
      const voiceInst = eng.instruments[voice.instrumentId];
      const s = applyTaudVoiceFx(voice,
        applyVoiceFilter(voice, fetchTrackerSample(eng, voice, voiceInst, ts.interpolationMode)));
      const instGv = voiceInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + voice.randomVolBias / 255.0;
      // Per-sample envelope smoothing.
      voice.envVolMix += voice.envVolStep;
      const effEnvVol = voice.volEnvOn ? voice.envVolMix : 1.0;
      advanceVolumeRamp(voice);
      const faderGain = (255 - voice.fader) / 255.0;
      const perVoiceGain = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume *
        swingScale * instGv * faderGain * voice.layerMixGain * voice.activeAttenGain;
      const globalGain = (gvol * mvol * playhead.masterVolume) / 255.0;
      const vol = perVoiceGain * globalGain;
      let pan;
      if (voice.hasPanEnv && voice.panEnvOn) {
        let envPanRaw = Math.round(voice.envPan * 255.0);
        envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
        pan = voice.channelPan + envPanRaw - 128 + voice.randomPanBias;
      } else {
        pan = voice.channelPan + voice.randomPanBias;
      }
      pan = pan < 0 ? 0 : pan > 255 ? 255 : pan;
      // equal-energy pan law
      const lGain = Math.cos((Math.PI * pan) / 512.0);
      const rGain = Math.sin((Math.PI * pan) / 512.0);
      // Sample-end ramp-out.
      let rampGain;
      if (voice.rampOutSamples > 0) {
        rampGain = voice.rampOutGain;
        voice.rampOutGain -= voice.rampOutStep;
        voice.rampOutSamples--;
        if (voice.rampOutSamples === 0) voice.active = false;
      } else {
        rampGain = 1.0;
      }
      voice.scopeBuffer[voice.scopeWritePos] = s * perVoiceGain * rampGain;
      voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
      mixL += s * vol * lGain * rampGain;
      mixR += s * vol * rGain * rampGain;
    }
    // Background (NNA-ghost) voices.
    for (const bg of ts.backgroundVoices) {
      if (!bg.active || bg.fader === 255) continue;
      const bgInst = eng.instruments[bg.instrumentId];
      const s = applyTaudVoiceFx(bg,
        applyVoiceFilter(bg, fetchTrackerSample(eng, bg, bgInst, ts.interpolationMode)));
      const instGv = bgInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + bg.randomVolBias / 255.0;
      bg.envVolMix += bg.envVolStep;
      const effEnvVol = bg.volEnvOn ? bg.envVolMix : 1.0;
      advanceVolumeRamp(bg);
      const faderGain = (255 - bg.fader) / 255.0;
      const vol = (effEnvVol * bg.fadeoutVolume * bg.currentMixVolume *
        swingScale * gvol * mvol * instGv * faderGain * bg.layerMixGain * bg.activeAttenGain *
        playhead.masterVolume) / 255.0;
      let pan;
      if (bg.hasPanEnv && bg.panEnvOn) {
        let envPanRaw = Math.round(bg.envPan * 255.0);
        envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
        pan = bg.channelPan + envPanRaw - 128 + bg.randomPanBias;
      } else {
        pan = bg.channelPan + bg.randomPanBias;
      }
      pan = pan < 0 ? 0 : pan > 255 ? 255 : pan;
      const lGain = Math.cos((Math.PI * pan) / 512.0);
      const rGain = Math.sin((Math.PI * pan) / 512.0);
      let rampGain;
      if (bg.rampOutSamples > 0) {
        rampGain = bg.rampOutGain;
        bg.rampOutGain -= bg.rampOutStep;
        bg.rampOutSamples--;
        if (bg.rampOutSamples === 0) bg.active = false;
      } else {
        rampGain = 1.0;
      }
      mixL += s * vol * lGain * rampGain;
      mixR += s * vol * rGain * rampGain;
    }

    // Amiga interpolation modes: post-mix LPF chain.
    if (ts.interpolationMode === INTERP_A500) {
      ts.amigaLPStateL = mixL * AMIGA_A500_A0 + ts.amigaLPStateL * AMIGA_A500_B1;
      ts.amigaLPStateR = mixR * AMIGA_A500_A0 + ts.amigaLPStateR * AMIGA_A500_B1;
      mixL = ts.amigaLPStateL;
      mixR = ts.amigaLPStateR;
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * AMIGA_LED_A1 + sl[0] * AMIGA_LED_A2 + sl[1] * AMIGA_LED_A1 - sl[2] * AMIGA_LED_B1 - sl[3] * AMIGA_LED_B2;
        const outR = mixR * AMIGA_LED_A1 + sr[0] * AMIGA_LED_A2 + sr[1] * AMIGA_LED_A1 - sr[2] * AMIGA_LED_B1 - sr[3] * AMIGA_LED_B2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    } else if (ts.interpolationMode === INTERP_A1200) {
      // A1200 1-pole LPF is above Nyquist at 32 kHz → bypassed (pt2-clone).
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * AMIGA_LED_A1 + sl[0] * AMIGA_LED_A2 + sl[1] * AMIGA_LED_A1 - sl[2] * AMIGA_LED_B1 - sl[3] * AMIGA_LED_B2;
        const outR = mixR * AMIGA_LED_A1 + sr[0] * AMIGA_LED_A2 + sr[1] * AMIGA_LED_A1 - sr[2] * AMIGA_LED_B1 - sr[3] * AMIGA_LED_B2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    }

    // Double → Float32 (like Kotlin .toFloat()), then clamp in float space.
    const fl = fround(mixL);
    const fr = fround(mixR);
    ts.mixLeft[n] = fl < -1.0 ? -1.0 : fl > 1.0 ? 1.0 : fl;
    ts.mixRight[n] = fr < -1.0 ? -1.0 : fr > 1.0 ? 1.0 : fr;
  }

  pcm32fToPcm8(eng, ts.mixLeft, ts.mixRight, TRACKER_CHUNK, out);

  // Stop the jam-render spin once the audition has gone fully silent.
  if (playhead.jamActive && !playhead.isPlaying &&
      !ts.voices.some((v) => v.active) && !ts.backgroundVoices.some((v) => v.active)) {
    playhead.jamActive = false;
  }

  return out;
}
