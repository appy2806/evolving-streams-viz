import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// --- dev / feature flags (off for shipping) ---
const DEV_STATS = false;   // FPS overlay, dev only
const ENABLE_BLOOM = false; // post-processing glow, wired but off (sprites already glow)

// --- tunables ---
const DISK_RADIUS = 15.5;   // kpc, matches the reference
const BASE_OPACITY = 0.65;  // point-cloud opacity in toggle mode
const FADE_MS = 400;        // crossfade duration
const INIT_VIEW_KPC = 30;   // initial camera framing; user can zoom out to the full halo
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

let viewMode = 'toggle';  // 'toggle' | 'side'
let crossfade = 0;        // 0 = evolving, 1 = static (current animated value)
let crossfadeTarget = 0;  // target for the crossfade animation
let lastTime = 0;

const initialCamera = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

const guiConfig = {
    view: 'Toggle',
    model: 'Evolving',
    pointSize: 0.25,
    diskBrightness: 1.0,
    autoRotate: false,
    rotationSpeed: 0.25,
    resetCamera: () => resetCamera(),
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
    controls.autoRotate = false;
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

    setupGUI();
    applyViewMode();

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

function setupGUI() {
    const gui = new GUI();

    gui.add(guiConfig, 'view', ['Toggle', 'Side-by-side']).name('View').onChange(v => {
        viewMode = v === 'Side-by-side' ? 'side' : 'toggle';
        applyViewMode();
    });

    gui.add(guiConfig, 'model', ['Evolving', 'Static']).name('Model (Toggle)').onChange(v => {
        crossfadeTarget = v === 'Static' ? 1 : 0;
        updateToggleLabel();
    });

    const cam = gui.addFolder('Camera');
    cam.add(guiConfig, 'autoRotate').name('Auto-rotate').onChange(v => { controls.autoRotate = v; });
    cam.add(guiConfig, 'rotationSpeed', 0.05, 2.0).name('Rotation speed').onChange(v => {
        controls.autoRotateSpeed = v * 5.0;
    });
    cam.add(guiConfig, 'resetCamera').name('Reset camera');
    cam.open();

    const sc = gui.addFolder('Scene');
    sc.add(guiConfig, 'pointSize', 0.05, 0.5).name('Point size').onChange(v => { setPointSize(v); render(); });
    sc.add(guiConfig, 'diskBrightness', 0.0, 2.0).name('Disk brightness').onChange(v => {
        if (diskMesh) diskMesh.material.opacity = v;
        render();
    });
    sc.open();
}

function updateToggleLabel() {
    const key = guiConfig.model === 'Static' ? 'static' : 'evolving';
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
