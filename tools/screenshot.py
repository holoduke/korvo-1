#!/usr/bin/env python3
"""Grab the panel's screen over Wi-Fi as a PNG (no PIL needed).

Usage: tools/screenshot.py out.png [--ip 192.168.2.160] [--tab N] [--drawer 0|1]
                           [--settings 0|1] [--scale 2]
The firmware serves GET /api/screen (see main/web_ui.c).
"""
import argparse, os, struct, sys, urllib.request, zlib

def png(w, h, rgb565):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        row = rgb565[y * w * 2:(y + 1) * w * 2]
        for x in range(w):
            p = row[2 * x] | (row[2 * x + 1] << 8)
            r = (p >> 11) & 0x1f; g = (p >> 5) & 0x3f; b = p & 0x1f
            raw += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--ip', default='192.168.2.160')
ap.add_argument('--tab', type=int); ap.add_argument('--drawer', type=int)
ap.add_argument('--settings', type=int); ap.add_argument('--climate', type=int)
ap.add_argument('--theme', type=int, help='persist theme N and restart the panel (no image returned)')
ap.add_argument('--scale', type=int, default=1)
a = ap.parse_args()
q = [f'scale={a.scale}'] + [f'{k}={v}' for k, v in (('tab', a.tab), ('drawer', a.drawer),
                                                   ('settings', a.settings), ('climate', a.climate),
                                                   ('theme', a.theme))
                            if v is not None]
url = f'http://{a.ip}/api/screen?' + '&'.join(q)
tok_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'secrets', 'ha_token.txt')
token = open(tok_path).read().strip()
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
data = urllib.request.urlopen(req, timeout=60).read()
if a.theme is not None:
    print(data.decode().strip()); sys.exit(0)
nl = data.index(b'\n')
tag, w, h = data[:nl].decode().split()
w, h = int(w), int(h)
body = data[nl + 1:]
if len(body) != w * h * 2:
    sys.exit(f'short body: {len(body)} != {w*h*2}')
open(a.out, 'wb').write(png(w, h, body))
print(f'{a.out}: {w}x{h}')
