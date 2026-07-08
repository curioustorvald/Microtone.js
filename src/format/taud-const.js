// Taud container format constants — mirror of taud.mjs:9-71 (LibTaud) and
// terranmon.txt §"Taud serialisation format".

export const TAUD_MAGIC = Uint8Array.from([0x1f, 0x54, 0x53, 0x56, 0x4d, 0x61, 0x75, 0x64]); // \x1FTSVMaud
export const PROJ_MAGIC = Uint8Array.from([0x1e, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4a]); // \x1ETaudPrJ

// Version byte layout: 0b kk x vvvvv
//   vvvvv: format version (1 = legacy cues, 2 = extended cue sheet)
//   x (0x20): Project Data carries an xHDR section (64-channel flag)
//   kk: container kind
export const TAUD_VERSION = 2;
export const TAUD_VERSION_MASK = 0x1f;
export const TAUD_XHDR_FLAG = 0x20;
export const TAUD_KIND_MASK = 0xc0;
export const TAUD_KIND_FULL = 0x00;
export const TAUD_KIND_SAMPLEINST = 0x80; // .tsii
export const TAUD_KIND_PATTERN = 0xc0;    // .tpif

export const TAUD_HEADER_SIZE = 32; // magic(8) + version(1) + numSongs(1) + compSize(4) + projOff(4) + sig(14)
export const TAUD_SONG_ENTRY = 32;

// Sample+instrument image: 8 MB sample pool + 256 K instrument bin.
export const SAMPLEBIN_SIZE = 8388608;
export const INSTBIN_SIZE = 262144; // 1024 inst × 256 bytes
export const SAMPLEINST_SIZE = SAMPLEBIN_SIZE + INSTBIN_SIZE; // 8650752
export const INST_RECORD_SIZE = 256;
export const NUM_INSTRUMENTS = 1024;

export const PATTERN_SIZE = 512; // 64 rows × 8 bytes
export const NUM_PATTERNS_MAX = 0x7fff;

// Cue sheet (v2): 32×Sint16 = 64 bytes; 64-channel mode: 64×Sint16 = 128 bytes.
export const NUM_VOICES = 32;
export const MAX_VOICES = 64;
export const CUE_SIZE = 64;
export const CUE_SIZE_64 = 128;
export const NUM_CUES = 8192;
export const NUM_CUES_64 = 4096;
export const CUE_EMPTY = 0x7fff;

// Legacy v1 cue sheet.
export const CUE_SIZE_V1 = 32;
export const NUM_VOICES_V1 = 20;
export const CUE_EMPTY_V1 = 0xfff;

export const CAPTURE_SIGNATURE = "Microtone.js  "; // 14 bytes, space-padded

// Ixmp variable-length patch record: version byte (0b x00Pfpvi) + 30 common
// bytes + optional blocks, always in on-wire order x, v, p, f, P.
// (taud.mjs:340-345, terranmon.txt:3502-3508)
export function ixmpPatchLen(ver) {
  return (
    31 +
    ((ver & 0x80) ? 15 : 0) + // x: u32 flags1 + u32 flags2 + u16 fadeout + u16 cutoff + u16 reson + u8 atten
    ((ver & 0x02) ? 54 : 0) + // v: volume envelope
    ((ver & 0x04) ? 54 : 0) + // p: panning envelope
    ((ver & 0x08) ? 54 : 0) + // f: filter envelope
    ((ver & 0x10) ? 54 : 0)   // P: pitch envelope
  );
}
