"""Makes the pictures used in the README from the built-in demo
(?demo=1), which needs no camera: a short looping animation and a few
stills, written to docs/.

    npm run dev                      # in another terminal
    python tools/make-docs.py        # add --gpu on a Mac for speed

Needs Playwright (with Chromium) and Pillow.
"""

import argparse
import asyncio
import io
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

# Parts of the demo loop shown in the animation, in seconds: two hands
# drawing; a held pinch charging and letting go, then a snap wiping to
# paper; a double clap wiping back.
SEGMENTS = [(3.5, 6.1), (12.8, 17.0), (19.0, 20.3)]
STEP = 4  # simulation frames per captured frame: 15 pictures a second

STILLS = [
    # name, palette, background, overlay, time
    ("still-camera-indigo-vermilion", 1, "video", "full", 4.6),
    ("still-paper-oxblood-gold", 2, "paper", "full", 9.4),
    ("still-paper-sumi-quiet", 0, "paper", "mono", 13.6),
]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--out", default="docs")
    ap.add_argument("--gpu", action="store_true", help="use the real GPU (macOS) instead of software rendering")
    ap.add_argument("--width", type=int, default=880)
    ap.add_argument("--quality", type=int, default=58)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    gl = (
        ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]
        if args.gpu
        else ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=gl)

        # The animation.
        height = round(args.width * 9 / 16)
        page = await browser.new_page(viewport={"width": args.width, "height": height})
        await page.goto(f"{args.url}?demo=1&manual&palette=1&bg=video&q=high")
        await page.wait_for_function("window.ink !== undefined")
        frames = []
        clock = 0.0
        end = SEGMENTS[-1][1]
        while clock < end:
            clock = await page.evaluate(f"window.ink.advance({STEP})")
            if any(a <= clock <= b for a, b in SEGMENTS):
                shot = await page.screenshot(type="png")
                frames.append(Image.open(io.BytesIO(shot)).convert("RGB"))
        await page.close()
        demo = out / "demo.webp"
        frames[0].save(
            demo,
            save_all=True,
            append_images=frames[1:],
            duration=round(1000 * STEP / 60),
            loop=0,
            quality=args.quality,
            method=6,
        )
        seconds = len(frames) * STEP / 60
        print(f"{demo}: {len(frames)} frames, {seconds:.1f} s, {demo.stat().st_size / 1e6:.2f} MB")

        # The stills.
        for name, palette, background, overlay, at in STILLS:
            page = await browser.new_page(viewport={"width": 1920, "height": 1080})
            await page.goto(f"{args.url}?demo=1&manual&palette={palette}&bg={background}&overlay={overlay}&q=high")
            await page.wait_for_function("window.ink !== undefined")
            clock = 0.0
            while clock < at - 1e-6:
                clock = await page.evaluate(f"window.ink.advance({min(20, round((at - clock) * 60))})")
            shot = await page.screenshot(type="png")
            await page.close()
            image = Image.open(io.BytesIO(shot)).convert("RGB").resize((1600, 900), Image.LANCZOS)
            path = out / f"{name}.jpg"
            image.save(path, quality=88, optimize=True)
            print(f"{path}: {path.stat().st_size / 1e3:.0f} kB")
        await browser.close()


asyncio.run(main())
