#!/usr/bin/env python3
"""Auto-vibrato ground truth, measured out of a reference player.

Synthesises minimal .it / .xm modules that play ONE looped single-cycle sine
under a known auto-vibrato setting, renders them with openmpt123 (sinc
interpolation — nearest-neighbour quantises the pitch far too coarsely to
measure), and recovers the depth in cents and the LFO period in ticks from the
instantaneous frequency of the render.

    python3 autovib-oracle.py            # the cases test/node/autovibrato.test.js pins
    python3 autovib-oracle.py --json     # machine-readable, one object per case

Needs `openmpt123` and numpy. The engine's own calibration is pinned in the
node test against the numbers this prints; re-run it after touching
advanceAutoVibrato, and update both together.

Two traps worth keeping in mind when reading the output:

- IT's `Vir` is the ONLY thing that lifts the depth accumulator off zero, so a
  sample with `Vir` = 0 renders dead flat whatever its `Vid`. The IT cases here
  all set `Vir` = 255 to reach full depth immediately.
- The single-cycle sine is looped, so the measured centre frequency is the note
  itself (500 Hz at C-5 with a 64-sample cycle at 32 kHz); everything below is
  reported relative to that.
"""

import argparse
import json
import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

CYCLE = 64        # single-cycle sine, in samples
C5 = 32000        # C-5 plays that cycle at 32 kHz → a 500 Hz tone
BPM = 125         # 20 ms per tick, so ticks and seconds convert cleanly
TICK_SEC = 2.5 / BPM


def _sine_pcm16() -> bytes:
    return b''.join(struct.pack('<h', int(30000 * math.sin(2 * math.pi * i / CYCLE)))
                    for i in range(CYCLE))


def make_it(path: Path, vis: int, vid: int, vir: int, vit: int = 0) -> None:
    """Sample-mode .it: one 16-bit looped sine with auto-vibrato at IMPS+$4C."""
    hdr = bytearray(0xC0)
    hdr[0:4] = b'IMPM'
    hdr[4:4 + 26] = b'autovib oracle'.ljust(26, b'\0')
    struct.pack_into('<HHHH', hdr, 0x20, 2, 0, 1, 1)      # Ord, Ins, Smp, Pat
    struct.pack_into('<HH', hdr, 0x28, 0x0214, 0x0214)    # Cwt, Cmwt
    struct.pack_into('<HH', hdr, 0x2C, 0x09, 0x00)        # stereo | linear slides
    hdr[0x30], hdr[0x31], hdr[0x32], hdr[0x33] = 128, 48, 6, BPM
    hdr[0x34] = 128
    for c in range(64):
        hdr[0x40 + c] = 32                                # centre pan
        hdr[0x80 + c] = 64                                # channel volume

    orders = bytes([0, 255])
    packed = bytearray([0x81, 0x03, 60, 1, 0x00])         # ch1: C-5, sample 1
    packed += bytes(63)                                   # 63 empty rows
    pat = struct.pack('<HHI', len(packed), 64, 0) + bytes(packed)

    smp_off = 0xC0 + len(orders) + 4 + 4
    pat_off = smp_off + 0x50
    data_off = pat_off + len(pat)

    smp = bytearray(0x50)
    smp[0:4] = b'IMPS'
    smp[0x04:0x10] = b'sine.raw'.ljust(12, b'\0')
    smp[0x11] = 64                                        # global volume
    smp[0x12] = 0x01 | 0x02 | 0x10                        # assoc | 16-bit | loop
    smp[0x13] = 64                                        # default volume
    smp[0x14:0x2E] = b'sine'.ljust(26, b'\0')
    smp[0x2E] = 0x01                                      # signed
    smp[0x2F] = 32
    struct.pack_into('<IIII', smp, 0x30, CYCLE, 0, CYCLE, C5)
    struct.pack_into('<I', smp, 0x48, data_off)
    smp[0x4C], smp[0x4D], smp[0x4E], smp[0x4F] = vis, vid, vir, vit

    path.write_bytes(bytes(hdr) + orders + struct.pack('<II', smp_off, pat_off)
                     + bytes(smp) + pat + _sine_pcm16())


