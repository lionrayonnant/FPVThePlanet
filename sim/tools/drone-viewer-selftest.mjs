// node tools/drone-viewer-selftest.mjs — the 3D drone on the end screen (D12).
//
// What is checked is the MODEL and the WIRING: the seed a NOMINAL build wears,
// the orbit pace, and the fact that the viewer mounts a canvas, stops cleanly
// and refuses to exist when WebGL does not. The looks are judged by eye, in a
// browser; there is none here, so the renderer is injected.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';
import { VIEWER, viewerOrbit } from './drone-viewer-model.mjs';
import { FAMILIES, nominalBuildSeed } from '../src/drone-profiles.js';

// `raf: true`: the viewer renders on an animation loop, and stop() has to be
// provably able to end it.
const dom = installFakeDom({ raf: true });
const { droneViewer } = await import('../src/drone-viewer.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('drone-viewer');

// A renderer that records rather than draws. Same surface droneViewer() uses.
function fakeRenderer({ pixelRatio = 1 } = {}) {
	const r = {
		domElement: document.createElement('canvas'),
		size: null, frames: 0, disposed: 0, scene: null, camera: null, positions: [],
		setSize(w, h) { r.size = [w, h]; },
		setPixelRatio(v) { r.ratio = v; },
		getPixelRatio() { return pixelRatio; },
		setClearAlpha() {},
		render(scene, camera) {
			r.frames++; r.scene = scene; r.camera = camera;
			r.positions.push([camera.position.x, camera.position.y, camera.position.z]);
		},
		dispose() { r.disposed++; },
	};
	return r;
}

// The drawn geometry, as a short fingerprint. Two meshes that differ by one
// tilted camera pod must not read as the same line in a diff.
function meshHash(scene) {
	let h = 0;
	scene.traverse((o) => {
		const a = o.geometry?.attributes?.position?.array;
		if (!a) return;
		for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 1e5)) | 0;
	});
	return (h >>> 0).toString(16).padStart(8, '0');
}

// --- the nominal seed ------------------------------------------------------

t('nominalBuildSeed is stable for a family', () => {
	assert.equal(nominalBuildSeed('freestyle5'), nominalBuildSeed('freestyle5'));
});

t('nominalBuildSeed differs across the six families', () => {
	const seeds = FAMILIES.map(nominalBuildSeed);
	assert.equal(new Set(seeds).size, FAMILIES.length, `collision: ${seeds.join(' ')}`);
	for (const s of seeds) {
		assert.ok(Number.isInteger(s) && s > 0, `not a usable seed: ${s}`);
	}
});

// --- the orbit -------------------------------------------------------------

t('viewerOrbit starts at the three-quarter view', () => {
	const o = viewerOrbit({ tMs: 0, dragDeg: 0 });
	assert.equal(o.azimuthDeg, VIEWER.startDeg);
	assert.equal(o.polarDeg, VIEWER.pitchDeg);
});

t('viewerOrbit turns 360 / turnS degrees per second', () => {
	const perSecond = 360 / VIEWER.turnS;
	const a = viewerOrbit({ tMs: 0 }).azimuthDeg;
	const b = viewerOrbit({ tMs: 1000 }).azimuthDeg;
	assert.ok(Math.abs(b - a - perSecond) < 1e-9, `${b - a} deg/s, expected ${perSecond}`);
	const c = viewerOrbit({ tMs: VIEWER.turnS * 1000 }).azimuthDeg;
	assert.ok(Math.abs(c - a - 360) < 1e-9, 'a full turn is not turnS seconds long');
});

t('viewerOrbit adds the accumulated drag', () => {
	const free = viewerOrbit({ tMs: 2000 });
	const dragged = viewerOrbit({ tMs: 2000, dragDeg: { az: 40, polar: -10 } });
	assert.equal(dragged.azimuthDeg, free.azimuthDeg + 40);
	assert.equal(dragged.polarDeg, free.polarDeg - 10);
	// A bare number is azimuth drag: the common case is a stick or a finger
	// pushed sideways.
	assert.equal(viewerOrbit({ tMs: 2000, dragDeg: 40 }).azimuthDeg, free.azimuthDeg + 40);
});

t('viewerOrbit never lets the camera go over the pole', () => {
	assert.ok(viewerOrbit({ dragDeg: { polar: 400 } }).polarDeg < 90);
	assert.ok(viewerOrbit({ dragDeg: { polar: -400 } }).polarDeg > -90);
});

// --- the viewer ------------------------------------------------------------

t('a target mounts a canvas of the asked size', () => {
	const r = fakeRenderer();
	const v = droneViewer({ family: 'freestyle5', buildSeed: nominalBuildSeed('freestyle5'), createRenderer: () => r });
	assert.ok(v, 'no viewer built');
	assert.equal(v.el.querySelector('canvas'), r.domElement, 'the canvas is not mounted');
	assert.deepEqual(r.size, [VIEWER.size, VIEWER.size]);
	v.stop();
});

