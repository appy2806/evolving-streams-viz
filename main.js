import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- dev / feature flags (off for shipping) ---
const DEV_STATS = false;   // FPS overlay, dev only
const ENABLE_BLOOM = false; // post-processing glow, wired but off (sprites already glow)

// Embed mode (?embed=1): hide the control panel, force auto-rotate on. The view mode
// is already side-by-side by default, so an embedded iframe shows a clean, self-running
// side-by-side comparison with no chrome.
const EMBED = new URLSearchParams(window.location.search).has('embed');

// --- tunables ---
const DISK_RADIUS = 15.5;   // kpc, matches the reference
const BASE_OPACITY = 0.65;  // point-cloud opacity in toggle mode
const FADE_MS = 400;        // crossfade duration
const INIT_VIEW_KPC = 40;   // initial camera framing; user can zoom out to the full halo
const MODEL_KEYS = ['evolving', 'static'];

// Curated vivid palette. Reads well on black and over the disk image. Cycled by
// stream index, so the same stream index gets the same color in both models and the
// comparison stays about morphology, not color.
const PALETTE = [
    0x4cc9f0, 0xf72585, 0x80ed99, 0xffd166, 0x7209b7, 0x4361ee,
    0xff6b6b, 0x06d6a0, 0xf8961e, 0xc77dff, 0x2ec4b6, 0xf9c74f,
    0xff70a6, 0x90be6d, 0x577dff, 0xffa552, 0x9b5de5, 0x00bbf9,
    0xfee440, 0xf15bb5, 0x43aa8b, 0xe07a5f, 0x8ac926, 0x00f5d4,
];

// --- globals ---
let camera, scene, renderer, controls, stats;
let container, statusEl;
const points = {};        // key -> THREE.Points
let diskMesh = null;
let manifest = null;

let viewMode = 'side';    // 'toggle' | 'side'; ships as side-by-side by default
let crossfade = 0;        // 0 = evolving, 1 = static (current animated value)
let crossfadeTarget = 0;  // target for the crossfade animation
let lastTime = 0;

const initialCamera = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

// UI state. modelMode drives both the view layout and the crossfade:
// 'evolving'/'static' -> single-cloud toggle view, 'both' -> side-by-side.
const guiConfig = {
    modelMode: 'both',
    nStreams: 100,
    pointSize: 0.25,
    diskBrightness: 1.0,
    autoRotate: true,
    rotationSpeed: 0.25,
};

// Soft round sprite (radial gradient) for additive-blended glow.
function makePointTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
    g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.Texture(canvas);
    tex.needsUpdate = true;
    return tex;
}

// Build one THREE.Points from a flat Float32Array of (n_points * 3) positions.
// Per-stream color assigned by stream index: stream i owns points [i*M, (i+1)*M).
function buildPoints(flat, nStreams, nParticles, texture) {
    const nPoints = nStreams * nParticles;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));

    const colors = new Float32Array(nPoints * 3);
    const c = new THREE.Color();
    for (let s = 0; s < nStreams; s++) {
        c.setHex(PALETTE[s % PALETTE.length]);
        const start = s * nParticles;
        for (let p = 0; p < nParticles; p++) {
            const i = (start + p) * 3;
            colors[i] = c.r;
            colors[i + 1] = c.g;
            colors[i + 2] = c.b;
        }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const material = new THREE.PointsMaterial({
        size: guiConfig.pointSize,
        map: texture,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        transparent: true,
        opacity: BASE_OPACITY,
        sizeAttenuation: true,
    });

    return new THREE.Points(geometry, material);
}

function buildDisk() {
    const geo = new THREE.PlaneGeometry(DISK_RADIUS * 2, DISK_RADIUS * 2);
    const loader = new THREE.TextureLoader();
    const tex = loader.load('assets/mw_disk.jpg', () => render());
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: guiConfig.diskBrightness,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    // Plane is already in the xy plane (z-up), disk normal along +z.
    diskMesh = new THREE.Mesh(geo, mat);
    scene.add(diskMesh);
}

function frameCamera() {
    const r = manifest.bounds.radius_kpc;
    const f = INIT_VIEW_KPC;
    initialCamera.pos.set(0, -f * 1.6, f * 1.0);
    initialCamera.target.set(0, 0, 0);
    camera.near = 0.1;
    camera.far = r * 100;
    camera.position.copy(initialCamera.pos);
    camera.up.set(0, 0, 1);
    camera.lookAt(initialCamera.target);
    camera.updateProjectionMatrix();
    controls.target.copy(initialCamera.target);
    controls.minDistance = 1;
    controls.maxDistance = r * 5;
    controls.update();
}

