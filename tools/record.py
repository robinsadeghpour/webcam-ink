"""Press R on the demo, record a few seconds, and save the clip the page
downloads, so its size and codec can be checked with ffprobe.

    python tools/record.py --seconds 4 --out shots/clip
    python tools/record.py --chrome      # use installed Google Chrome (has H.264)
"""

import argparse
import asyncio
import json
import subprocess

from playwright.async_api import async_playwright

GL = ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5181/")
    ap.add_argument("--seconds", type=float, default=4)
    ap.add_argument("--out", default="shots/clip")
    ap.add_argument("--bg", default="video")
    ap.add_argument("--palette", type=int, default=1)
    ap.add_argument("--size", default="1280x800", help="window size; the clip size does not depend on it")
    ap.add_argument("--chrome", action="store_true")
    ap.add_argument("--reel", action="store_true", help="press Shift+R for the 1080x1920 reel frame")
    ap.add_argument("--aspect", default="landscape", choices=["landscape", "portrait"])
    args = ap.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=GL, channel="chrome" if args.chrome else None)
        context = await browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
        page = await context.new_page()
        page.on("console", lambda m: print("console", m.type, m.text[:300]) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: print("pageerror", str(e)[:400]))
        await page.goto(f"{args.url}?demo=1&bg={args.bg}&palette={args.palette}&aspect={args.aspect}")
        await page.wait_for_function("window.ink !== undefined")
        await page.wait_for_timeout(2500)
        start_key = "Shift+R" if args.reel else "r"
        await page.keyboard.press(start_key)
        await page.wait_for_timeout(1200)
        await page.screenshot(path=f"{args.out}-while-recording.png")
        await page.wait_for_timeout(int(args.seconds * 1000) - 1200)
        async with page.expect_download() as waiting:
            await page.keyboard.press("r")
        download = await waiting.value
        name = download.suggested_filename
        path = f"{args.out}.{name.rsplit('.', 1)[-1]}"
        await download.save_as(path)
        await page.wait_for_timeout(400)
        print("page says:", await page.evaluate("document.getElementById('rec-text').textContent"))
        await browser.close()

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration,size,format_name",
         "-count_frames", "-of", "json", path],
        capture_output=True, text=True)
    print(name, "->", path)
    print(json.dumps(json.loads(probe.stdout or "{}"), indent=1))
    frame = f"{args.out}-frame.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.4", "-i", path, "-frames:v", "1", frame])
    print("frame:", frame)


asyncio.run(main())
