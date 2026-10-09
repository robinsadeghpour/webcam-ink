"""Crop the same region out of several screenshots and lay them side by side.

    python tools/strip.py out.jpg x0 y0 x1 y1 shot1.png shot2.png ...
"""

import sys

from PIL import Image

out, x0, y0, x1, y1, *paths = sys.argv[1:]
box = tuple(int(v) for v in (x0, y0, x1, y1))
crops = [Image.open(p).convert("RGB").crop(box) for p in paths]
strip = Image.new("RGB", (sum(c.width for c in crops), crops[0].height))
x = 0
for c in crops:
    strip.paste(c, (x, 0))
    x += c.width
scale = min(1.0, 2400 / strip.width)
strip = strip.resize((round(strip.width * scale), round(strip.height * scale)), Image.LANCZOS)
strip.save(out, quality=92)
print(out, strip.size)