function resetCamera() {
    camera.position.copy(initialCamera.pos);
    camera.up.set(0, 0, 1);
    controls.target.copy(initialCamera.target);
    camera.lookAt(initialCamera.target);
    controls.update();
    render();
}

function updateCameraAspect() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const aspect = viewMode === 'side' ? (w / 2) / h : w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
}

function onWindowResize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    updateCameraAspect();
    render();
}

function setPointSize(v) {
    MODEL_KEYS.forEach(k => { if (points[k]) points[k].material.size = v; });
}

function init() {
    container = document.getElementById('container');
    statusEl = document.getElementById('status');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(0x000000, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.enablePan = false;          // pan disabled per design
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 1.0;
    controls.autoRotate = guiConfig.autoRotate || EMBED;
    // Auto-rotate orbits about the camera up axis (z, since up = +z), so it works
    // from any camera angle.
    controls.autoRotateSpeed = guiConfig.rotationSpeed * 5.0;

    const texture = makePointTexture();

    // Build both point clouds.
    MODEL_KEYS.forEach(k => {
        const m = manifest.models[k];
        const buf = m._buffer;
        points[k] = buildPoints(buf, m.n_streams, m.n_particles, texture);
        scene.add(points[k]);
    });

    buildDisk();
    frameCamera();
    updateCameraAspect();

    // Always wire the panel. In embed mode it's hidden inline (CSS), but going
    // fullscreen promotes the embed to the full experience, so the controls must
    // already exist and work.
    wireControls();       // custom console panel
    setupControlPanel();  // gear toggle + drag behavior
    if (EMBED) document.body.classList.add('embed');

    applyViewMode();
    setStreams(guiConfig.nStreams);   // default subset applied to both models
    setupHint();                      // touch-aware interaction wording
    setupFullscreen();                // shown in embed too
    setupCleanView();                 // eye toggle: hide all overlay text

    if (DEV_STATS) {
        import('three/addons/libs/stats.module.js').then(({ default: Stats }) => {
            stats = new Stats();
            stats.domElement.style.position = 'absolute';
            stats.domElement.style.top = '0px';
            container.appendChild(stats.domElement);
        });
    }

    window.addEventListener('resize', onWindowResize);
    statusEl.style.display = 'none';

    lastTime = performance.now();
    animate();
}

// Switch between the three model views. 'both' is side-by-side; the single-model
// modes reuse the crossfade so the transition into/out of Both stays smooth.
function setModelMode(mode) {
    guiConfig.modelMode = mode;
    if (mode === 'both') {
        viewMode = 'side';
    } else {
        viewMode = 'toggle';
        crossfadeTarget = mode === 'static' ? 1 : 0;
    }
    applyViewMode();
}

// Show the first n streams of each model. Streams are stored contiguously, so a draw
// range is all it takes; no data reload, and both models stay in lockstep.
function setStreams(n) {
    guiConfig.nStreams = n;
    MODEL_KEYS.forEach(k => {
        const m = manifest.models[k];
        const count = Math.max(1, Math.min(m.n_streams, n)) * m.n_particles;
        if (points[k]) points[k].geometry.setDrawRange(0, count);
    });
    render();
}

// Wire a slider to its editable number field. Dragging the slider updates the field;
// typing in the field (committed on Enter/blur) clamps to [min,max] and moves the
// slider; the per-field reset button restores the default. The number of decimals is
// inferred from the range step, so integer controls show a bare count.
function bindRange(rangeId, numId, def, onInput) {
    const range = document.getElementById(rangeId);
    const num = document.getElementById(numId);
    const min = parseFloat(range.min), max = parseFloat(range.max);
    const decimals = (range.step.split('.')[1] || '').length;
    const clamp = v => Math.max(min, Math.min(max, v));
    const fmt = v => decimals ? v.toFixed(decimals) : String(Math.round(v));

    const paint = () => {
        const pct = ((parseFloat(range.value) - min) / (max - min)) * 100;
        range.style.background = 'linear-gradient(to right, var(--accent) 0%, var(--accent) ' +
            pct + '%, var(--track) ' + pct + '%, var(--track) 100%)';
    };
    // fromNum: true when the number field is the source, so we don't overwrite what the
    // user just typed with a reformatted copy mid-edit.
    const apply = (v, fromNum) => {
        range.value = v;
        if (!fromNum) num.value = fmt(v);
        paint();
        onInput(v);
    };

    range.addEventListener('input', () => apply(parseFloat(range.value), false));
    num.addEventListener('change', () => {
        let v = parseFloat(num.value);
        if (Number.isNaN(v)) v = def;
        v = clamp(v);
        num.value = fmt(v);
        apply(v, true);
    });
    const resetBtn = num.parentElement.querySelector('.mini-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => { num.value = fmt(def); apply(def, true); });

    num.value = fmt(parseFloat(range.value));
    paint();
}

function wireControls() {
    // Segmented model control with a sliding cyan indicator.
    const seg = document.getElementById('seg-model');
    const ind = seg.querySelector('.seg-ind');
    const btns = [...seg.querySelectorAll('.seg-btn')];
    const modes = btns.map(b => b.dataset.mode);
    const selectMode = (mode) => {
        const i = modes.indexOf(mode);
        btns.forEach((b, j) => {
            const on = j === i;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        ind.style.transform = 'translateX(' + (i * 100) + '%)';
        setModelMode(mode);
    };
    btns.forEach(b => b.addEventListener('click', () => selectMode(b.dataset.mode)));
    selectMode(guiConfig.modelMode);

    bindRange('r-streams', 'v-streams', 100, v => setStreams(v | 0));
    bindRange('r-size', 'v-size', 0.25, v => { setPointSize(v); render(); });
    bindRange('r-disk', 'v-disk', 1.0, v => {
        if (diskMesh) diskMesh.material.opacity = v;
        render();
    });
    bindRange('r-speed', 'v-speed', 0.25, v => { controls.autoRotateSpeed = v * 5.0; });

    // Auto-rotate pill switch.
    const sw = document.getElementById('sw-rotate');
    const setSwitch = (on) => {
        guiConfig.autoRotate = on;
        controls.autoRotate = on;
        sw.classList.toggle('on', on);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
    };
    setSwitch(guiConfig.autoRotate);
    sw.addEventListener('click', () => setSwitch(!guiConfig.autoRotate));

    document.getElementById('btn-reset').addEventListener('click', () => resetCamera());
}

// Gear button: toggles the collapsed panel and can be dragged (mouse or touch)
// anywhere on screen. A small movement threshold distinguishes a tap from a drag.
function setupControlPanel() {
    const controls = document.getElementById('controls');
    const gear = document.getElementById('gear');

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originRight = 0, originTop = 0;
    const THRESH = 5;  // px of travel before a tap becomes a drag
    const M = 8;       // min gap from the viewport edges

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    // Anchor by the RIGHT edge so the gear stays put while the panel grows leftward
    // and downward. Clamp both axes so the expanded panel is never pushed off-screen.
    function place(right, top) {
        const w = controls.offsetWidth;
        const h = controls.offsetHeight;
        controls.style.left = 'auto';
        controls.style.right = clamp(right, M, Math.max(M, window.innerWidth - w - M)) + 'px';
        controls.style.top = clamp(top, M, Math.max(M, window.innerHeight - h - M)) + 'px';
    }

    function currentPos() {
        const rect = controls.getBoundingClientRect();
        return { right: window.innerWidth - rect.right, top: rect.top };
    }

    gear.addEventListener('pointerdown', (e) => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const p = currentPos();
        originRight = p.right;
        originTop = p.top;
        gear.setPointerCapture(e.pointerId);
    });

    gear.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > THRESH || Math.abs(dy) > THRESH) moved = true;
        place(originRight - dx, originTop + dy);
    });

    gear.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        if (gear.hasPointerCapture(e.pointerId)) gear.releasePointerCapture(e.pointerId);
        if (!moved) {
            const open = controls.classList.toggle('open');
            gear.setAttribute('aria-expanded', open ? 'true' : 'false');
            // The panel just changed size: re-clamp so it stays fully on-screen.
            const p = currentPos();
            place(p.right, p.top);
        }
    });

    // Keep it on-screen through rotation / resize. Skip while the panel is hidden
    // (collapsed embed): a display:none element has a zero rect, which would compute
    // a bogus off-screen position and strand the gear when fullscreen reveals it.
    window.addEventListener('resize', () => {
        if (!controls.offsetParent) return;
        const p = currentPos();
        place(p.right, p.top);
    });
}

