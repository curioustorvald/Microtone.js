#!/usr/bin/env node
// taud-sig.js — inspect or rewrite the 14-byte tracker/converter signature
// field in a .taud/.tsii/.tpif header. See TAUD_FILE_FORMAT.md §2 ("Header",
// "### Signature"): offset 18, length 14, space-padded, diagnostics-only —
// rewriting it does not affect playback.
//
// Out-of-tree dev tool, not part of the microtone-worker source tree.

import { readFileSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from([0x1F, 0x54, 0x53, 0x56, 0x4D, 0x61, 0x75, 0x64]); // \x1FTSVMaud
const HEADER_SIZE = 32;
const SIG_OFFSET = 18;
const SIG_LENGTH = 14;
const KIND_NAMES = { 0: 'full .taud', 1: '.tsii', 2: '.tpif', 3: 'reserved' };

function usage() {
  console.error(`Usage:
  node taud-sig.js <file>                 Show header info (magic, version, signature)
  node taud-sig.js <file> --show          Same as above
  node taud-sig.js <file> --set "<text>"  Rewrite the 14-byte signature field in place`);
  process.exit(1);
}

const [, , file, flag, ...rest] = process.argv;
if (!file) usage();

const buf = readFileSync(file);
if (buf.length < HEADER_SIZE) {
  console.error(`${file}: too short to hold a 32-byte Taud header (${buf.length} bytes)`);
  process.exit(1);
}
if (!buf.subarray(0, 8).equals(MAGIC)) {
  console.error(`${file}: magic mismatch — not a Taud file (got ${buf.subarray(0, 8).toString('hex')})`);
  process.exit(1);
}

function readInfo() {
  const versionByte = buf.readUInt8(8);
  const kind = (versionByte >> 6) & 0b11;
  const xBit = (versionByte >> 5) & 1;
  const version = versionByte & 0b11111;
  const numSongs = buf.readUInt8(9);
  const sampleImgSize = buf.readUInt32LE(10);
  const projectDataOffset = buf.readUInt32LE(14);
  const sigBytes = buf.subarray(SIG_OFFSET, SIG_OFFSET + SIG_LENGTH);
  return { versionByte, kind, xBit, version, numSongs, sampleImgSize, projectDataOffset, sigBytes };
}

function show() {
  const i = readInfo();
  const sigText = i.sigBytes.toString('latin1').replace(/\s+$/, '');
  console.log(`File:                 ${file}`);
  console.log(`Magic:                ${buf.subarray(0, 8).toString('hex')} (\\x1FTSVMaud) — OK`);
  console.log(`Version byte:         0x${i.versionByte.toString(16).padStart(2, '0')} (kind=${KIND_NAMES[i.kind]}, x=${i.xBit}, version=${i.version})`);
  console.log(`Songs in table:       ${i.numSongs}`);
  console.log(`Sample/inst img size: ${i.sampleImgSize} bytes (compressed)`);
  console.log(`Project Data offset:  ${i.projectDataOffset}`);
  console.log(`Signature (raw):      ${JSON.stringify(i.sigBytes.toString('latin1'))}`);
  console.log(`Signature (trimmed):  "${sigText}"`);
}

function set(newSig) {
  const byteLength = Buffer.byteLength(newSig, 'latin1');
  if (byteLength > SIG_LENGTH) {
    console.error(`Signature too long: "${newSig}" is ${byteLength} bytes, field holds ${SIG_LENGTH}`);
    process.exit(1);
  }
  const field = Buffer.alloc(SIG_LENGTH, 0x20); // space-padded, per spec
  field.write(newSig, 0, 'latin1');
  field.copy(buf, SIG_OFFSET);
  writeFileSync(file, buf);
  console.log(`${file}: signature set to "${newSig}" (padded to ${SIG_LENGTH} bytes)`);
}

if (!flag || flag === '--show') {
  show();
} else if (flag === '--set') {
  const newSig = rest.join(' ');
  if (!newSig) usage();
  set(newSig);
} else {
  usage();
}
