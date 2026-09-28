// Selftest of the trace hairline (issue #185): the pure split/fade/gate
// helpers, then TraceLine itself against real THREE (no renderer needed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
	TraceLine, flownSegments, flownOpacity, gateCorners,
	FLOWN_OPACITY, REST_OPACITY, GATE_SIDE_M, LINE_WIDTH_PX,
} from '../src/trace-line.js';
import { token } from '../src/palette.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A straight trace along +X, 2 m spacing, 11 points, 20 m long.
function straight(count = 11, step = 2) {
	const points = new Float32Array(count * 3);
	const cum = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		points[i * 3] = i * step; points[i * 3 + 1] = 30; points[i * 3 + 2] = 0;
		cum[i] = i * step;
	}
	return { id: 'wd:Q1', shape: 'orbit', points, cum, length: (count - 1) * step, tolerance: 5 };
}

t('flownSegments: nothing flown at 0, everything at 1', () => {
	const tr = straight();
	assert.equal(flownSegments(tr.cum, tr.length, 0), 0);
	assert.equal(flownSegments(tr.cum, tr.length, 1), 10);
});

t('flownSegments: splits at the last vertex reached', () => {
	const tr = straight();
	assert.equal(flownSegments(tr.cum, tr.length, 0.5), 5);   // 10 m → point 5
	assert.equal(flownSegments(tr.cum, tr.length, 0.59), 5);  // 11.8 m → still 5
	assert.equal(flownSegments(tr.cum, tr.length, 0.6), 6);   // 12 m → point 6
});

t('flownSegments: clamped, and safe on a degenerate trace', () => {
	const tr = straight();
	assert.equal(flownSegments(tr.cum, tr.length, -1), 0);
	assert.equal(flownSegments(tr.cum, tr.length, 3), 10);
	assert.equal(flownSegments(new Float32Array(1), 0, 0.5), 0);
});

t('flownOpacity: full at fade 0, gone at fade 1, linear, clamped', () => {
	assert.equal(flownOpacity(0), FLOWN_OPACITY);
	assert.equal(flownOpacity(1), 0);
	assert.ok(Math.abs(flownOpacity(0.5) - FLOWN_OPACITY / 2) < 1e-9);
	assert.equal(flownOpacity(-2), FLOWN_OPACITY);
	assert.equal(flownOpacity(2), 0);
	assert.ok(FLOWN_OPACITY < REST_OPACITY, 'the flown part steps back');
});

t('gateCorners: closed 3 m square centred on point 0, perpendicular to the path', () => {
	const tr = straight();
	const c = gateCorners(tr.points);
	assert.equal(c.length, 15);
	assert.deepEqual([...c.slice(0, 3)], [...c.slice(12, 15)], 'closed');
	let cx = 0, cy = 0, cz = 0;
	for (let i = 0; i < 4; i++) { cx += c[i * 3]; cy += c[i * 3 + 1]; cz += c[i * 3 + 2]; }
	assert.ok(Math.abs(cx / 4) < 1e-5 && Math.abs(cy / 4 - 30) < 1e-5 && Math.abs(cz / 4) < 1e-5, 'centred');
	for (let i = 0; i < 4; i++) {
		assert.ok(Math.abs(c[i * 3]) < 1e-5, 'in the plane x = 0 (path along +X)');
		const side = Math.hypot(c[i * 3 + 3] - c[i * 3], c[i * 3 + 4] - c[i * 3 + 1], c[i * 3 + 5] - c[i * 3 + 2]);
		assert.ok(Math.abs(side - GATE_SIDE_M) < 1e-5, `side ${side}`);
	}
});

t('gateCorners: a vertical first segment still gives a square', () => {
	const pts = new Float32Array([0, 0, 0, 0, 2, 0]);
	const c = gateCorners(pts);
	assert.ok([...c].every(Number.isFinite));
	for (let i = 0; i < 4; i++) assert.ok(Math.abs(c[i * 3 + 1]) < 1e-5, 'horizontal square');
});

t('TraceLine: builds hidden, colours from the palette tokens', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	assert.equal(scene.children.length, 1);
	assert.equal(line.group.visible, false);
	assert.equal(`#${line.restMat.color.getHexString()}`, token('--yellow'));
	assert.equal(`#${line.flownMat.color.getHexString()}`, token('--green'));
	assert.equal(line.restMat.linewidth, LINE_WIDTH_PX);
	assert.equal(line.restMat.worldUnits, false);
	assert.equal(line.restMat.depthTest, true);
	assert.equal(line.restMat.depthWrite, false);
	assert.equal(line.restMat.fog, false);
	assert.equal(line.restMat.transparent, true);
	line.dispose();
	assert.equal(scene.children.length, 0);
});

