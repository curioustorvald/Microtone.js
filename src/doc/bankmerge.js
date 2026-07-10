// Bank merge — import selected instruments (with their samples, Ixmp patches
// and meta layers) from a source Document (.taud or .tsii) into the current
// one. Pure doc-layer planning/apply/restore; the invertible op lives in
// ops.js (importBankOp). Strategy:
//   * selecting a Metainstrument pulls its layer instruments in (closure);
//   * samples dedupe by CONTENT against the destination pool and within the
//     batch, then first-fit into free pool extents (8 MB budget);
//   * top-level imports take free slots 1..255 (the pattern-cell instrument
//     byte can't address higher); layer-only dependencies fill 1023 downward;
//   * instrument records and Ixmp blobs are kept verbatim except the
//     remapped sample pointers / layer indices; INam entries splice by slot,
//     SNam rebuilds by sample identity (ptr:len) AFTER apply so the name
//     order always matches the post-merge sampleList() census.

import { SAMPLEBIN_SIZE, ixmpPatchLen } from "../format/taud-const.js";
import { parsePatchesBlob, TaudInst } from "../engine/inst.js";

const sampleKey = (ptr, len) => `${ptr}:${len}`;

// ── 0x1E-separated name tables, handled at the BYTE level so imported names
//    round-trip whatever encoding/escapes the source file used ──

export function splitNameTable(payload) {
  if (!payload || payload.length === 0) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i <= payload.length; i++) {
    if (i === payload.length || payload[i] === 0x1e) {
      parts.push(payload.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

export function joinNameTable(parts) {
  const trimmed = [...parts];
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1]?.length ?? 0) === 0) trimmed.pop();
  const total = trimmed.reduce((n, p) => n + (p?.length ?? 0), 0) + Math.max(0, trimmed.length - 1);
  const out = new Uint8Array(total);
  let o = 0;
  trimmed.forEach((p, i) => {
    if (i > 0) out[o++] = 0x1e;
    if (p) { out.set(p, o); o += p.length; }
  });
  return out;
}

function sectionPayload(doc, fc) {
  return doc.projSections.find((s) => s.fourcc === fc)?.payload ?? null;
}

/** Ixmp section payload from decoded entries (inverse of parseIxmpSection). */
export function buildIxmpSection(entries) {
  const total = entries.reduce((n, e) => n + 4 + e.blob.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const e of entries) {
    out[o] = e.instId & 0xff;
    out[o + 1] = e.count & 0xff;
    out[o + 2] = (e.count >>> 8) & 0xff;
    out[o + 3] = (e.instId >>> 8) & 0x03;
    out.set(e.blob, o + 4);
    o += 4 + e.blob.length;
  }
  return out;
}

/** Slots a meta instrument's layer table references (used slots only). */
function layerDeps(srcDoc, slot, srcUsed) {
  const inst = srcDoc.instruments[slot];
  if (!inst.isMeta) return [];
  return inst.metaLayers.map((l) => l.instIdx).filter((d) => srcUsed.has(d));
}

/**
 * Describe a source document's importable instruments for the picker UI:
 * [{slot, name, isMeta, patchCount, sampleBytes, layerOf: [metaSlot…]}].
 */
export function bankInventory(srcDoc) {
  const used = srcDoc.usedInstrumentSlots();
  const usedSet = new Set(used);
  const layerOf = new Map();
  for (const s of used) {
    for (const d of layerDeps(srcDoc, s, usedSet)) {
      if (!layerOf.has(d)) layerOf.set(d, []);
      layerOf.get(d).push(s);
    }
  }
  return used.map((slot) => {
    const inst = srcDoc.instruments[slot];
    const keys = new Set();
    if (!inst.isMeta && inst.sampleLength > 0) keys.add(sampleKey(inst.samplePtr, inst.sampleLength));
    for (const p of inst.extraPatches ?? []) {
      if (p.sampleLength > 0) keys.add(sampleKey(p.samplePtr, p.sampleLength));
    }
    let sampleBytes = 0;
    for (const k of keys) sampleBytes += Number(k.split(":")[1]);
    return {
      slot,
      name: srcDoc.instrumentName(slot),
      isMeta: inst.isMeta,
      patchCount: inst.extraPatches?.length ?? 0,
      sampleBytes,
      layerOf: layerOf.get(slot) ?? [],
    };
  });
}

