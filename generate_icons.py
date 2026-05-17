"""Generates PNG icons for the extension using only Python built-ins."""
import struct, zlib, os

def make_png(size, bg=(10, 102, 194), fg=(255, 255, 255)):
    """Creates a simple PNG: blue background with a white lightning bolt."""

    def chunk(name, data):
        crc = zlib.crc32(name + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)

    pixels = []
    cx, cy = size // 2, size // 2
    bolt_w = max(2, size // 8)

    for y in range(size):
        row = []
        for x in range(size):
            # Draw a simple lightning bolt shape
            nx = (x - cx) / (size / 2)
            ny = (y - cy) / (size / 2)

            # Rounded background circle
            in_circle = nx**2 + ny**2 <= 0.82

            if not in_circle:
                row += [255, 255, 255, 0]  # transparent outside
                continue

            # Lightning bolt: two parallelogram segments
            # Upper segment: leans right  (top-center to mid-right)
            # Lower segment: leans left   (mid-left to bottom-center)
            in_bolt = False
            xs = x / size
            ys = y / size

            if 0.18 <= ys <= 0.52:  # upper half
                # bolt goes from top-center right to mid
                left  = cx + (ys - 0.18) / 0.34 * size * 0.18 - bolt_w
                right = left + bolt_w * 2.5
                if left <= x <= right:
                    in_bolt = True

            if 0.48 <= ys <= 0.82:  # lower half
                # bolt goes from mid back left to bottom-center
                right = cx - (ys - 0.48) / 0.34 * size * 0.18 + bolt_w
                left  = right - bolt_w * 2.5
                if left <= x <= right:
                    in_bolt = True

            if in_bolt:
                row += list(fg) + [255]
            else:
                row += list(bg) + [255]
        pixels.append(row)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA
    ihdr = chunk(b'IHDR', ihdr_data)

    raw_rows = b''.join(b'\x00' + bytes(row) for row in pixels)
    idat = chunk(b'IDAT', zlib.compress(raw_rows, 9))
    iend = chunk(b'IEND', b'')

    return sig + ihdr + idat + iend

out_dir = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(out_dir, exist_ok=True)

for size in [16, 48, 128]:
    data = make_png(size)
    path = os.path.join(out_dir, f'icon{size}.png')
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path}')

print('Done.')
