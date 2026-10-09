"""Tile screenshots into one contact sheet for quick review.

    python tools/sheet.py shots/sheet.jpg shots/a.png shots/b.png ...
"""

import sys

from PIL import Image

out, *paths = sys.argv[1:]
images = [Image.open(p).convert("RGB") for p in paths]
gap = 12
if images[0].width > images[0].height:
    # Landscape shots: two columns.
    tile_w = 1500
    tiles = [im.resize((tile_w, round(im.height * tile_w / im.width)), Image.LANCZOS) for im in images]
    cols = 2 if len(tiles) > 1 else 1
    rows = (len(tiles) + cols - 1) // cols
    th = tiles[0].height
    sheet = Image.new("RGB", (cols * tile_w + gap * (cols - 1), rows * th + gap * (rows - 1)), (12, 12, 13))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * (tile_w + gap), (i // cols) * (th + gap)))
else:
    tile_h = 1160
    tiles = [im.resize((round(im.width * tile_h / im.height), tile_h), Image.LANCZOS) for im in images]
    sheet = Image.new("RGB", (sum(t.width for t in tiles) + gap * (len(tiles) - 1), tile_h), (12, 12, 13))
    x = 0
    for t in tiles:
        sheet.paste(t, (x, 0))
        x += t.width + gap
sheet.save(out, quality=92)
print(out, sheet.size)
