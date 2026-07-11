// TaudProcessor — AudioWorkletProcessor with two modes:
//
//   RENDER mode (non-isolated fallback): hosts the TaudEngine and renders
//     32 kHz U8/float chunks into a local FIFO ring, reading them back with a
//     fractional resample cursor. This is the original single-thread path.
//
//   CONSUME mode (Tier 2, crossOriginIsolated): the engine lives in a separate
//     render Worker that fills a SharedArrayBuffer audio ring; process() only
//     resamples + copies from that ring, so it can never overrun. Entered on
//     CMD.USE_AUDIO_SAB; no engine commands are routed here in this mode.
//
// The engine ALWAYS produces 32 kHz; when the context rate isn't 32000 the ring
// is read with a fractional cursor + linear interpolation. Loaded via
// audioWorklet.addModule() as an ES module; the committed single-file concat
// (taud-processor.bundle.js) is the non-module-worklet fallback — regenerate
// with tools/make-worklet-bundle.js after any change here.

import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { CMD, MSG, SNAP_INTERRUPT_MASK, SNAP_FLOATS } from "./protocol.js";
import { applyAudioCommand, funkMaskBuffer, fillSnapshotInto } from "./engine-commands.js";
import {
  audioRingViews, AR_MASK, AR_WRITE, AR_READ, AR_STATE, AR_EPOCH, AR_FLUSH_POS,
} from "../audio/audio-ring.js";

const RING_FRAMES = 4096; // power of two (render-mode local ring)

class TaudProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new TaudEngine();
    this.playhead = 0; // the browser player drives playhead 0

    this.chunk = new Uint8Array(TRACKER_CHUNK * 2);
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.ringWrite = 0;      // absolute frame counter (wraps via mask)
    this.ringReadPos = 0.0;  // fractional absolute read cursor
    this.step = SAMPLING_RATE / sampleRate; // 1.0 at a 32 kHz context

    // CONSUME mode (Tier 2): audio-ring SAB views + wrap-safe read cursor.
    this.audioRing = null;
    this.arEpoch = -1;       // forces a re-sync on the first callback
    this.arReadBase = 0;     // Int32-wrapping integer read frame
    this.arReadFrac = 0.0;   // 0..1 fractional accumulator

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    // Recycled snapshot buffers (transferred out, posted back via SNAPSHOT_RETURN).
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];
    // SAB fast path (CMD.USE_SAB): write snapshots straight into shared memory.
    this.sabF32 = null;
    this.sabI32 = null;

    // ── dev profiler (opt-in via processorOptions.profile; zero cost when off) ──
    // Times the whole process() callback (the true xrun predictor) AND the
    // engine.renderChunk DSP alone. In CONSUME mode renderChunk is never called,
    // so renderCount≈0 — which is exactly the point: the audio thread stops
    // rendering. Reports rolling stats to the main thread ≈ once per second.
    this.profiling = !!opts.profile;
    // AudioWorkletGlobalScope does not reliably expose performance.now on older
    // iPad Safari — feature-detect and fall back to the 1 ms-resolution
    // Date.now, reporting which clock is live so the numbers stay interpretable.
    const hasPerf = (typeof performance !== "undefined" && typeof performance.now === "function");
    this.clockNow = hasPerf ? () => performance.now() : () => Date.now();
    this.hiResClock = hasPerf;
    this.clockResMs = hasPerf ? 0.005 : 1; // nominal resolution
    this.profileIntervalFrames = Math.max(1, Math.round(sampleRate)); // ≈ 1 s window
    this.pfReset();

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  pfReset() {
    this.pfFrames = 0;
    this.pfProcBusy = 0; this.pfProcMax = 0; this.pfProcCount = 0; this.pfXruns = 0;
    this.pfRenderBusy = 0; this.pfRenderMax = 0; this.pfRenderCount = 0;
    this.pfPeakVoices = 0;
    this.pfUnderruns = 0; // CONSUME mode: callbacks starved while the producer was active
  }

  onCommand(m) {
    // Enter CONSUME mode: the worker owns the engine now; free ours (~8 MB).
    if (m.t === CMD.USE_AUDIO_SAB) {
      this.audioRing = audioRingViews(m.sab);
      this.engine = null;
      return;
    }
    if (this.audioRing) return; // consume mode: no engine commands routed here

    const eng = this.engine;
    if (applyAudioCommand(eng, m)) return;
    switch (m.t) {
      case CMD.INIT:
        if (m.snapshotIntervalMs) {
          this.snapshotIntervalFrames =
            Math.max(1, Math.round((m.snapshotIntervalMs / 1000) * sampleRate));
        }
        break;
      case CMD.QUERY_FUNK_MASK: {
        const buf = funkMaskBuffer(eng, m.slot);
        this.port.postMessage({ t: MSG.FUNK_MASK, slot: m.slot, mask: buf }, [buf]);
        break;
      }
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
      case CMD.USE_SAB:
        this.sabF32 = new Float32Array(m.sab, 0, SNAP_FLOATS);
        this.sabI32 = new Int32Array(m.sab, SNAP_FLOATS * 4, 1);
        break;
    }
  }

  renderIntoRing() {
    const t0 = this.profiling ? this.clockNow() : 0;
    const out = this.engine.renderChunk(this.playhead, this.chunk);
    if (this.profiling) {
      const dt = this.clockNow() - t0;
      this.pfRenderBusy += dt;
      if (dt > this.pfRenderMax) this.pfRenderMax = dt;
      this.pfRenderCount++;
      const ts0 = this.engine.playheads[this.playhead].trackerState;
      let nv = ts0.backgroundVoices.length;
      for (let i = 0; i < ts0.voices.length; i++) if (ts0.voices[i].active) nv++;
      if (nv > this.pfPeakVoices) this.pfPeakVoices = nv;
    }
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      // Feed the pre-dither Float32 mix bus directly — clean output, no 8-bit
      // dithering. (renderChunk still fills the dithered U8 `out` so the engine
      // stays bit-exact for the JVM-oracle conformance tests; playback ignores it.)
      const ts = this.engine.playheads[this.playhead].trackerState;
      const mL = ts.mixLeft;
      const mR = ts.mixRight;
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = mL[n];
        this.ringR[w] = mR[n];
      }
    }
    this.ringWrite += TRACKER_CHUNK;
  }

  assembleSnapshot() {
    if (this.sabF32 !== null) {
      // Shared-memory path: fill in place; interrupts accumulate in the
      // trailing Int32 cell until the main thread drains it atomically.
      fillSnapshotInto(this.engine, this.playhead, this.sabF32);
      this.sabF32[SNAP_INTERRUPT_MASK] = 0;
      const drained = this.engine.playheads[this.playhead].trackerState.drainInterrupts();
      if (drained !== 0) Atomics.or(this.sabI32, 0, drained);
      return;
    }
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning — skip, never allocate
    const f = new Float32Array(buffer);
    fillSnapshotInto(this.engine, this.playhead, f);
    f[SNAP_INTERRUPT_MASK] = this.engine.playheads[this.playhead].trackerState.drainInterrupts();
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  // RENDER mode: keep the local ring one chunk ahead, then read it out resampled.
  renderAndPlay(outL, outR, frames) {
    const ph = this.engine.playheads[this.playhead];
    const mask = RING_FRAMES - 1;
    if (ph.isPlaying || ph.jamActive || this.ringReadPos < this.ringWrite) {
      while (this.ringWrite < this.ringReadPos + frames * this.step + 2) {
        if (ph.isPlaying || ph.jamActive) {
          this.renderIntoRing();
        } else {
          const w = this.ringWrite & mask;
          this.ringL[w] = 0;
          this.ringR[w] = 0;
          this.ringWrite += 1;
        }
      }
      for (let n = 0; n < frames; n++) {
        const pos = this.ringReadPos;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = i0 & mask;
        const b = (i0 + 1) & mask;
        outL[n] = this.ringL[a] * (1 - frac) + this.ringL[b] * frac;
        outR[n] = this.ringR[a] * (1 - frac) + this.ringR[b] * frac;
        this.ringReadPos += this.step;
      }
    } else {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
    }

    this.framesSinceSnapshot += frames;
    if (this.framesSinceSnapshot >= this.snapshotIntervalFrames) {
      this.framesSinceSnapshot = 0;
      this.assembleSnapshot();
    }
  }

  // CONSUME mode: read the worker's SAB ring resampled to the context rate.
  consumeFromRing(outL, outR, frames) {
    const { ctrl, L, R } = this.audioRing;
    // A transport reset (play/seek/stop) bumps the epoch and publishes a flush
    // mark — jump the read cursor there, dropping the stale buffered tail.
    const epoch = Atomics.load(ctrl, AR_EPOCH) | 0;
    if (epoch !== this.arEpoch) {
      this.arEpoch = epoch;
      this.arReadBase = Atomics.load(ctrl, AR_FLUSH_POS) | 0;
      this.arReadFrac = 0;
    }
    const write = Atomics.load(ctrl, AR_WRITE) | 0;
    const avail = (write - this.arReadBase) | 0;
    const need = Math.ceil(frames * this.step) + 2;
    if (avail < need) {
      // Silence, hold the cursor. If the PRODUCER is active (playing/jam) this
      // is a real dropout — the worker isn't refilling the ring in time; that is
      // the Tier 2 glitch signal the audio-thread xrun counter can no longer see.
      if (this.profiling && Atomics.load(ctrl, AR_STATE)) this.pfUnderruns++;
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      Atomics.store(ctrl, AR_READ, this.arReadBase);
      return;
    }
    let base = this.arReadBase, frac = this.arReadFrac;
    const step = this.step;
    for (let n = 0; n < frames; n++) {
      const a = base & AR_MASK;
      const b = (base + 1) & AR_MASK;
      outL[n] = L[a] * (1 - frac) + L[b] * frac;
      outR[n] = R[a] * (1 - frac) + R[b] * frac;
      frac += step;
      while (frac >= 1) { frac -= 1; base = (base + 1) | 0; }
    }
    this.arReadBase = base;
    this.arReadFrac = frac;
    Atomics.store(ctrl, AR_READ, base);
  }

  emitProfile(quantumMs) {
    const audioMs = this.pfFrames / sampleRate * 1000;
    this.port.postMessage({
      t: MSG.PROFILE,
      cpuFrac: audioMs > 0 ? this.pfProcBusy / audioMs : 0,
      renderFrac: audioMs > 0 ? this.pfRenderBusy / audioMs : 0,
      procMeanMs: this.pfProcCount ? this.pfProcBusy / this.pfProcCount : 0,
      procMaxMs: this.pfProcMax,
      renderMeanMs: this.pfRenderCount ? this.pfRenderBusy / this.pfRenderCount : 0,
      renderMaxMs: this.pfRenderMax,
      quantumMs,
      xruns: this.pfXruns,
      underruns: this.pfUnderruns,
      procCount: this.pfProcCount,
      renderCount: this.pfRenderCount,
      peakVoices: this.pfPeakVoices,
      windowMs: audioMs,
      sampleRate,
      step: this.step,
      sab: this.sabF32 !== null || this.audioRing !== null,
      workerRender: this.audioRing !== null,
      hiResClock: this.hiResClock,
      clockResMs: this.clockResMs,
    });
    this.pfReset();
  }

  process(_inputs, outputs) {
    const t0 = this.profiling ? this.clockNow() : 0;
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : outputs[0][0];
    const frames = outL.length;

    if (this.audioRing) {
      this.consumeFromRing(outL, outR, frames);
    } else {
      this.renderAndPlay(outL, outR, frames);
    }

    if (this.profiling) {
      // Measure the whole callback — the work the audio thread must finish
      // within one quantum. The report post itself is excluded (dt before emit).
      const dt = this.clockNow() - t0;
      this.pfProcBusy += dt;
      if (dt > this.pfProcMax) this.pfProcMax = dt;
      this.pfProcCount++;
      const quantumMs = frames / sampleRate * 1000;
      if (dt > quantumMs) this.pfXruns++;
      this.pfFrames += frames;
      if (this.pfFrames >= this.profileIntervalFrames) this.emitProfile(quantumMs);
    }
    return true;
  }
}

registerProcessor("taud-processor", TaudProcessor);
