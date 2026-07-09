#!/usr/bin/env python3
"""Reset the panel, capture a SNAPBEGIN/SNAPDATA/SNAPEND block, write PNG."""
import serial, time, sys, base64, struct, zlib, re

PORT = '/dev/cu.usbserial-210'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'screen.png'
WAIT = float(sys.argv[2]) if len(sys.argv) > 2 else 40

s = serial.Serial(PORT, 115200, timeout=1)
s.setDTR(False); s.setRTS(True); time.sleep(0.2); s.setRTS(False)  # hard reset
end = time.time() + WAIT
buf = b''
while time.time() < end:
    buf += s.read(16384)
    if b'SNAPEND' in buf:
        break
s.close()
print("SNAPEND seen:", b'SNAPEND' in buf)

text = buf.decode('utf-8', 'replace')
m = re.search(r'SNAPBEGIN (\d+) (\d+)', text)
if not m:
    print("no SNAPBEGIN found"); sys.exit(1)
w, h = int(m.group(1)), int(m.group(2))
data_b64 = ''.join(re.findall(r'^SNAPDATA (\S+)', text, re.M))
print("b64 chars:", len(data_b64))
data_b64 = data_b64[:len(data_b64) - (len(data_b64) % 4)]  # tolerate a dropped tail
raw = base64.b64decode(data_b64)
need = w*h*2
print(f"{w}x{h}, {len(raw)} bytes (expected {need}, diff {need-len(raw)})")
if len(raw) < need:
    raw = raw + b'\x00' * (need - len(raw))  # pad a slightly-truncated tail

# RGB565 -> RGB888 rows with PNG filter byte 0
rows = bytearray()
for y in range(h):
    rows.append(0)
    off = y*w*2
    for x in range(w):
        px = raw[off+x*2] | (raw[off+x*2+1] << 8)
        r = (px >> 11) & 0x1f; g = (px >> 5) & 0x3f; b = px & 0x1f
        rows += bytes(((r*255)//31, (g*255)//63, (b*255)//31))

def chunk(typ, data):
    c = typ + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
png += chunk(b'IEND', b'')
open(OUT, 'wb').write(png)
print("wrote", OUT)
