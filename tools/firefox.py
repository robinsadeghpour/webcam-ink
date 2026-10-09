"""Open the page in Firefox with its built-in fake camera and report what
happens: console output, the overlay's status, and a few stills.

    python tools/firefox.py --out shots/firefox
    python tools/firefox.py --demo
"""

import argparse
import asyncio

from playwright.async_api import async_playwright


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--out", default="shots/firefox")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--wait", type=float, default=12)
    ap.add_argument("--record", action="store_true", help="also press R and save the clip")
    args = ap.parse_args()

    prefs = {
        "media.navigator.streams.fake": True,
        "media.navigator.permission.disabled": True,
        "webgl.force-enabled": True,
    }
    async with async_playwright() as p:
        browser = await p.firefox.launch(firefox_user_prefs=prefs)
        context = await browser.new_context(viewport={"width": 1600, "height": 900}, accept_downloads=True)
        page = await context.new_page()
        log = []
        page.on("console", lambda m: log.append(f"{m.type}: {m.text[:260]}"))
        page.on("pageerror", lambda e: log.append(f"PAGEERROR: {str(e)[:400]}"))
        await page.goto(args.url + ("?demo=1&bg=video" if args.demo else ""))
        await page.wait_for_timeout(int(args.wait * 1000))
        await page.screenshot(path=f"{args.out}-1.png")
        await page.mouse.move(400, 300)
        for i in range(50):
            await page.mouse.move(400 + i * 12, 300 + 150 * __import__("math").sin(i / 8), steps=1)
            await page.wait_for_timeout(16)
        await page.screenshot(path=f"{args.out}-2.png")
        if args.record:
            await page.keyboard.press("r")
            await page.wait_for_timeout(3000)
            async with page.expect_download() as waiting:
                await page.keyboard.press("r")
            download = await waiting.value
            path = f"{args.out}-clip.{download.suggested_filename.rsplit('.', 1)[-1]}"
            await download.save_as(path)
            print("clip:", download.suggested_filename, "->", path)
            await page.wait_for_timeout(300)
            print("page says:", await page.evaluate("document.getElementById('rec-text').textContent"))
        print("failure text:", repr(await page.evaluate("document.getElementById('failure').textContent")))
        for line in log:
            print("  ", line)
        await browser.close()


asyncio.run(main())