// The interaction hint depends on the input device: touch has no left-drag or scroll.
function setupHint() {
    const el = document.getElementById('info-hint');
    if (!el) return;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    el.textContent = touch ? 'Drag: rotate. Pinch: zoom.' : 'Left-drag: rotate. Scroll: zoom.';
}

// Fullscreen toggle. Works inside an iframe when the embed grants allowfullscreen.
function setupFullscreen() {
    const btn = document.getElementById('fs-btn');
    if (!btn) return;
    const target = document.documentElement;
    btn.addEventListener('click', () => {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        } else {
            (target.requestFullscreen || target.webkitRequestFullscreen)?.call(target);
        }
    });
    const onChange = () => {
        const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        btn.classList.toggle('active', fs);
        // In embed mode this reveals the (otherwise hidden) control panel.
        document.body.classList.toggle('fs', fs);
        // Promoting an embed to fullscreen should match the main site: a collapsed
        // gear in the default top-right corner. Clear any stale inline position so it
        // snaps back to the corner, and make sure it starts collapsed.
        if (EMBED && fs) {
            const ctrls = document.getElementById('controls');
            ctrls.style.left = ctrls.style.right = ctrls.style.top = '';
            ctrls.classList.remove('open');
            document.getElementById('gear').setAttribute('aria-expanded', 'false');
        }
        onWindowResize();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
}

