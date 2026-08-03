// RIFF/WAVE writing for the multichannel exports (#998.4/.5/.6).
//
// Two things the old stereo encoder in offline-render.js does not need and this
// one does:
//   * WAVE_FORMAT_EXTENSIBLE — anything past two channels has to declare a
//     channel mask, or the file is just "six channels in some order" to the
//     reader. Mono and stereo stay on the plain 16-byte `fmt `, which is what
//     every decoder on earth accepts;
//   * STREAMING — an order-3 ambisonic export is sixteen channels, and five
//     minutes of that is over half a gigabyte. Samples are quantised into byte
//     blocks as they are rendered and the RIFF header is built at the end (when
//     the size is finally known) and prepended, so nothing ever holds the whole
//     render twice.
//
// Extra chunks (the ADM `chna` / `axml` pair, adm.js) ride in front of or
// behind `data`; RIFF requires every chunk to be word-aligned, which is what
// the pad byte below is for.

/** KSDATAFORMAT_SUBTYPE_PCM, little-endian on the wire. */
const PCM_SUBFORMAT = Uint8Array.from([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** id + length + payload (+ pad byte when the payload is odd). */
export function riffChunk(id, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(ascii(id), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/** The `fmt ` payload: extensible iff a mask is given or channels > 2. */
export function fmtPayload({ channels, sampleRate, bits, mask = null }) {
  const extensible = mask !== null || channels > 2;
  const bytesPerSample = bits >> 3;
  const blockAlign = channels * bytesPerSample;
  const buf = new ArrayBuffer(extensible ? 40 : 16);
  const dv = new DataView(buf);
  dv.setUint16(0, extensible ? 0xfffe : 1, true);
  dv.setUint16(2, channels, true);
  dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, sampleRate * blockAlign, true);
  dv.setUint16(12, blockAlign, true);
  dv.setUint16(14, bits, true);
  if (extensible) {
    dv.setUint16(16, 22, true);        // cbSize
    dv.setUint16(18, bits, true);      // valid bits
    dv.setUint32(20, mask ?? 0, true); // dwChannelMask (0 = "no assignment")
    new Uint8Array(buf).set(PCM_SUBFORMAT, 24);
  }
  return new Uint8Array(buf);
}

/** Quantise interleaved float samples to little-endian PCM of `bits` width. */
export function quantisePcm(f32, count, bits) {
  const bytes = bits >> 3;
  const out = new Uint8Array(count * bytes);
  if (bits === 16) {
    const dv = new DataView(out.buffer);
    for (let i = 0; i < count; i++) {
      const v = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
      dv.setInt16(i * 2, Math.round(v * 32767), true);
    }
  } else if (bits === 24) {
    for (let i = 0; i < count; i++) {
      const v = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
      const q = Math.round(v * 8388607);
      const u = q < 0 ? q + 0x1000000 : q;
      const o = i * 3;
      out[o] = u & 0xff;
      out[o + 1] = (u >>> 8) & 0xff;
      out[o + 2] = (u >>> 16) & 0xff;
    }
  } else {
    throw new Error(`unsupported bit depth: ${bits}`);
  }
  return out;
}

/**
 * Streaming WAV writer. `push` takes interleaved floats; `finish` returns the
 * file as an array of byte blocks (hand it straight to a Blob), so a long
 * export never needs one contiguous allocation.
 */
export class WavWriter {
  constructor({ channels, sampleRate, bits = 24, mask = null }) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.bits = bits;
    this.mask = mask;
    this.blocks = [];
    this.dataBytes = 0;
    this.frames = 0;
  }

  /** @param f32 interleaved samples; @param frames how many of them to take. */
  push(f32, frames) {
    const count = frames * this.channels;
    const block = quantisePcm(f32, count, this.bits);
    this.blocks.push(block);
    this.dataBytes += block.length;
    this.frames += frames;
  }

  /**
   * @param before chunks to place between `fmt ` and `data` (ADM `chna`)
   * @param after  chunks to place after `data` (ADM `axml`)
   * @returns Uint8Array[] — the complete file, in order.
   */
  finish({ before = [], after = [] } = {}) {
    const fmt = riffChunk("fmt ", fmtPayload({
      channels: this.channels, sampleRate: this.sampleRate, bits: this.bits, mask: this.mask,
    }));
    const dataPad = this.dataBytes & 1;
    const dataHeader = new Uint8Array(8);
    dataHeader.set(ascii("data"), 0);
    new DataView(dataHeader.buffer).setUint32(4, this.dataBytes, true);

    let size = 4; // "WAVE"
    size += fmt.length;
    for (const c of before) size += c.length;
    size += 8 + this.dataBytes + dataPad;
    for (const c of after) size += c.length;

    const head = new Uint8Array(12);
    head.set(ascii("RIFF"), 0);
    new DataView(head.buffer).setUint32(4, size, true);
    head.set(ascii("WAVE"), 8);

    const out = [head, fmt, ...before, dataHeader, ...this.blocks];
    if (dataPad) out.push(new Uint8Array(1));
    out.push(...after);
    return out;
  }
}

/** One-shot convenience for small buffers (tests, previews). */
export function encodeWavBuffer(f32, opts) {
  const w = new WavWriter(opts);
  w.push(f32, f32.length / opts.channels);
  const blocks = w.finish(opts);
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

/**
 * Encode a pooled sample's channel bytes (already unsigned 8-bit PCM, centre
 * 0x80) as a complete WAV file — bit-exact, no requantisation. `channels` is
 * one Uint8Array per channel (mono, or L/R for a stereo pair), all the same
 * length. Used by the sample export buttons (Samples view, sample editor).
 */
export function encodeU8Wav(channels, rate) {
  const nCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const data = new Uint8Array(frames * nCh);
  if (nCh === 1) {
    data.set(channels[0]);
  } else {
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c];
      for (let i = 0; i < frames; i++) data[i * nCh + c] = ch[i];
    }
  }
  const fmt = riffChunk("fmt ", fmtPayload({ channels: nCh, sampleRate: rate, bits: 8 }));
  const dataChunk = riffChunk("data", data);
  const head = new Uint8Array(12);
  head.set(ascii("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, 4 + fmt.length + dataChunk.length, true);
  head.set(ascii("WAVE"), 8);
  const out = new Uint8Array(head.length + fmt.length + dataChunk.length);
  out.set(head, 0);
  out.set(fmt, head.length);
  out.set(dataChunk, head.length + fmt.length);
  return out;
}

/**
 * Encode channels (array of Float32Array, nominal ±1) as a WAV file at `bits`
 * depth (16 or 24) — for editors whose working buffer is float (the Sample
 * Lab's original/edited take).
 */
export function encodeFloatWav(channels, rate, bits = 16) {
  const nCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const interleaved = new Float32Array(frames * nCh);
  if (nCh === 1) {
    interleaved.set(channels[0]);
  } else {
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c];
      for (let i = 0; i < frames; i++) interleaved[i * nCh + c] = ch[i];
    }
  }
  return encodeWavBuffer(interleaved, { channels: nCh, sampleRate: rate, bits });
}
