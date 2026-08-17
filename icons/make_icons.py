#!/usr/bin/env python3
"""Generates the extension icons: dark rounded tile, blue funnel. No deps."""
import math
import struct
import zlib

BG = (11, 11, 13)
BLUE = (29, 155, 240)


def sample(fx, fy):
    # rounded tile mask
    r = 0.22
    cx = min(max(fx, r), 1 - r)
    cy = min(max(fy, r), 1 - r)
    if math.hypot(fx - cx, fy - cy) > r:
        return (0, 0, 0, 0)

    col = BG
    dx = abs(fx - 0.5)
    # funnel: mouth tapering to a stem
    if 0.26 <= fy <= 0.56:
        t = (fy - 0.26) / 0.30
        if dx <= 0.28 - t * (0.28 - 0.055):
            col = BLUE
    elif 0.56 < fy <= 0.76 and dx <= 0.055:
        col = BLUE
    return (col[0], col[1], col[2], 255)


def px(x, y, n):
    """Supersampled color+alpha for one pixel of an n-wide icon."""
    s, acc = 3, [0.0, 0.0, 0.0, 0.0]
    for sy in range(s):
        for sx in range(s):
            fx = (x + (sx + 0.5) / s) / n
            fy = (y + (sy + 0.5) / s) / n
            acc = [a + b for a, b in zip(acc, sample(fx, fy))]
    return [int(round(c / (s * s))) for c in acc]


def write_png(path, n):
    rows = b""
    for y in range(n):
        rows += b"\x00" + bytes(v for x in range(n) for v in px(x, y, n))
    raw = zlib.compress(rows, 9)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", raw)
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


for size in (16, 48, 128):
    write_png(f"icon{size}.png", size)
    print(f"icon{size}.png")
