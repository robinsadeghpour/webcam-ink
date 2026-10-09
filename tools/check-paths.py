"""Loads the built site at each path it is hosted on and reports anything
that failed to load. Start the server first:

    npm run build && node tools/serve-paths.mjs 5182
    python tools/check-paths.py --port 5182
"""

import argparse
import asyncio

from playwright.async_api import async_playwright

PATHS = ["/", "/webcam-ink/", "/lab/ink"]
GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
FAKE = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]


async def visit(browser, url, wait):
    page = await browser.new_page(viewport={"width": 1280, "height": 720})
    bad, loaded, errors = [], [], []
    page.on("response", lambda r: (bad if r.status >= 400 else loaded).append(f"{r.status} {r.url}"))
    page.on("requestfailed", lambda r: bad.append(f"failed {r.url}"))
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    await page.goto(url)
    await page.wait_for_timeout(int(wait * 1000))
    info = await page.evaluate(
        """() => ({ base: document.baseURI, demo: typeof window.ink, failure: document.getElementById('failure').textContent })"""
    )
    await page.close()
    return bad, loaded, errors, info


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5182)
    ap.add_argument("--gpu", action="store_true", help="use the real GPU (macOS) instead of software rendering")
    args = ap.parse_args()
    gl = ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"] if args.gpu else GL
    failed = False
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=gl + FAKE)
        for path in PATHS:
            base = f"http://localhost:{args.port}{path}"
            # The demo, then the live page with a fake camera and microphone.
            for label, url, wait in (("demo", base + "?demo=1", 4), ("live", base, 9)):
                bad, loaded, errors, info = await visit(browser, url, wait)
                wanted = ["index-", ".css"] + (["vision_wasm_internal.wasm", "hand_landmarker.task"] if label == "live" else [])
                missing = [w for w in wanted if not any(w in l for l in loaded)]
                ok = not bad and not errors and not missing and not info["failure"] and (label == "live" or info["demo"] == "object")
                failed = failed or not ok
                print(f"{'ok  ' if ok else 'FAIL'} {path:14} {label}  base={info['base']}  files={len(loaded)}")
                for line in bad + errors + [f"never loaded: {m}" for m in missing]:
                    print("      ", line)
        await browser.close()
    raise SystemExit(1 if failed else 0)


asyncio.run(main())