// Free extents of the destination pool: [0, SAMPLEBIN_SIZE) minus the merged
// [ptr, ptr+len) intervals of every census sample.
function freeExtents(census) {
  const ivs = census
    .map((e) => [e.ptr, Math.min(e.ptr + e.len, SAMPLEBIN_SIZE)])
    .sort((a, b) => a[0] - b[0]);
  const free = [];
  let pos = 0;
  for (const [a, b] of ivs) {
    if (a > pos) free.push({ ptr: pos, len: a - pos });
    pos = Math.max(pos, b);
  }
  if (pos < SAMPLEBIN_SIZE) free.push({ ptr: pos, len: SAMPLEBIN_SIZE - pos });
  return free;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Plan an import of `selectedSlots` from srcDoc into destDoc. Pure — computes
 * everything applyPlan will write. Returns {error} on any budget/validity
 * failure, else:
 * {
 *   insts: [{srcSlot, destSlot, topLevel, record, ixmpBlob|null, ixmpCount}],
 *   samples: [{ptr, bytes, srcKeys}],       // new pool writes
 *   inamPayload: Uint8Array|null,           // null = leave INam alone
 *   snamNames: Map<"ptr:len", Uint8Array>,  // identity → name (post-apply rebuild)
 *   writeSnam: boolean,
 *   slotMap: Map<srcSlot, destSlot>, newSampleBytes, dedupedSamples,
 * }
 */
export function planImport(destDoc, srcDoc, selectedSlots) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to import into." };
  }
  if (srcDoc.sampleInstImage === null) {
    return { error: "The source file carries no sample+instrument image." };
  }
  const srcUsed = new Set(srcDoc.usedInstrumentSlots());
  const selected = [...new Set(selectedSlots)].filter((s) => srcUsed.has(s));
  if (selected.length === 0) return { error: "No instruments selected." };

  // ── dependency closure over meta layer tables ──
  const all = new Set(selected);
  const queue = [...selected];
  while (queue.length > 0) {
    for (const d of layerDeps(srcDoc, queue.pop(), srcUsed)) {
      if (!all.has(d)) { all.add(d); queue.push(d); }
    }
  }
  const topLevel = new Set(selected);
  const ordered = [...all].sort((a, b) => a - b);

  // ── destination slots: 1..255 ascending for note-addressable imports,
  //    1023 downward for layer-only dependencies ──
  const taken = new Set(destDoc.usedInstrumentSlots());
  const slotMap = new Map();
  let low = 1, high = 1023;
  const nextLow = () => { while (low <= 255 && taken.has(low)) low++; return low <= 255 ? low : null; };
  const nextHigh = () => { while (high >= 1 && taken.has(high)) high--; return high >= 1 ? high : null; };
  for (const srcSlot of ordered) {
    const dest = topLevel.has(srcSlot) ? nextLow() : (nextHigh() ?? nextLow());
    if (dest === null) {
      return {
        error: topLevel.has(srcSlot)
          ? "No free instrument slots left in $01–$FF (note-addressable range)."
          : "No free instrument slots left.",
      };
    }
    taken.add(dest);
    slotMap.set(srcSlot, dest);
  }

  // ── samples: collect unique (ptr:len), dedupe by content, allocate ──
  const srcPool = srcDoc.sampleBin;
  const destPool = destDoc.sampleBin;
  const destCensus = destDoc.sampleList();
  const extents = freeExtents(destCensus);
  const sampleMap = new Map(); // srcKey → dest ptr
  const newSamples = [];       // {ptr, bytes, srcKeys}
  let newSampleBytes = 0, dedupedSamples = 0;

  const wantKeys = [];
  for (const srcSlot of ordered) {
    const inst = srcDoc.instruments[srcSlot];
    if (!inst.isMeta && inst.sampleLength > 0) wantKeys.push([inst.samplePtr, inst.sampleLength]);
    for (const p of inst.extraPatches ?? []) {
      if (p.sampleLength > 0) wantKeys.push([p.samplePtr, p.sampleLength]);
    }
  }
  for (const [ptr, len] of wantKeys) {
    const key = sampleKey(ptr, len);
    if (sampleMap.has(key)) continue;
    const end = Math.min(ptr + len, SAMPLEBIN_SIZE);
    if (end <= ptr) { sampleMap.set(key, 0); continue; } // degenerate pointer — keep silent-sample semantics
    const bytes = srcPool.subarray(ptr, end);

    let destPtr = null;
    for (const e of destCensus) {
      if (e.len === bytes.length && bytesEqual(destPool.subarray(e.ptr, e.ptr + e.len), bytes)) {
        destPtr = e.ptr;
        dedupedSamples++;
        break;
      }
    }
    if (destPtr === null) {
      for (const ns of newSamples) {
        if (bytesEqual(ns.bytes, bytes)) { destPtr = ns.ptr; ns.srcKeys.push(key); dedupedSamples++; break; }
      }
    }
    if (destPtr === null) {
      const ext = extents.find((x) => x.len >= bytes.length);
      if (!ext) {
        return { error: `Sample pool full: needs ${bytes.length} more bytes and no free extent is large enough.` };
      }
      destPtr = ext.ptr;
      ext.ptr += bytes.length;
      ext.len -= bytes.length;
      newSamples.push({ ptr: destPtr, bytes: Uint8Array.from(bytes), srcKeys: [key] });
      newSampleBytes += bytes.length;
    }
    sampleMap.set(key, destPtr);
  }

  // ── instrument records (+ Ixmp blobs), pointers/indices remapped ──
  const insts = [];
  for (const srcSlot of ordered) {
    const inst = srcDoc.instruments[srcSlot];
    const rec = srcDoc.instRecordBytes(srcSlot);
    let ixmpBlob = null, ixmpCount = 0;

    if (inst.isMeta) {
      // Remap the 10-bit layer indices in place; entries whose target is not
      // imported are zeroed (index 0 = "no layer" to the record parser) so a
      // stale source index can't alias a destination instrument.
      const count = rec[1];
      for (let n = 0; n < count && 4 + n * 10 + 10 <= 256; n++) {
        const o = 4 + n * 10;
        const idx = rec[o] | (((rec[o + 8] >>> 6) & 0x3) << 8);
        const mapped = slotMap.get(idx);
        if (mapped !== undefined) {
          rec[o] = mapped & 0xff;
          rec[o + 8] = (rec[o + 8] & 0x3f) | (((mapped >>> 8) & 0x3) << 6);
        } else {
          rec[o] = 0;
          rec[o + 8] &= 0x3f;
        }
      }
    } else {
      if (inst.sampleLength > 0) {
        const ptr = sampleMap.get(sampleKey(inst.samplePtr, inst.sampleLength));
        rec[0] = ptr & 0xff;
        rec[1] = (ptr >>> 8) & 0xff;
        rec[2] = (ptr >>> 16) & 0xff;
        rec[3] = (ptr >>> 24) & 0xff;
      }
      // Last Ixmp entry for the slot wins — matches the upload path, where
      // each entry replaces the previous patch set.
      const entry = [...srcDoc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === srcSlot);
      if (entry && entry.blob.length > 0) {
        ixmpBlob = Uint8Array.from(entry.blob);
        ixmpCount = entry.count;
        let o = 0;
        while (o + 31 <= ixmpBlob.length) {
          const len = ixmpPatchLen(ixmpBlob[o]);
          if (o + len > ixmpBlob.length) break;
          const pLen = ixmpBlob[o + 11] | (ixmpBlob[o + 12] << 8);
          if (pLen > 0) {
            const pPtr = (ixmpBlob[o + 7] | (ixmpBlob[o + 8] << 8) | (ixmpBlob[o + 9] << 16)) +
                         ixmpBlob[o + 10] * 0x1000000;
            const ptr = sampleMap.get(sampleKey(pPtr, pLen)) ?? pPtr;
            ixmpBlob[o + 7] = ptr & 0xff;
            ixmpBlob[o + 8] = (ptr >>> 8) & 0xff;
            ixmpBlob[o + 9] = (ptr >>> 16) & 0xff;
            ixmpBlob[o + 10] = (ptr >>> 24) & 0xff;
          }
          o += len;
        }
      }
    }
    insts.push({ srcSlot, destSlot: slotMap.get(srcSlot), topLevel: topLevel.has(srcSlot), record: rec, ixmpBlob, ixmpCount });
  }

  // ── INam: splice imported names in by destination slot ──
  const srcInam = splitNameTable(sectionPayload(srcDoc, "INam"));
  const destInamPayload = sectionPayload(destDoc, "INam");
  const anyInstName = insts.some((it) => (srcInam[it.srcSlot]?.length ?? 0) > 0);
  let inamPayload = null;
  if (anyInstName || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    for (const it of insts) {
      while (parts.length <= it.destSlot) parts.push(new Uint8Array(0));
      parts[it.destSlot] = srcInam[it.srcSlot] ?? new Uint8Array(0);
    }
    inamPayload = joinNameTable(parts);
  }

  // ── SNam: identity → name map; the payload itself is rebuilt after apply
  //    from the real census so name order can never drift ──
  const snamNames = new Map();
  const destSnamPayload = sectionPayload(destDoc, "SNam");
  const destSnam = splitNameTable(destSnamPayload);
  destCensus.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  const srcSnam = splitNameTable(sectionPayload(srcDoc, "SNam"));
  const srcNameByKey = new Map();
  srcDoc.sampleList().forEach((e, i) => srcNameByKey.set(sampleKey(e.ptr, e.len), srcSnam[i] ?? new Uint8Array(0)));
  let anySampleName = false;
  for (const ns of newSamples) {
    const name = srcNameByKey.get(ns.srcKeys[0]) ?? new Uint8Array(0);
    if (name.length > 0) anySampleName = true;
    snamNames.set(sampleKey(ns.ptr, ns.bytes.length), name);
  }
  const writeSnam = anySampleName || destSnamPayload !== null;

  return {
    insts,
    samples: newSamples,
    inamPayload,
    snamNames,
    writeSnam,
    slotMap,
    newSampleBytes,
    dedupedSamples,
  };
}