// Clean view: fade out all overlay text (title, credits, labels) for a pristine
// still. The eye button itself recedes but stays reachable (see style.css).
function setupCleanView() {
    const btn = document.getElementById('clean-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const hidden = document.body.classList.toggle('chrome-hidden');
        btn.classList.toggle('active', hidden);
        btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        btn.title = hidden ? 'Show text' : 'Hide text';
    });
}

function updateToggleLabel() {
    const key = guiConfig.modelMode === 'static' ? 'static' : 'evolving';
    document.getElementById('label-toggle').textContent = manifest.models[key].label;
}

function applyViewMode() {
    document.getElementById('label-left').textContent = manifest.models.evolving.label;
    document.getElementById('label-right').textContent = manifest.models.static.label;
    updateToggleLabel();
    document.body.classList.toggle('side-by-side', viewMode === 'side');
    updateCameraAspect();
    render();
}

// Full opacity, single cloud visible. Used for each side-by-side viewport.
function showOnly(key) {
    MODEL_KEYS.forEach(k => {
        points[k].visible = (k === key);
        points[k].material.opacity = BASE_OPACITY;
    });
}

function render() {
    if (!renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;

    if (viewMode === 'side') {
        renderer.setScissorTest(true);
        // Left: evolving
        renderer.setViewport(0, 0, w / 2, h);
        renderer.setScissor(0, 0, w / 2, h);
        showOnly('evolving');
        renderer.render(scene, camera);
        // Right: static
        renderer.setViewport(w / 2, 0, w / 2, h);
        renderer.setScissor(w / 2, 0, w / 2, h);
        showOnly('static');
        renderer.render(scene, camera);
        renderer.setScissorTest(false);
    } else {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        points.evolving.visible = crossfade < 0.999;
        points.static.visible = crossfade > 0.001;
        points.evolving.material.opacity = BASE_OPACITY * (1 - crossfade);
        points.static.material.opacity = BASE_OPACITY * crossfade;
        renderer.render(scene, camera);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = now - lastTime;
    lastTime = now;

    // Smooth crossfade toward the selected model.
    if (crossfade !== crossfadeTarget) {
        const step = dt / FADE_MS;
        if (crossfade < crossfadeTarget) crossfade = Math.min(crossfadeTarget, crossfade + step);
        else crossfade = Math.max(crossfadeTarget, crossfade - step);
    }

    controls.update();
    render();
    if (stats) stats.update();
}

// --- data loading ---
async function loadModel(key) {
    const m = manifest.models[key];
    const resp = await fetch('data/' + m.file);
    if (!resp.ok) throw new Error('failed to fetch ' + m.file + ' (' + resp.status + ')');
    const buf = await resp.arrayBuffer();
    const arr = new Float32Array(buf);
    const expected = m.n_points * 3;
    if (arr.length !== expected) {
        throw new Error(m.file + ': expected ' + expected + ' floats, got ' + arr.length);
    }
    m._buffer = arr;
}

async function main() {
    const statusEl0 = document.getElementById('status');
    try {
        if (!window.WebGLRenderingContext) throw new Error('WebGL is not supported by this browser.');
        const mresp = await fetch('data/manifest.json');
        if (!mresp.ok) throw new Error('failed to fetch manifest.json (' + mresp.status + ')');
        manifest = await mresp.json();
        await Promise.all(MODEL_KEYS.map(loadModel));
        init();
    } catch (err) {
        console.error(err);
        statusEl0.textContent = 'Could not load visualization: ' + err.message;
        statusEl0.classList.add('error');
        statusEl0.style.display = 'block';
    }
}

main();
