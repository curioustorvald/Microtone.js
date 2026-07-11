// The \uHHHH name-escape convention. TSVM's string reader is ASCII-only, so
// every non-ASCII character in a stored name (PNam, sMet song fields, INam,
// SNam) is carried as a literal \uHHHH escape in the file. The FILE keeps the
// escapes; the frontend resolves them for display and re-escapes on save.

/** ASCII-escape every non-ASCII UTF-16 code unit as \uHHHH (uppercase hex).
 *  Idempotent: already-escaped input passes through unchanged. */
export function escapeNonAscii(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x80 ? s[i] : "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Resolve \uHHHH escapes back to characters for DISPLAY (case-insensitive
 *  hex). Inverse of escapeNonAscii for its output range. */
export function unescapeName(s) {
  if (!s || !s.includes("\\u")) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