/** Fresh single-sample instrument record: TaudInst constructor defaults
 *  (vol-env terminator at 0x3F — a zeroed record's value-0 terminator would
 *  hit the Schism cut rule and ramp the voice out instantly) with the sample
 *  binding filled in. */
export function buildFreshInstRecord({ samplePtr, sampleLength, samplingRate }) {
  const inst = new TaudInst(0);
  inst.samplePtr = samplePtr;
  inst.sampleLength = sampleLength;
  inst.samplingRate = samplingRate;
  const rec = new Uint8Array(256);
  for (let i = 0; i < 256; i++) rec[i] = inst.getByteNormal(i);
  return rec;
}

/**
 * Plan importing ONE raw sample (mono U8 PCM, ≤ 65535 bytes) as a brand-new
 * instrument: pool content is deduped, the PCM first-fits a free extent, the
 * instrument takes the lowest free note-addressable slot, and INam/SNam get
 * `nameBytes`. Returns {error} on failure, else a plan shaped exactly like
 * planImport's — apply it with importBankOp for full undo.
 */
export function planSampleImport(destDoc, { nameBytes = new Uint8Array(0), pcm, rate }) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to import into." };
  }
  if (!pcm || pcm.length === 0) return { error: "The decoded sample is empty." };
  if (pcm.length > 0xffff) {
    return { error: `Sample too long: ${pcm.length} bytes (65535 max) — resample it first.` };
  }

  const taken = new Set(destDoc.usedInstrumentSlots());
  let slot = 1;
  while (slot <= 255 && taken.has(slot)) slot++;
  if (slot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }

  const destCensus = destDoc.sampleList();
  const destPool = destDoc.sampleBin;
  let ptr = null;
  const samples = [];
  for (const e of destCensus) {
    if (e.len === pcm.length && bytesEqual(destPool.subarray(e.ptr, e.ptr + e.len), pcm)) {
      ptr = e.ptr; // identical content already pooled — reuse it
      break;
    }
  }
  if (ptr === null) {
    const ext = freeExtents(destCensus).find((x) => x.len >= pcm.length);
    if (!ext) {
      return { error: `Sample pool full: needs ${pcm.length} more bytes and no free extent is large enough.` };
    }
    ptr = ext.ptr;
    samples.push({ ptr, bytes: Uint8Array.from(pcm), srcKeys: [] });
  }

  const record = buildFreshInstRecord({
    samplePtr: ptr,
    sampleLength: pcm.length,
    samplingRate: Math.max(1, Math.min(0xffff, Math.round(rate) || 0)),
  });

  // INam: splice the instrument name in by slot.
  const destInamPayload = sectionPayload(destDoc, "INam");
  let inamPayload = null;
  if (nameBytes.length > 0 || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = nameBytes;
    inamPayload = joinNameTable(parts);
  }

  // SNam identity map (payload rebuilt from the real census after apply).
  // A deduped sample keeps its existing name.
  const snamNames = new Map();
  const destSnam = splitNameTable(sectionPayload(destDoc, "SNam"));
  destCensus.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  const key = sampleKey(ptr, pcm.length);
  if (!snamNames.has(key)) snamNames.set(key, nameBytes);
  const writeSnam = nameBytes.length > 0 || sectionPayload(destDoc, "SNam") !== null;

  return {
    insts: [{ srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob: null, ixmpCount: 0 }],
    samples,
    inamPayload,
    snamNames,
    writeSnam,
    slotMap: new Map([[-1, slot]]),
    newSampleBytes: samples.length > 0 ? pcm.length : 0,
    dedupedSamples: samples.length > 0 ? 0 : 1,
  };
}

