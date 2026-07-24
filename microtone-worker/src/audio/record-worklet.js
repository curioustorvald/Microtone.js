// Mic-capture worklet for the Sample Lab recorder (item 83.1): mixes the
// input down to mono and posts each 128-frame quantum to the main thread as a
// transferred Float32Array. Raw PCM — no codec in the path, unlike
// MediaRecorder. Loaded with audioWorklet.addModule by recordsample.js
// (ScriptProcessorNode fallback lives there too).

class MtRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length > 0 && chans[0].length > 0) {
      const n = chans[0].length;
      const mono = new Float32Array(n);
      for (let c = 0; c < chans.length; c++) {
        const d = chans[c];
        for (let i = 0; i < n; i++) mono[i] += d[i];
      }
      if (chans.length > 1) {
        for (let i = 0; i < n; i++) mono[i] /= chans.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}

registerProcessor("mt-recorder", MtRecorderProcessor);
