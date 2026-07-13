# Stellar streams in evolving models

An interactive 3D visualization of globular-cluster stellar streams. It compares two
host galaxies. One is a time-evolving asymmetric host with many perturbations, so its
streams are morphologically messy. The other is a static symmetric host, so its streams
stay thin and smooth. The comparison is about morphology, so both models use the same
per-stream colors.

Science context: Arora et al. 2026 (https://arxiv.org/abs/2605.16200).

## View it

The site is fully static. A browser cannot open it over `file://` because of module and
fetch restrictions, so serve it over HTTP. From the project root:

    python -m http.server 8000

Then open http://localhost:8000 in a browser.

## Controls

- Left-drag to rotate. Scroll to zoom.
- View: switch between Toggle and Side-by-side.
    - Toggle crossfades between the evolving and static models in one shared view.
    - Side-by-side shows both models at once with a single synchronized camera.
- Camera: auto-rotate, rotation speed, and reset.
- Scene: point size, disk brightness, and a subtle starfield toggle.

## Layout

    index.html          entry point
    style.css           styling
    main.js             Three.js scene, loading, and controls
    assets/mw_disk.jpg  Milky Way disk image
    data/evolving.bin   evolving-model positions, float32 (N*M, 3)
    data/static.bin     static-model positions, float32 (N*M, 3)
    data/manifest.json  point counts, bounds, seed, units

Each `.bin` is a flat little-endian float32 array of xyz positions in galactocentric
kpc, C-order. Stream `i` occupies points `[i*M, (i+1)*M)`, which lets the app color each
stream with no extra metadata.

## Embedding

    <iframe src="https://YOUR-HOST/evolving-streams-viz/"
            width="100%" height="640"
            style="border:0; background:#000;"
            allowfullscreen loading="lazy"
            title="Stellar streams in evolving models"></iframe>

## Credits

Visualization by Arpit Arora (https://arpitarora.space/) and Adrian Price-Whelan (https://adrian.pw).

Milky Way image credit: Stefan Payne-Wardenaar (http://stefanpw.myportfolio.com/).

Rendering uses Three.js (https://threejs.org).
