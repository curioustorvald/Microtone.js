// Vector note-glyph painter — the web equivalent of taut's custom pattern
// font (tautfont_*.chr), redrawn as canvas paths so they scale with the cell
// metrics. Renders the 4-char-wide note cell:
//
//   [tick][letter][accidental][octave]     tuned presets (Kite ticks lead)
//   [  CJK char spanning 2  ][oct][ ]      Shi'er lü (conventional CJK font)
//   [    sentinel vector, full width  ]    key-off / cut / fade / fast-fade
//   [ raw hex4 ]                           Raw preset / off-grid notes
//
// Sentinel shapes (per spec): key-off = wide low-height rectangle box;
// cut = vertically-centred CONNECTED ^^^; fade = centred connected
// greater-amplitude ~~~; fast-fade = the fade mirrored vertically.

import { resolveNoteSymbol } from "./pitchtables.js";
import { hex4 } from "./notenames.js";

export const NOTE_CELL_CHARS = 4;

const LW = 1.3; // stroke width for glyph paths

// ── sentinel vectors (span the whole cell width) ──

function drawKeyOff(ctx, x, y, w, h) {
  const bw = w * 0.66;
  const bh = h * 0.28;
  ctx.strokeRect(x + (w - bw) / 2 + 0.5, y + (h - bh) / 2 + 0.5, bw, bh);
}

function drawCut(ctx, x, y, w, h) {
  // connected ^^^ — three peaks, vertically centred
  const amp = h * 0.17;
  const cy = y + h / 2;
  const x0 = x + w * 0.14;
  const x1 = x + w * 0.86;
  const peaks = 3;
  const seg = (x1 - x0) / (peaks * 2);
  ctx.beginPath();
  ctx.moveTo(x0, cy + amp);
  for (let i = 0; i < peaks; i++) {
    ctx.lineTo(x0 + seg * (i * 2 + 1), cy - amp);
    ctx.lineTo(x0 + seg * (i * 2 + 2), cy + amp);
  }
  ctx.stroke();
}

function drawFade(ctx, x, y, w, h, mirrored) {
  // connected ~~~ — two full sine periods, higher amplitude than the cut
  const amp = h * 0.26 * (mirrored ? -1 : 1);
  const cy = y + h / 2;
  const x0 = x + w * 0.12;
  const x1 = x + w * 0.88;
  const n = 32;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const px = x0 + ((x1 - x0) * i) / n;
    const py = cy - Math.sin((i / n) * Math.PI * 4) * amp;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// ── accidentals (one char slot; normalized box with side padding) ──

function drawSharpBody(ctx, x, y, w, h, verticals) {
  // verticals straight; crossbars slanted UPWARD to the right (♯, not #)
  const rise = h * 0.09;
  const xL = x + w * 0.18;
  const xR = x + w * 0.82;
  const vXs = [];
  for (let i = 0; i < verticals; i++) {
    const t = verticals === 1 ? 0.5 : 0.3 + (0.4 * i) / (verticals - 1);
    vXs.push(x + w * t);
  }
  ctx.beginPath();
  for (const vx of vXs) {
    ctx.moveTo(vx, y + h * 0.16);
    ctx.lineTo(vx, y + h * 0.84);
  }
  for (const cy of [y + h * 0.40, y + h * 0.66]) {
    ctx.moveTo(xL, cy + rise);
    ctx.lineTo(xR, cy - rise);
  }
  ctx.stroke();
}

function drawFlatBody(ctx, x, y, w, h, mirrored, count = 1) {
  // stem + right-facing loop (♭); mirrored = demiflat (loop opens left)
  const span = w * 0.72;
  const each = span / count;
  for (let i = 0; i < count; i++) {
    const sx = mirrored
      ? x + w * 0.86 - each * i
      : x + w * 0.14 + each * i;
    const dir = mirrored ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(sx, y + h * 0.12);
    ctx.lineTo(sx, y + h * 0.82);
    ctx.bezierCurveTo(
      sx + dir * each * 0.85, y + h * 0.52,
      sx + dir * each * 0.55, y + h * 0.40,
      sx, y + h * 0.58,
    );
    ctx.stroke();
  }
}

function drawDoubleSharp(ctx, x, y, w, h, pair = false) {
  // 𝄪 — an × with serif dots; pair=true draws two side by side (quad sharp)
  const draw = (cx, cy, r) => {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.stroke();
    const d = r * 0.36;
    for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      ctx.fillRect(cx + dx - d / 2, cy + dy - d / 2, d, d);
    }
  };
  const cy = y + h * 0.5;
  if (pair) {
    draw(x + w * 0.3, cy, w * 0.17);
    draw(x + w * 0.72, cy, w * 0.17);
  } else {
    draw(x + w * 0.5, cy, w * 0.24);
  }
}

function drawTripleSharp(ctx, x, y, w, h) {
  // ♯𝄪 compressed: small sharp left, small × right
  drawSharpBody(ctx, x - w * 0.18, y + h * 0.06, w * 0.66, h * 0.88, 2);
  const cx = x + w * 0.74;
  const cy = y + h * 0.5;
  const r = w * 0.16;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
  ctx.stroke();
}

function drawNatural(ctx, x, y, w, h) {
  // degree marker for naturals: short centred dash (taut accnull idiom)
  ctx.beginPath();
  ctx.moveTo(x + w * 0.28, y + h * 0.5);
  ctx.lineTo(x + w * 0.72, y + h * 0.5);
  ctx.stroke();
}

