// Taud container serialiser — multi-song generalisation of LibTaud's
// captureTrackerDataToFile (taud.mjs:415-698). Emits format v2, gzip-compressed
// sections (TSVM auto-detects gzip vs zstd by magic). Project-Data sections are
// emitted verbatim from doc.projSections — callers that edit Ixmp/xHDR/sMet
// must rebuild those sections before writing (document-layer concern).

import {
  TAUD_MAGIC, PROJ_MAGIC,
  TAUD_VERSION, TAUD_XHDR_FLAG,
  TAUD_KIND_SAMPLEINST, TAUD_KIND_PATTERN,
  TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
  PATTERN_SIZE, NUM_VOICES, MAX_VOICES, CUE_SIZE, CUE_SIZE_64,
  CAPTURE_SIGNATURE,
} from "./taud-const.js";
import { comp } from "./compress.js";

function pushU16(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff); }
function pushU32(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
function pushF32(a, v) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, v, true);
  a.push(buf[0], buf[1], buf[2], buf[3]);
}

/**
 * Serialise a parsed/edited Taud structure (the shape parseTaud returns) back
 * to container bytes.
 */
export function writeTaud(doc) {
  const kindBits =
    doc.kind === "tsii" ? TAUD_KIND_SAMPLEINST :
    doc.kind === "tpif" ? TAUD_KIND_PATTERN : 0;
  const hasXhdr = doc.projSections.some((s) => s.fourcc === "xHDR");
  const version = TAUD_VERSION | (hasXhdr ? TAUD_XHDR_FLAG : 0) | kindBits;

  // ── compress the big sections up front (offsets depend on their sizes) ──
  const imageComp =
    doc.kind !== "tpif" && doc.sampleInstImage ? comp(doc.sampleInstImage) : null;
  const compSize = imageComp ? imageComp.length : 0;

  const songs = doc.kind === "tsii" ? [] : doc.songs;
  const stride = doc.is64Channel ? CUE_SIZE_64 : CUE_SIZE;
  const chans = doc.is64Channel ? MAX_VOICES : NUM_VOICES;
  const songBins = songs.map((song) => {
    const patBin = new Uint8Array(song.patterns.length * PATTERN_SIZE);
    song.patterns.forEach((p, i) => patBin.set(p, i * PATTERN_SIZE));
    const cueBin = new Uint8Array(song.cues.length * stride);
    song.cues.forEach((words, c) => {
      for (let ch = 0; ch < chans; ch++) {
        cueBin[c * stride + ch * 2] = words[ch] & 0xff;
        cueBin[c * stride + ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
      }
    });
    return { patComp: comp(patBin), cueComp: comp(cueBin) };
  });

  // ── song table ──
  const tableOff = TAUD_HEADER_SIZE + compSize;
  let binOff = tableOff + songs.length * TAUD_SONG_ENTRY;
  const table = [];
  songs.forEach((song, s) => {
    const bins = songBins[s];
    const bpmStored = Math.max(0, Math.min(0x1fe, song.bpm - 25));
    pushU32(table, binOff);
    table.push(song.numVoices & 0xff);
    pushU16(table, song.patterns.length);
    table.push(bpmStored & 0xff);
    table.push((((bpmStored >> 8) & 1) << 7) | (song.tickRate & 0x7f));
    pushU16(table, song.tuningBaseNote);
    pushF32(table, song.tuningFreq);
    table.push(song.globalFlags & 0xff, song.globalVolume & 0xff, song.mixingVolume & 0xff);
    pushU32(table, bins.patComp.length);
    pushU32(table, bins.cueComp.length);
    pushU16(table, song.cues.length); // num_cues (v2)
    table.push(0, 0, 0, 0);           // reserved
    binOff += bins.patComp.length + bins.cueComp.length;
  });

  // ── project data ──
  const projParts = [];
  if (doc.projSections.length > 0) {
    projParts.push(PROJ_MAGIC, new Uint8Array(8)); // magic + reserved
    for (const sec of doc.projSections) {
      const hdr = [];
      for (let i = 0; i < 4; i++) hdr.push(sec.fourcc.charCodeAt(i));
      pushU32(hdr, sec.payload.length);
      projParts.push(Uint8Array.from(hdr), sec.payload);
    }
  }
  const projOff = projParts.length > 0 ? binOff : 0;

  // ── header ──
  const header = [];
  header.push(...TAUD_MAGIC);
  header.push(version, songs.length);
  pushU32(header, compSize);
  pushU32(header, projOff);
  const sig = doc.signature && doc.signature.length === 14 ? doc.signature : CAPTURE_SIGNATURE;
  for (let i = 0; i < 14; i++) header.push(sig.charCodeAt(i) & 0xff);

  // ── assemble ──
  const parts = [Uint8Array.from(header)];
  if (imageComp) parts.push(imageComp);
  parts.push(Uint8Array.from(table));
  for (const bins of songBins) parts.push(bins.patComp, bins.cueComp);
  parts.push(...projParts);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
