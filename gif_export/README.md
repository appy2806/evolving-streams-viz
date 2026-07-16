# gif_export — offline GIF renderer

Internal tooling for rendering the visualization to seamless looping GIFs (rotation, with
an optional zoom breathe). Driven by [`../make_gif.py`](../make_gif.py). Not part of the
shipped site: `index.html` never loads any of this, so it is safe to keep in the repo.

## How it works

`make_gif.py` starts a local static server, opens the site headlessly in `?export=1`
mode (a gated capture hook in `main.js` that hides all chrome and exposes a camera-pose
setter), steps the camera through exactly one seamless loop capturing PNG frames via
`capture.js`, then encodes them with `gifski` (per-frame palettes, so the galaxy-disk
gradient stays smooth). The loop is seamless because both the rotation (a full 360) and
the zoom (out -> in -> out) return to their starting pose.

## Setup

Needs Node and a Chrome/Chromium for the headless capture.

```bash
cd gif_export
npm install                                   # puppeteer-core + gifski (small; no bundled Chromium)
npx puppeteer browsers install chrome         # one-time, if you have no cached Chrome
```

`make_gif.py` auto-detects the Puppeteer Chrome under `~/.cache/puppeteer/chrome/*`.

## Usage

From the project root:

```bash
python make_gif.py --help          # all dials
python make_gif.py                 # defaults: 1200x600, 20 fps, 10 s, side-by-side,
                                   #           zoom 60 -> 30 -> 60 kpc, ~39 MB
```

Dials: `--fps --duration --quality --width --height --box-min --box-max --elevation
--turns --azimuth-start --model --out`. Set `--box-min == --box-max` for a constant zoom.
Output defaults to `renders/` (gitignored).