// ── Kite ticks (one char slot) ──

function drawTick(ctx, x, y, w, h, up, double_) {
  const cx = x + w * 0.5;
  const aw = w * 0.32;
  const ah = h * 0.16;
  const draw = (cy) => {
    ctx.beginPath();
    if (up) {
      ctx.moveTo(cx - aw, cy + ah);
      ctx.lineTo(cx, cy - ah);
      ctx.lineTo(cx + aw, cy + ah);
    } else {
      ctx.moveTo(cx - aw, cy - ah);
      ctx.lineTo(cx, cy + ah);
      ctx.lineTo(cx + aw, cy - ah);
    }
    ctx.stroke();
  };
  if (double_) {
    draw(y + h * 0.36);
    draw(y + h * 0.64);
  } else {
    draw(y + h * 0.5);
  }
}

function drawBigDot(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.5, Math.max(w, 4) * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

function drawAccidental(ctx, code, x, y, w, h) {
  switch (code) {
    case "#": drawSharpBody(ctx, x, y, w, h, 2); break;
    case "t": drawSharpBody(ctx, x, y, w, h, 1); break;          // demisharp
    case "b": drawFlatBody(ctx, x, y, w, h, false, 1); break;
    case "p": drawFlatBody(ctx, x, y, w, h, true, 1); break;     // demiflat
    case "x": drawDoubleSharp(ctx, x, y, w, h, false); break;
    case "B": drawFlatBody(ctx, x, y, w, h, false, 2); break;    // double flat
    case "3": drawTripleSharp(ctx, x, y, w, h); break;
    case "T": drawFlatBody(ctx, x, y, w, h, false, 3); break;    // triple flat
    case "4": drawDoubleSharp(ctx, x, y, w, h, true); break;     // quad sharp
    default: drawNatural(ctx, x, y, w, h); break;                // '-'
  }
}

function drawTickCode(ctx, code, x, y, w, h) {
  switch (code) {
    case ".": drawBigDot(ctx, x, y, w, h); break;
    case "u": drawTick(ctx, x, y, w, h, true, false); break;
    case "d": drawTick(ctx, x, y, w, h, false, false); break;
    case "U": drawTick(ctx, x, y, w, h, true, true); break;
    case "D": drawTick(ctx, x, y, w, h, false, true); break;
    default: break; // ' ' — no tick
  }
}

/**
 * Paint the 4-char note cell at (x, y). Uses the ambient ctx.font for text
 * slots (letters/digits) and vector paths for symbols. `palette` supplies
 * {note, sentinel, dim}; the cell renders in `palette.note` unless it is a
 * sentinel/empty.
 */
export function paintNoteCell(ctx, note, preset, x, y, charW, rowH, palette) {
  const cellW = charW * NOTE_CELL_CHARS;
  const midY = y + rowH / 2;

  if (note === 0x0000) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    ctx.fillText("····", x, midY);
    ctx.globalAlpha = 1;
    return;
  }

  // Sentinels — full-width vectors.
  if (note >= 0x0001 && note <= 0x0004) {
    ctx.strokeStyle = palette.sentinel;
    ctx.fillStyle = palette.sentinel;
    ctx.lineWidth = LW;
    ctx.lineJoin = "miter";
    switch (note) {
      case 0x0001: drawKeyOff(ctx, x, y, cellW, rowH); break;
      case 0x0002: drawCut(ctx, x, y, cellW, rowH); break;
      case 0x0003: drawFade(ctx, x, y, cellW, rowH, false); break;
      case 0x0004: drawFade(ctx, x, y, cellW, rowH, true); break;
    }
    return;
  }
  if (note >= 0x0005 && note <= 0x000f) {
    ctx.fillStyle = palette.dim;
    ctx.fillText("res·", x, midY);
    return;
  }
  if (note >= 0x0010 && note <= 0x001f) {
    ctx.fillStyle = palette.sentinel;
    ctx.fillText("In·" + (note - 0x0010).toString(16).toUpperCase(), x, midY);
    return;
  }

  const symb = resolveNoteSymbol(note, preset);
  if (symb === null) {
    // Raw preset or off-grid note: honest 4-digit hex.
    ctx.fillStyle = palette.dim;
    ctx.fillText(hex4(note), x, midY);
    return;
  }

  ctx.fillStyle = palette.note;
  ctx.strokeStyle = palette.note;
  ctx.lineWidth = LW;
  ctx.lineJoin = "miter";

  if (symb.cjk) {
    // Shi'er lü — conventional CJK font across two slots + octave digit.
    const prevFont = ctx.font;
    ctx.font = `${Math.round(rowH - 3)}px "Noto Sans CJK TC", "Noto Sans TC", "WenQuanYi Zen Hei", serif`;
    ctx.fillText(symb.cjk, x + charW * 0.1, midY + 0.5);
    ctx.font = prevFont;
    ctx.fillText(String(symb.octave), x + charW * 2.35, midY);
    return;
  }

  // [tick][letter][accidental][octave]
  drawTickCode(ctx, symb.tick, x, y + 1, charW, rowH - 2);
  ctx.fillText(symb.letter, x + charW * 1.1, midY);
  drawAccidental(ctx, symb.acc, x + charW * 2.05, y + 2, charW * 0.95, rowH - 4);
  ctx.fillText(String(symb.octave), x + charW * 3.1, midY);
}
