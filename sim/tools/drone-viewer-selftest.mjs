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
function fakeRenderer() {
	const r = {
		domElement: document.createElement('canvas'),
		size: null, frames: 0, disposed: 0,
		setSize(w, h) { r.size = [w, h]; },
		render() { r.frames++; },
		dispose() { r.disposed++; },
	};
	return r;
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