t('it renders on the animation loop, and stop() ends it', () => {
	const r = fakeRenderer();
	const v = droneViewer({ family: 'race5', buildSeed: 'seed::1', createRenderer: () => r });
	dom.tick(16);
	dom.tick(16);
	assert.ok(r.frames >= 2, `only ${r.frames} frames drawn`);
	v.stop();
	const before = r.frames;
	dom.tick(16); dom.tick(16);
	assert.equal(r.frames, before, 'the viewer keeps drawing after stop()');
});

t('stop() disposes the renderer, and twice is harmless', () => {
	const r = fakeRenderer();
	const v = droneViewer({ family: 'cinewhoop', buildSeed: 'seed::2', createRenderer: () => r });
	v.stop();
	assert.equal(r.disposed, 1, 'the GL context is leaked');
	v.stop();
	assert.equal(r.disposed, 1, 'stop() disposed twice');
});

t('no WebGL: null, so the caller falls back to the SVG portrait', () => {
	const v = droneViewer({
		family: 'heavy5', buildSeed: 'seed::3',
		createRenderer: () => { throw new Error('no WebGL context'); },
	});
	assert.equal(v, null);
});

t('no target: null, and no exception', () => {
	const make = () => fakeRenderer();
	assert.equal(droneViewer({ family: null, buildSeed: null, createRenderer: make }), null);
	assert.equal(droneViewer({ family: 'heavy5', createRenderer: make }), null);
	assert.equal(droneViewer({ buildSeed: 'seed::9', createRenderer: make }), null);
	assert.equal(droneViewer(), null);
});

t('the camera pod comes from the SESSION seed, not the build seed', () => {
	// main.js draws the target camera from the session seed and PlayerDrone
	// wears that pod; the end-screen machine must wear the same one. The uptilt
	// rotates the camera box on the mesh, so this is observable on the geometry.
	const draw = (cameraSeed) => {
		const r = fakeRenderer();
		const v = droneViewer({ family: 'freestyle5', buildSeed: 'seed::0', cameraSeed, createRenderer: () => r });
		const h = meshHash(r.scene);
		v.stop();
		return h;
	};
	assert.notEqual(draw('session::a'), draw('session::b'), 'the camera seed is not forwarded');
	assert.equal(draw('session::a'), draw('session::a'), 'the same session gives a different machine');
	// No session (dev paths): the build seed stands in, and it still builds.
	assert.equal(draw(undefined), draw('seed::0'), 'without a session the build seed is not the fallback');
});

t('the LED resolution is in drawing-buffer pixels', () => {
	// The LED is a screen-space sprite: on a 2x display the buffer is twice the
	// CSS size, and a resolution in CSS pixels would size it wrong.
	const r = fakeRenderer({ pixelRatio: 2 });
	const v = droneViewer({ family: 'freestyle5', buildSeed: 'seed::0', size: 220, createRenderer: () => r });
	const led = [];
	r.scene.traverse((o) => { if (o.material?.uniforms?.uResolution) led.push(o.material.uniforms.uResolution.value); });
	assert.equal(led.length, 1, 'no LED material found');
	assert.equal(led[0].x, 440);
	assert.equal(led[0].y, 440);
	v.stop();
});

t('the turn is timed on the real delta, so turnS IS the pace', () => {
	// OrbitControls steps a FIXED angle per frame when it is not handed a
	// delta: the turn would last turnS at 60 Hz and half that at 120 Hz. Here
	// the same wall-clock second must turn the same 360 / turnS degrees at any
	// frame rate. The first frame is the clock's origin and carries no delta,
	// hence `frames - 1` intervals.
	const turned = (frames, msPerFrame) => {
		const r = fakeRenderer();
		const v = droneViewer({ family: 'freestyle5', buildSeed: 'seed::0', createRenderer: () => r });
		for (let i = 0; i < frames; i++) dom.tick(msPerFrame);
		v.stop();
		// three's spherical convention: x = r·sinφ·sinθ, z = r·sinφ·cosθ.
		const az = ([x, , z]) => Math.atan2(x, z) * 180 / Math.PI;
		return {
			deg: Math.abs(az(r.positions.at(-1)) - az(r.positions[0])),
			seconds: ((frames - 1) * msPerFrame) / 1000,
		};
	};
	for (const [frames, msPerFrame] of [[60, 1000 / 60], [120, 1000 / 120], [16, 1000 / 15]]) {
		const { deg, seconds } = turned(frames, msPerFrame);
		const expected = (360 / VIEWER.turnS) * seconds;
		assert.ok(Math.abs(deg - expected) < 1e-6,
			`${Math.round(1000 / msPerFrame)} Hz: turned ${deg} deg in ${seconds} s, expected ${expected}`);
		assert.ok(deg > 1e-3, 'the machine did not turn at all');
	}
});

t('every family builds, with its nominal seed', () => {
	for (const family of FAMILIES) {
		const r = fakeRenderer();
		const v = droneViewer({ family, buildSeed: nominalBuildSeed(family), createRenderer: () => r });
		assert.ok(v, `${family} has no viewer`);
		v.stop();
	}
});

dom.restore();
console.log(`\n${n} ok`);