/** Everything applyPlan touches, captured for the invertible op. */
export function captureBankState(doc, plan) {
  doc.instruments; // ensure decoded (slot state lives on the TaudInst objects)
  return {
    spans: plan.samples.map((s) => ({
      ptr: s.ptr,
      bytes: Uint8Array.from(doc.sampleBin.subarray(s.ptr, s.ptr + s.bytes.length)),
    })),
    slots: plan.insts.map((it) => ({
      slot: it.destSlot,
      record: doc.instRecordBytes(it.destSlot),
      used: doc._usedSlots.has(it.destSlot),
      patches: doc.instruments[it.destSlot].extraPatches,
    })),
    ixmp: doc.ixmp.slice(),
    // Whole section list (payload refs are stable — sections get replaced,
    // never mutated) so restore reproduces the section ORDER byte-exactly.
    sections: doc.projSections.map((s) => ({ fourcc: s.fourcc, payload: s.payload })),
  };
}

export function restoreBankState(doc, state) {
  for (const span of state.spans) doc.sampleBin.set(span.bytes, span.ptr);
  for (const s of state.slots) {
    doc.instruments[s.slot].loadRecord(s.record);
    doc.instruments[s.slot].extraPatches = s.patches;
    doc._editedSlots.add(s.slot);
    if (s.used) doc._usedSlots.add(s.slot);
    else doc._usedSlots.delete(s.slot);
  }
  doc._instrumentsEdited = true;
  doc.ixmp = state.ixmp.slice();
  doc.projSections = state.sections.map((s) => ({ fourcc: s.fourcc, payload: s.payload }));
  doc.dirty = true;
}

