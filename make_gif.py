#!/usr/bin/env python3
"""Render the stellar-stream viz to a seamless looping GIF.

Drives the site headlessly in ?export=1 mode: rotates a full turn while optionally
breathing the zoom in and back out, captures frames, and encodes with gifski (per-frame
palettes, so the galaxy gradient stays smooth). Everything loops cleanly because both the
rotation (a full 360) and the zoom (out -> in -> out) return to their start.

This is internal tooling and lives next to prepare_data.py. It is gitignored and not part
of the shipped site.

Examples
--------
  # default: side-by-side, dolly from 60 kpc out to 30 kpc in and back, 10 s, 20 fps
  python make_gif.py

  # tighter constant zoom, evolving model only, punchier and smaller
  python make_gif.py --box-min 25 --box-max 25 --model evolving --out renders/evolving.gif

  # smoother/higher quality (watch the size; GIF is dense here)
  python make_gif.py --fps 25 --quality 90

Run `python make_gif.py --help` for all dials.
"""
import argparse
import glob
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent                 # project root (has index.html)
EXPORT_DIR = ROOT / "gif_export"                        # node tooling
CAPTURE_JS = EXPORT_DIR / "capture.js"
GIFSKI = EXPORT_DIR / "node_modules" / "gifski" / "bin" / "debian" / "gifski"


def find_chrome():
    """Newest cached Puppeteer Chrome (full build, needed for WebGL)."""
    cands = sorted(glob.glob(str(Path.home() / ".cache/puppeteer/chrome/*/chrome-linux64/chrome")))
    if not cands:
        sys.exit("No Puppeteer Chrome found under ~/.cache/puppeteer/chrome. "
                 "Install one with:  npx puppeteer browsers install chrome")
    return cands[-1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(root, port):
    """Background static server rooted at the project (so data/ and assets/ resolve)."""
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(root), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    p = argparse.ArgumentParser(
        description="Render the stellar-stream viz to a seamless looping GIF.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--out", default="renders/streams_dolly.gif", help="output .gif path (relative to project root)")
    p.add_argument("--fps", type=int, default=20, help="frames per second (GIF steps in 1/100 s, so 20/25/50 are exact)")
    p.add_argument("--duration", type=float, default=10.0, help="loop length in seconds")
    p.add_argument("--quality", type=int, default=85, help="gifski quality 1-100 (higher = better + bigger)")
    p.add_argument("--width", type=int, default=1200, help="output width in px (6 in @ 200 dpi = 1200)")
    p.add_argument("--height", type=int, default=600, help="output height in px (3 in @ 200 dpi = 600)")
    p.add_argument("--box-min", type=float, default=30.0, help="closest zoom, kpc (camera distance at mid-loop)")
    p.add_argument("--box-max", type=float, default=60.0, help="farthest zoom, kpc (camera distance at loop ends); set == box-min for no zoom")
    p.add_argument("--elevation", type=float, default=32.0, help="camera tilt above the disk plane, degrees")
    p.add_argument("--turns", type=float, default=1.0, help="full rotations over the loop (integer keeps it seamless)")
    p.add_argument("--azimuth-start", type=float, default=0.0, help="starting azimuth, degrees")
    p.add_argument("--model", choices=["both", "evolving", "static"], default="both", help="which view to capture")
    p.add_argument("--max-mb", type=float, default=50.0, help="warn if the result exceeds this size")
    p.add_argument("--keep-frames", action="store_true", help="keep the intermediate PNG frames")
    args = p.parse_args()

    for tool, name in [(CAPTURE_JS, "gif_export/capture.js"), (GIFSKI, "gifski binary")]:
        if not Path(tool).exists():
            sys.exit(f"Missing {name} at {tool}. Run `npm install` inside {EXPORT_DIR}.")

    frames = max(1, round(args.fps * args.duration))
    out_path = (ROOT / args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()

    port = free_port()
    httpd = serve(ROOT, port)
    frames_dir = tempfile.mkdtemp(prefix="streams_frames_")

    try:
        cfg = {
            "baseURL": f"http://127.0.0.1:{port}",
            "outDir": frames_dir,
            "frames": frames,
            "width": args.width, "height": args.height,
            "boxMin": args.box_min, "boxMax": args.box_max,
            "elevationDeg": args.elevation, "turns": args.turns,
            "azimuthStartDeg": args.azimuth_start, "model": args.model, "chrome": chrome,
        }
        zoom = "constant" if args.box_min == args.box_max else f"{args.box_max:g}->{args.box_min:g}->{args.box_max:g} kpc"
        print(f"capturing {frames} frames @ {args.width}x{args.height}, model={args.model}, zoom {zoom}")
        subprocess.run(["node", str(CAPTURE_JS), json.dumps(cfg)], check=True)

        pngs = sorted(glob.glob(os.path.join(frames_dir, "f*.png")))
        if len(pngs) != frames:
            sys.exit(f"expected {frames} frames, captured {len(pngs)}")

        print(f"encoding GIF (gifski Q{args.quality}, {args.fps} fps)...")
        subprocess.run([str(GIFSKI), "-o", str(out_path),
                        "-W", str(args.width), "-H", str(args.height),
                        "--fps", str(args.fps), "-Q", str(args.quality),
                        "--quiet"] + pngs, check=True)
    finally:
        httpd.shutdown()
        if not args.keep_frames:
            shutil.rmtree(frames_dir, ignore_errors=True)
        else:
            print(f"frames kept in {frames_dir}")

    mb = out_path.stat().st_size / 1048576
    flag = "  <-- OVER limit, lower --quality or --fps" if mb > args.max_mb else ""
    print(f"\ndone: {out_path}")
    print(f"  {args.width}x{args.height}, {frames} frames, {args.fps} fps, {args.duration:g} s loop, {mb:.1f} MB{flag}")


if __name__ == "__main__":
    main()