t('TraceLine: show → all yellow, gate yellow; progress splits by instanceCount', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	const tr = straight();
	line.show(tr);
	assert.equal(line.group.visible, true);
	assert.equal(line.group.children.length, 3);
	assert.equal(line.rest.geometry.instanceCount, 10);
	assert.equal(line.flown.visible, false);
	assert.equal(`#${line.gateMat.color.getHexString()}`, token('--yellow'));

	line.setProgress(0.5, 'on', 0);
	assert.equal(line.flown.geometry.instanceCount, 5);
	assert.equal(line.rest.geometry.instanceCount, 5);
	assert.equal(line.flown.visible, true);
	assert.equal(`#${line.gateMat.color.getHexString()}`, token('--green'), 'gate green once entered');
	// The rest geometry is reversed: its first instance starts at the trace's end.
	const start = line.rest.geometry.attributes.instanceStart;
	assert.equal(start.getX(0), 20);
	// And its (n-1-k)-th instance ends exactly where the flown part stops.
	const end = line.rest.geometry.attributes.instanceEnd;
	assert.equal(end.getX(4), 10);
	assert.equal(line.flown.geometry.attributes.instanceEnd.getX(4), 10);

	line.setProgress(1, 'done', 0);
	assert.equal(line.rest.visible, false);
	assert.equal(line.flown.geometry.instanceCount, 10);
	line.dispose();
});

t('TraceLine: fade cools the flown part only, reset brings the gate back to yellow', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	line.show(straight());
	line.setProgress(0.4, 'off', 0.5);
	assert.ok(Math.abs(line.flownMat.opacity - FLOWN_OPACITY / 2) < 1e-9);
	assert.equal(line.restMat.opacity, REST_OPACITY);
	line.setProgress(0.4, 'off', 1);
	assert.equal(line.flown.visible, false);
	line.setProgress(0, 'waiting', 0);
	assert.equal(`#${line.gateMat.color.getHexString()}`, token('--yellow'));
	assert.equal(line.rest.geometry.instanceCount, 10);
	line.dispose();
});

t('TraceLine: setVisible (capture) and hide compose; show replaces', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	line.show(straight());
	line.setVisible(false);
	assert.equal(line.group.visible, false);
	line.setVisible(true);
	assert.equal(line.group.visible, true);
	line.hide();
	line.setVisible(true);
	assert.equal(line.group.visible, false, 'hidden stays hidden through a capture');
	line.show(straight(21));
	assert.equal(line.group.visible, true);
	assert.equal(line.group.children.length, 3, 'the old lines are gone');
	assert.equal(line.rest.geometry.instanceCount, 20);
	line.show({ points: new Float32Array(3), cum: new Float32Array(1), length: 0 });
	assert.equal(line.group.visible, false, 'a one-point trace shows nothing');
	line.setProgress(0.5, 'on', 0); // no trace: a no-op, not a throw
	line.dispose();
});

t('TraceLine: setResolution reaches the three materials', () => {
	const line = new TraceLine(new THREE.Scene());
	line.setResolution(1920, 1080);
	for (const m of [line.restMat, line.flownMat, line.gateMat]) {
		assert.equal(m.resolution.x, 1920);
		assert.equal(m.resolution.y, 1080);
	}
	// A draw must not put the canvas size back (LineSegments2.onBeforeRender
	// writes the renderer's viewport, not the composer target's).
	line.show(straight());
	const renderer = { getViewport: (v) => v.set(0, 0, 1280, 800) };
	for (const l of [line.rest, line.flown, line.gate]) l.onBeforeRender(renderer);
	for (const m of [line.restMat, line.flownMat, line.gateMat]) assert.equal(m.resolution.x, 1920);
	line.dispose();
});

t('trace-line.js uses no colour literal and no demo token', () => {
	const src = readFileSync(new URL('../src/trace-line.js', import.meta.url), 'utf8')
		.replace(/\/\/.*$/gm, '');
	assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b|0x[0-9a-f]{6}\b/i, 'colour literal');
	assert.doesNotMatch(src, /--(cyan|magenta|violet|electric)/, 'demo token');
});

console.log(`trace-line-selftest: ${n} tests ok`);
