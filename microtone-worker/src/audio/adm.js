// ADM metadata for the surround and ambisonic exports (#998.4/.5/.6).
//
// A multichannel WAV says how many channels it has, not what they MEAN. The
// Audio Definition Model (ITU-R BS.2076) is the standard answer: an XML
// document in the RIFF chunk `axml` describing the channels, plus a small
// binary index in `chna` (BS.2088) tying each track of the file to its
// description. Renderers and DAWs that understand ADM (Reaper, the EBU/IRT
// tools, ffmpeg's -adm reader) will then place a 5.1 export at the right ITU
// angles, and read an ambisonic export as HOA with its own order and
// normalisation rather than as sixteen anonymous mono tracks.
//
// The structure written here is the BS.2076-1 chain, which is what tools
// actually read:
//   audioProgramme → audioContent → audioObject → audioPackFormat
//                                              → audioChannelFormat (per channel)
//   audioTrackUID (per track, indexed by chna) → audioTrackFormat → audioStreamFormat
//                                              → audioChannelFormat
// IDs use the custom range (0x1001 upward) that the standard reserves for
// definitions carried in the file itself, so nothing here depends on the
// reader having the common-definitions file.
//
// Two type definitions are used: DirectSpeakers (typeLabel 0001) for the
// speaker layouts, and HOA (0004) for ambisonics, where each channel declares
// its own ACN order and degree plus the SN3D normalisation — that pair IS the
// AmbiX convention, written down in the file instead of assumed.

const TYPE_DIRECT_SPEAKERS = "0001";
const TYPE_HOA = "0004";

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

/** XML text escape — song titles reach this. */
export function xmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]
  ));
}

/** ACN index → [order, degree]: l = ⌊√n⌋, m = n − l² − l. */
export function acnOrderDegree(acn) {
  const l = Math.floor(Math.sqrt(acn));
  return [l, acn - l * l - l];
}

/**
 * Channel descriptions for a speaker layout, in file order.
 * ADM azimuth is positive to the LEFT; the engine's degrees are clockwise, so
 * the sign flips here — see speakers.js.
 */
export function speakerChannelSpecs(layout) {
  return layout.speakers.map((s) => (s.lfe
    // BS.2051 gives LFE1 a nominal position rather than none at all.
    ? { name: "LFE", speakerLabel: "LFE1", azimuth: 45, elevation: -30 }
    : { name: s.label, speakerLabel: s.adm, azimuth: -s.deg, elevation: 0 }));
}

/**
 * Build the `axml` payload.
 * @param spec {kind: "DirectSpeakers"|"HOA", title, packName, channels}
 *   channels: DirectSpeakers → [{name, speakerLabel, azimuth, elevation}]
 *             HOA            → [{name, order, degree}]
 */
