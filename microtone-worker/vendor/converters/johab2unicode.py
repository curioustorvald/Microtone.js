#!/usr/bin/env python3
"""johab2unicode -- KS C 5601-1992 Johab (2-byte Korean) to Unicode.

The Python twin of ``src/johab2unicode.js``; both implement the encoding as it
is actually used by Iyagi music files.  See docs/JOHAB_ENCODING.en.md.

CPython ships a ``johab`` codec that covers the same ground for the standard
part of the encoding, and the test suite uses it as an oracle.  This module
exists so that converters do not depend on it, and so that the user-defined
glyph area can be handled explicitly.
"""
from __future__ import annotations

import sys

try:
    from .johab_symbols import JOHAB_SYMBOL_TABLE
except ImportError:                                  # run as a plain script
    from johab_symbols import JOHAB_SYMBOL_TABLE

__all__ = [
    "decode_johab", "decode_johab_field", "johab_char_from_code",
    "USER_AREA_FIRST", "USER_AREA_LAST",
]

#: Iyagi's user-defined glyph area, in the hole above the Hangul block.
USER_AREA_FIRST = 0xD400
USER_AREA_LAST = 0xD8FF

_CHO = [0] * 32
_JUNG = [0] * 32
_JONG = [0] * 32
for _i in range(19):
    _CHO[2 + _i] = _i + 1
for _i, _slot in enumerate(
        (3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23,
         26, 27, 28, 29)):
    _JUNG[_slot] = _i + 1
_JONG[1] = 1                                          # slot 1 == no final
for _i, _slot in enumerate(
        (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
         19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29)):
    _JONG[_slot] = _i + 2

_CHO_COMPAT = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
_JUNG_COMPAT = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
_JONG_COMPAT = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"


def johab_char_from_code(code: int) -> str | None:
    """Decode one 16-bit Johab code, or return None if it is not assigned."""
    lead = code >> 8
    if 0x84 <= lead <= 0xD3:
        cho = _CHO[(code >> 10) & 0x1F]
        jung = _JUNG[(code >> 5) & 0x1F]
        jong = _JONG[code & 0x1F]
        if cho and jung and jong:
            return chr(0xAC00 + (cho - 1) * 588 + (jung - 1) * 28 + (jong - 1))
        cho_fill = ((code >> 10) & 0x1F) == 1
        jung_fill = ((code >> 5) & 0x1F) == 2
        if cho_fill and jung_fill and jong == 1:
            return "\u3000"                          # all three fills
        if cho and jung_fill and jong == 1:
            return _CHO_COMPAT[cho - 1]
        if cho_fill and jung and jong == 1:
            return _JUNG_COMPAT[jung - 1]
        if cho_fill and jung_fill and jong > 1:
            return _JONG_COMPAT[jong - 2]
        return None
    if 0xD9 <= lead <= 0xDE:
        lead_index = lead - 0xD9
    elif 0xE0 <= lead <= 0xF9:
        lead_index = lead - 0xE0 + 6
    else:
        return None
    trail = code & 0xFF
    if 0x31 <= trail <= 0x7E:
        trail_index = trail - 0x31
    elif 0x91 <= trail <= 0xFE:
        trail_index = trail - 0x43
    else:
        return None
    ch = JOHAB_SYMBOL_TABLE[lead_index * 188 + trail_index]
    return ch if ch != "\0" else None


def decode_johab(data, replacement="�", user_glyph=None,
                 stop_at_nul=True) -> str:
    """Decode a Johab byte string.

    ``user_glyph`` is called with the 16-bit code for anything in the
    user-defined area and may return a substitute or None.
    """
    out = []
    i = 0
    n = len(data)
    while i < n:
        b = data[i]
        if b == 0x00 and stop_at_nul:
            break
        if b < 0x80:
            out.append(chr(b))
            i += 1
            continue
        if i + 1 >= n:
            out.append(replacement)
            break
        code = (b << 8) | data[i + 1]
        i += 2
        if user_glyph is not None and USER_AREA_FIRST <= code <= USER_AREA_LAST:
            g = user_glyph(code)
            if g is not None:
                out.append(g)
                continue
        ch = johab_char_from_code(code)
        out.append(ch if ch is not None else replacement)
    return "".join(out)


def decode_johab_field(data, **kwargs) -> str:
    """Decode a fixed-width text field, dropping trailing NULs and spaces."""
    end = len(data)
    while end > 0 and data[end - 1] in (0x00, 0x20):
        end -= 1
    return decode_johab(data[:end], **kwargs)


if __name__ == "__main__":
    for path in sys.argv[1:] or ["-"]:
        raw = sys.stdin.buffer.read() if path == "-" else open(path, "rb").read()
        sys.stdout.write(decode_johab(raw, stop_at_nul=False))
