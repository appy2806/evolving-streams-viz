// Headless frame grabber for the stellar-stream viz. Loads the site in ?export=1 mode
// and renders one seamless loop (full 360 rotation + optional zoom breathe) as PNGs.
// Internal tooling, driven by make_gif.py. Not part of the shipped site.
//
// Config comes as one JSON arg: {baseURL, outDir, frames, width, height,
//   boxMin, boxMax, elevationDeg, turns, azimuthStartDeg, model, chrome}
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(process.argv[2]);
const {
  baseURL, outDir, frames, width, height,
  boxMin, boxMax, elevationDeg, turns, azimuthStartDeg, model, chrome,
} = cfg;

// Zoom breathe: starts and ends at boxMax (out), reaches boxMin (in) at the midpoint.
// Cosine ease so velocity is zero at both ends -> no visible seam when the loop wraps.
function distAt(frac) {
  if (boxMin === boxMax) return boxMax;
  const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * frac);   // 0 -> 1 -> 0
  return boxMax + (boxMin - boxMax) * s;
}
function azAt(frac) {
  return (azimuthStartDeg * Math.PI / 180) + turns * 2 * Math.PI * frac;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-webgl', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('PAGE THROW:', e.message));

  const url = `${baseURL}/?export=1&model=${model}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__vizReady === true', { timeout: 60000 });

  const canvas = await page.$('#container canvas');
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    const frac = i / frames;   // [0,1); last frame is one step before wrapping to 0
    await page.evaluate((az, d, e) => window.__viz.pose(az, d, e),
                        azAt(frac), distAt(frac), elevationDeg);
    await canvas.screenshot({ path: path.join(outDir, `f${String(i).padStart(4, '0')}.png`) });
    if (i % 25 === 0) process.stdout.write(`\r  frame ${i + 1}/${frames}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  process.stdout.write(`\r  ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