export function buildAdmXml(spec) {
  const hoa = spec.kind === "HOA";
  const type = hoa ? TYPE_HOA : TYPE_DIRECT_SPEAKERS;
  const typeName = hoa ? "HOA" : "DirectSpeakers";
  const packId = `AP_${type}1001`;
  const chanId = (i) => `AC_${type}${hex4(0x1001 + i)}`;
  const streamId = (i) => `AS_${type}${hex4(0x1001 + i)}`;
  const trackId = (i) => `AT_${type}${hex4(0x1001 + i)}_01`;
  const uid = (i) => `ATU_${hex8(i + 1)}`;
  const title = xmlEscape(spec.title || "Microtone export");
  const n = spec.channels.length;

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016" xml:lang="en">');
  L.push("<coreMetadata><format>");
  L.push('<audioFormatExtended version="ITU-R_BS.2076-1">');

  L.push(`<audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="${title}">`);
  L.push("<audioContentIDRef>ACO_1001</audioContentIDRef>");
  L.push("</audioProgramme>");
  L.push(`<audioContent audioContentID="ACO_1001" audioContentName="${title}">`);
  L.push("<audioObjectIDRef>AO_1001</audioObjectIDRef>");
  L.push("</audioContent>");
  L.push(`<audioObject audioObjectID="AO_1001" audioObjectName="${title}">`);
  L.push(`<audioPackFormatIDRef>${packId}</audioPackFormatIDRef>`);
  for (let i = 0; i < n; i++) L.push(`<audioTrackUIDRef>${uid(i)}</audioTrackUIDRef>`);
  L.push("</audioObject>");

  L.push(`<audioPackFormat audioPackFormatID="${packId}" ` +
    `audioPackFormatName="${xmlEscape(spec.packName)}" ` +
    `typeLabel="${type}" typeDefinition="${typeName}">`);
  if (hoa) L.push(`<normalization>SN3D</normalization>`);
  for (let i = 0; i < n; i++) L.push(`<audioChannelFormatIDRef>${chanId(i)}</audioChannelFormatIDRef>`);
  L.push("</audioPackFormat>");

  for (let i = 0; i < n; i++) {
    const c = spec.channels[i];
    const name = xmlEscape(c.name);
    L.push(`<audioChannelFormat audioChannelFormatID="${chanId(i)}" ` +
      `audioChannelFormatName="${name}" typeLabel="${type}" typeDefinition="${typeName}">`);
    L.push(`<audioBlockFormat audioBlockFormatID="AB_${type}${hex4(0x1001 + i)}_00000001">`);
    if (hoa) {
      L.push(`<order>${c.order}</order>`);
      L.push(`<degree>${c.degree}</degree>`);
      L.push("<normalization>SN3D</normalization>");
      L.push("<nfcRefDist>0</nfcRefDist>");
      L.push("<screenRef>0</screenRef>");
    } else {
      L.push(`<speakerLabel>urn:itu:bs:2051:0:speaker:${c.speakerLabel}</speakerLabel>`);
      L.push(`<position coordinate="azimuth">${c.azimuth.toFixed(1)}</position>`);
      L.push(`<position coordinate="elevation">${c.elevation.toFixed(1)}</position>`);
      L.push('<position coordinate="distance">1.0</position>');
    }
    L.push("</audioBlockFormat>");
    L.push("</audioChannelFormat>");

    L.push(`<audioStreamFormat audioStreamFormatID="${streamId(i)}" ` +
      `audioStreamFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
    L.push(`<audioChannelFormatIDRef>${chanId(i)}</audioChannelFormatIDRef>`);
    L.push(`<audioTrackFormatIDRef>${trackId(i)}</audioTrackFormatIDRef>`);
    L.push("</audioStreamFormat>");
    L.push(`<audioTrackFormat audioTrackFormatID="${trackId(i)}" ` +
      `audioTrackFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
    L.push(`<audioStreamFormatIDRef>${streamId(i)}</audioStreamFormatIDRef>`);
    L.push("</audioTrackFormat>");
  }

  for (let i = 0; i < n; i++) {
    L.push(`<audioTrackUID UID="${uid(i)}" sampleRate="${spec.sampleRate}" ` +
      `bitDepth="${spec.bitDepth}">`);
    L.push(`<audioTrackFormatIDRef>${trackId(i)}</audioTrackFormatIDRef>`);
    L.push(`<audioPackFormatIDRef>${packId}</audioPackFormatIDRef>`);
    L.push("</audioTrackUID>");
  }

  L.push("</audioFormatExtended>");
  L.push("</format></coreMetadata>");
  L.push("</ebuCoreMain>");
  return L.join("\n");
}

/**
 * Build the `chna` payload (BS.2088): the binary track index the XML above is
 * useless without. Fixed 40-byte records — 2-byte 1-based track number, then
 * three fixed-width ID strings and a pad byte.
 */
export function buildChna(kind, count) {
  const type = kind === "HOA" ? TYPE_HOA : TYPE_DIRECT_SPEAKERS;
  const out = new Uint8Array(4 + count * 40);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, count, true); // numTracks
  dv.setUint16(2, count, true); // numUIDs
  const put = (off, s, width) => {
    if (s.length !== width) throw new Error(`chna field "${s}" must be ${width} chars`);
    for (let i = 0; i < width; i++) out[off + i] = s.charCodeAt(i) & 0xff;
  };
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 40;
    dv.setUint16(o, i + 1, true);
    put(o + 2, `ATU_${hex8(i + 1)}`, 12);
    put(o + 14, `AT_${type}${hex4(0x1001 + i)}_01`, 14);
    put(o + 28, `AP_${type}1001`, 11);
    out[o + 39] = 0;
  }
  return out;
}

/** UTF-8 bytes of the axml document. */
export function admXmlBytes(xml) {
  return new TextEncoder().encode(xml);
}

/** Channel descriptions for an ambisonic export: ACN order, in ACN order. */
export function hoaChannelSpecs(count) {
  const out = [];
  for (let acn = 0; acn < count; acn++) {
    const [order, degree] = acnOrderDegree(acn);
    out.push({ name: `ACN${hex2(acn)}`, order, degree });
  }
  return out;
}