def make_xm(path: Path, rate: int, depth: int, sweep: int, vtype: int = 0) -> None:
    """.xm 1.04: one instrument whose header carries the auto-vibrato block."""
    out = bytearray()
    out += b'Extended Module: ' + b'autovib oracle'.ljust(20, b' ') + b'\x1a'
    out += b'oracle'.ljust(20, b' ') + struct.pack('<H', 0x0104)
    out += struct.pack('<IHHHHHHHH', 20 + 256, 1, 0, 1, 1, 1, 1, 6, BPM)
    out += bytes(256)                                     # order table, order[0] = 0

    pdata = bytearray([0x80 | 0x01 | 0x02, 49, 1])        # C-5, instrument 1
    pdata += bytes([0x80]) * 63                           # 63 empty rows
    out += struct.pack('<IBHH', 9, 0, 64, len(pdata)) + bytes(pdata)

    ins = bytearray()
    ins += struct.pack('<I', 29 + 214)
    ins += b'sine'.ljust(22, b'\0') + bytes([0]) + struct.pack('<H', 1)
    ins += struct.pack('<I', 40)                          # sample header size
    ins += bytes(96)                                      # keymap → sample 0
    ins += bytes(48) + bytes(48)                          # vol / pan env points
    ins += bytes(8) + bytes(2)                            # counts, types
    ins += bytes([vtype & 0xFF, sweep & 0xFF, depth & 0xFF, rate & 0xFF])
    ins += struct.pack('<HH', 0, 0)                       # fadeout, reserved
    assert len(ins) == 29 + 214
    out += ins

    rel = round(12 * math.log2(C5 / 8363.0))
    fine = round((12 * math.log2(C5 / 8363.0) - rel) * 128)
    out += struct.pack('<III', CYCLE * 2, 0, CYCLE * 2)
    out += bytes([64, 0, 0x01 | 0x10, 128, fine & 0xFF, rel & 0xFF])
    out += b'sine'.ljust(22, b'\0')

    prev = 0
    pcm = _sine_pcm16()
    for i in range(0, len(pcm), 2):
        v = struct.unpack_from('<h', pcm, i)[0]
        out += struct.pack('<H', (v - prev) & 0xFFFF)
        prev = v
    path.write_bytes(bytes(out))


def render(path: Path, samplerate: int = 48000) -> Path:
    """openmpt123 → .wav next to the module. --filter 8 is the sinc kernel: the
    default is fine for listening, but nearest-neighbour or linear smears the
    pitch enough to swamp a ±25-cent wobble."""
    subprocess.run(
        ['openmpt123', '--quiet', '--samplerate', str(samplerate), '--channels', '1',
         '--no-float', '--filter', '8', '--dither', '0', '--render',
         '--output-type', 'wav', '--force', str(path)],
        check=True, capture_output=True)
    return path.with_suffix(path.suffix + '.wav')


def measure(wav_path: Path) -> dict:
    """Depth in cents and LFO period in ticks, from the analytic signal."""
    import numpy as np

    with wave.open(str(wav_path), 'rb') as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float)

    # Skip the attack and any sweep ramp; take a whole number of seconds.
    seg = a[int(1.5 * sr):int(5.0 * sr)]
    n = len(seg)
    h = np.zeros(n)
    h[0] = h[n // 2] = 1
    h[1:n // 2] = 2
    z = np.fft.ifft(np.fft.fft(seg) * h)
    f = np.gradient(np.unwrap(np.angle(z))) * sr / (2 * np.pi)
    f = f[3000:-3000]                        # edge effects of the transform

    lo, hi = np.percentile(f, [0.2, 99.8])   # robust against the loop-point spikes
    centre = (lo + hi) / 2
    depth_cents = 1200 * math.log2(hi / centre) if centre > 0 else 0.0

    dev = (f - f.mean()) * np.hanning(len(f))
    spectrum = np.abs(np.fft.rfft(dev))
    spectrum[:3] = 0                          # DC and the slowest drift
    f_mod = int(np.argmax(spectrum)) * sr / len(dev)
    ticks = 1.0 / (f_mod * TICK_SEC) if f_mod > 0 else float('inf')

    return {'centre_hz': round(float(centre), 3),
            'depth_cents': round(float(depth_cents), 3),
            'lfo_hz': round(float(f_mod), 4),
            'ticks_per_cycle': round(float(ticks), 3)}


# (label, kind, fields) — the cases test/node/autovibrato.test.js pins.
CASES = [
    ('IT Vis=32 Vid=64 Vir=255', 'it', dict(vis=32, vid=64, vir=255)),
    ('IT Vis=32 Vid=32 Vir=255', 'it', dict(vis=32, vid=32, vir=255)),
    ('IT Vis=8  Vid=64 Vir=255', 'it', dict(vis=8, vid=64, vir=255)),
    ('IT Vis=64 Vid=64 Vir=255', 'it', dict(vis=64, vid=64, vir=255)),
    ('IT Vis=32 Vid=64 Vir=0',   'it', dict(vis=32, vid=64, vir=0)),
    ('XM rate=32 depth=15',      'xm', dict(rate=32, depth=15, sweep=0)),
    ('XM rate=32 depth=8',       'xm', dict(rate=32, depth=8, sweep=0)),
    ('XM rate=8  depth=15',      'xm', dict(rate=8, depth=15, sweep=0)),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', action='store_true', help='one JSON object per case')
    args = ap.parse_args()

    results = []
    with tempfile.TemporaryDirectory() as tmp:
        for label, kind, fields in CASES:
            path = Path(tmp) / (label.replace(' ', '_').replace('=', '') + f'.{kind}')
            if kind == 'it':
                make_it(path, fields['vis'], fields['vid'], fields['vir'])
            else:
                make_xm(path, fields['rate'], fields['depth'], fields['sweep'])
            results.append({'case': label, **fields, **measure(render(path))})

    if args.json:
        json.dump(results, sys.stdout, indent=2)
        sys.stdout.write('\n')
    else:
        for r in results:
            print(f"{r['case']:26s} depth=±{r['depth_cents']:6.2f} cents   "
                  f"{r['ticks_per_cycle']:7.2f} ticks/cycle   "
                  f"(centre {r['centre_hz']:.1f} Hz)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
