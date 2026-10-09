"""Screenshot the demo at chosen moments.

The page is opened with ?demo=1&manual so the simulation only advances when
this script asks, which keeps results repeatable on slow software rendering.

    python tools/shoot.py --palette 1 --bg paper --times 4 8 12 --out shots/indigo
"""

import argparse
import asyncio
import time
from pathlib import Path

from playwright.async_api import async_playwright

SOFTWARE_GL = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
]
HARDWARE_GL = [
    "--use-gl=angle",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--palette", type=int, default=0)
    ap.add_argument("--bg", default="paper", choices=["paper", "video"])
    ap.add_argument("--q", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--times", type=float, nargs="+", default=[4, 8, 12])
    ap.add_argument("--out", default="shots/demo")
    ap.add_argument("--hint", action="store_true")
    ap.add_argument("--overlay", default="full", choices=["full", "mono", "skeleton", "off"])
    ap.add_argument("--size", default="1920x1080", help="viewport; the stage letterboxes inside it")
    ap.add_argument("--aspect", default="landscape", choices=["landscape", "portrait"])
    ap.add_argument("--gpu", action="store_true", help="try the real GPU instead of SwiftShader")
    ap.add_argument("--set", nargs="*", default=[], help="JS statements run before stepping")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    query = f"?demo=1&manual&palette={args.palette}&bg={args.bg}&q={args.q}&overlay={args.overlay}&aspect={args.aspect}"
    width, height = (int(v) for v in args.size.split("x"))
    if args.hint:
        query += "&hint=1"

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=HARDWARE_GL if args.gpu else SOFTWARE_GL)
        page = await browser.new_page(viewport={"width": width, "height": height})
        problems = []
        page.on("console", lambda m: problems.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        await page.goto(args.url + query)
        try:
            await page.wait_for_function("window.ink !== undefined", timeout=20000)
        except Exception:
            print("the page did not start:")
            for line in problems:
                print("  console", line[:500])
            await browser.close()
            raise SystemExit(1)
        renderer = await page.evaluate(
            """() => { const c = document.createElement('canvas').getContext('webgl2');
            const e = c.getExtension('WEBGL_debug_renderer_info');
            return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }"""
        )
        print("renderer:", renderer)
        for statement in args.set:
            await page.evaluate(statement)

        clock = 0.0
        started = time.time()
        for t in sorted(args.times):
            while clock < t - 1e-6:
                frames = min(20, round((t - clock) * 60))
                if frames <= 0:
                    break
                clock = await page.evaluate(f"window.ink.advance({frames})")
            await page.wait_for_timeout(250)
            path = f"{out}-{t:05.1f}s.png"
            await page.screenshot(path=path)
            print(f"{path}  (sim {clock:.2f}s, wall {time.time() - started:.0f}s)")
        for line in problems:
            print("  console", line)
        await browser.close()


# The dev server reloads the page when a source file has just changed; if
# that lands mid-run, start again.
for attempt in range(3):
    try:
        asyncio.run(main())
        break
    except Exception as err:
        if "Execution context was destroyed" not in str(err) or attempt == 2:
            raise
        time.sleep(1.5)
