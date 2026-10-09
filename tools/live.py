"""Exercise the live page (no demo): camera, hand model, pointer, keys.

Chromium's fake camera has no hands in it, so this only proves that the
pipeline loads and runs; it says nothing about tracking quality.

    python tools/live.py                 # fake camera, software GL
    python tools/live.py --gpu           # fake camera, real GPU
    python tools/live.py --deny          # camera refused -> paper + pointer
"""

import argparse
import asyncio

from playwright.async_api import async_playwright


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--gpu", action="store_true")
    ap.add_argument("--deny", action="store_true")
    ap.add_argument("--out", default="shots/live")
    ap.add_argument("--wait", type=float, default=12)
    ap.add_argument("--camera-file", help="an .mjpeg or .y4m file to play as the camera instead of Chromium's test pattern")
    ap.add_argument("--watch", type=float, default=0, help="take a still every half second for this long, then stop")
    ap.add_argument("--mic-file", help="a .wav file to play as the microphone instead of Chromium's test beep")
    ap.add_argument("--no-mic", action="store_true", help="open the page with ?mic=off, so claps are read from the camera alone")
    args = ap.parse_args()

    gl = ["--use-gl=angle", "--use-angle=metal"] if args.gpu else [
        "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    flags = gl + ["--ignore-gpu-blocklist"]
    if not args.deny:
        flags += ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    if args.mic_file:
        flags += [f"--use-file-for-fake-audio-capture={args.mic_file}"]
    if args.camera_file:
        flags += [f"--use-file-for-fake-video-capture={args.camera_file}"]

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=flags)
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await context.new_page()
        log = []
        page.on("console", lambda m: log.append(f"{m.type}: {m.text[:240]}"))
        page.on("pageerror", lambda e: log.append(f"PAGEERROR: {e}"))
        failed = []
        page.on("requestfailed", lambda r: failed.append(r.url))
        loaded = []
        page.on("response", lambda r: loaded.append((r.status, r.url)) if "mediapipe" in r.url else None)

        query = "?q=low" if not args.gpu else "?"
        if args.no_mic:
            query += "&mic=off"
        await page.goto(args.url + query)
        await page.wait_for_timeout(int(args.wait * 1000))
        await page.screenshot(path=f"{args.out}-1-start.png")
        if args.watch:
            for i in range(int(args.watch * 2)):
                await page.wait_for_timeout(500)
                await page.screenshot(path=f"{args.out}-watch-{i:02d}.png")
            for line in log:
                if "debug" not in line:
                    print("  ", line)
            await browser.close()
            return

        # Draw with the pointer, then drop, then try the keys.
        await page.mouse.move(300, 400)
        for i in range(70):
            await page.mouse.move(300 + i * 12, 400 + 220 * __import__("math").sin(i / 9), steps=1)
            await page.wait_for_timeout(16)
        await page.screenshot(path=f"{args.out}-2-pointer-moving.png")
        await page.mouse.click(1400, 300)
        await page.keyboard.down("Shift")
        for i in range(50):
            await page.mouse.move(1500 - i * 14, 700 + 160 * __import__("math").cos(i / 8), steps=1)
            await page.wait_for_timeout(16)
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(2500)
        await page.screenshot(path=f"{args.out}-2-pointer.png")

        await page.keyboard.press("h")
        await page.keyboard.press("p")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=f"{args.out}-3-hint.png")
        await page.keyboard.press("h")
        await page.keyboard.press("b")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=f"{args.out}-4-toggled.png")
        await page.keyboard.press("c")
        await page.wait_for_timeout(3200)
        await page.screenshot(path=f"{args.out}-5-cleared.png")

        note = await page.evaluate("document.getElementById('note').textContent")
        print("note:", repr(note))
        for status, url in loaded:
            print("  loaded", status, url.split("/")[-1])
        for url in failed:
            print("  FAILED", url)
        for line in log:
            print("  ", line)
        await browser.close()


asyncio.run(main())