export function applyPlan(doc, plan) {
  for (const s of plan.samples) doc.sampleBin.set(s.bytes, s.ptr);
  for (const it of plan.insts) {
    const inst = doc.instruments[it.destSlot];
    inst.loadRecord(it.record);
    // Mirror the instruments-getter decode: the live TaudInst carries the
    // patches (census, zones view, jam) — loadRecord alone leaves them stale.
    const patches = it.ixmpBlob !== null ? parsePatchesBlob(it.ixmpBlob) : [];
    inst.extraPatches = patches.length > 0 ? patches : null;
    doc.markInstUsed(it.destSlot);
    doc.ixmp = doc.ixmp.filter((e) => (e.instId & 0x3ff) !== it.destSlot);
    if (it.ixmpBlob !== null) {
      doc.ixmp.push({ instId: it.destSlot, count: it.ixmpCount, blob: it.ixmpBlob });
    }
  }
  if (plan.insts.some((it) => it.ixmpBlob !== null) || sectionPayload(doc, "Ixmp") !== null) {
    doc.setSection("Ixmp", doc.ixmp.length > 0 ? buildIxmpSection(doc.ixmp) : null);
  }
  if (plan.inamPayload !== null) doc.setSection("INam", plan.inamPayload);
  if (plan.writeSnam) {
    const names = doc.sampleList().map((e) =>
      plan.snamNames.get(sampleKey(e.ptr, e.len)) ?? new Uint8Array(0));
    doc.setSection("SNam", joinNameTable(names));
  }
  doc.dirty = true;
}
