"""Drive the brush the way real hands might: quick zigzags, several fingers
at once, a burst of drops, then a clear. Saves stills along the way.

    python tools/stress.py --out shots/stress
"""

import argparse
import asyncio

from playwright.async_api import async_playwright

GL = ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]

# Runs in the page. Samples arrive at 30 Hz, like a webcam, while the
# simulation steps at 60 Hz.
SCRIPT = """
async ({seconds, start}) => {
  const { brush, advance } = window.ink;
  const frames = Math.round(seconds * 60);
  let clock = 0;
  for (let i = 0; i < frames; i++) {
    const t = start + i / 60;
    if (i % 2 === 0) {
      // Left hand: three fingers in a fast zigzag, with tracking jitter.
      for (let f = 0; f < 3; f++) {
        const x = 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(t * 5.2)) + f * 0.045 + (Math.random() - 0.5) * 0.006;
        const y = 0.2 + 0.09 * t + 0.03 * Math.sin(t * 9 + f) + (Math.random() - 0.5) * 0.006;
        if (t < 4) brush.point('stress-a' + f, x, y, t, 'ink', 0);
        else brush.lift('stress-a' + f);
      }
      // Right hand: one finger tracing quick loops.
      const x = 0.72 + 0.14 * Math.cos(t * 4.1) + (Math.random() - 0.5) * 0.006;
      const y = 0.3 + 0.07 * t + 0.12 * Math.sin(t * 4.1) + (Math.random() - 0.5) * 0.006;
      if (t > 0.8 && t < 5) brush.point('stress-b', x, y, t, 'ink', 1);
      else brush.lift('stress-b');
    }
    if (i % 2 === 0 && t >= 6 && t < 6.6 && Math.round(t * 30) % 6 === 0) {
      brush.drop(0.3 + (t - 6) * 0.7, 0.16, t * 10 % 2 < 1 ? 0 : 1);
    }
    clock = advance(1);
  }
  return clock;
}
"""


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--palette", type=int, default=1)
    ap.add_argument("--bg", default="paper")
    ap.add_argument("--q", default="high")
    ap.add_argument("--out", default="shots/stress")
    args = ap.parse_args()

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=GL)
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on("console", lambda m: print("console", m.type, m.text[:300]) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: print("pageerror", e))
        # ?idle keeps the built-in choreography out of the way.
        await page.goto(f"{args.url}?demo=1&manual&idle&palette={args.palette}&bg={args.bg}&q={args.q}")
        await page.wait_for_function("window.ink !== undefined")
        start = 0.0
        for until in (1.5, 3.0, 5.0, 7.5, 10.0):
            await page.evaluate(SCRIPT, {"seconds": until - start, "start": start})
            start = until
            await page.wait_for_timeout(200)
            path = f"{args.out}-{until:04.1f}s.png"
            await page.screenshot(path=path)
            print(path)
        await browser.close()


asyncio.run(main())
