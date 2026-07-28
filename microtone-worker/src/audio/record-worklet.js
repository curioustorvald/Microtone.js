// Mic-capture worklet for the Sample Lab recorder (item 83.1): posts each
// 128-frame quantum to the main thread as an ARRAY of transferred
// Float32Arrays — one per input channel, up to two (item 90: a stereo input
// records as a stereo take; anything wider folds to its first two channels).
// Raw PCM — no codec in the path, unlike MediaRecorder. Loaded with
// audioWorklet.addModule by recordsample.js (ScriptProcessorNode fallback
// lives there too, posting the same shape).

const MAX_CHANNELS = 2;

class MtRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length > 0 && chans[0].length > 0) {
      const keep = Math.min(MAX_CHANNELS, chans.length);
      const out = [];
      for (let c = 0; c < keep; c++) out.push(Float32Array.from(chans[c]));
      this.port.postMessage(out, out.map((b) => b.buffer));
    }
    return true;
  }
}

registerProcessor("mt-recorder", MtRecorderProcessor);
