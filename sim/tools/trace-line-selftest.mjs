// Selftest of the trace line (issue #185): the pure split/fade/gate
// helpers, then TraceLine itself against real THREE (no renderer needed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
	TraceLine, flownSegments, flownOpacity, gateCorners, lineWidthAt,
	FLOWN_OPACITY, REST_OPACITY, GATE_SIDE_M, LINE_WIDTH_PX, LINE_WIDTH_FAR_PX,
	WIDTH_NEAR_M, WIDTH_FAR_M, MIN_TARGET_PX, OUTLINE_PX, OUTLINE_MIN_TARGET_PX, UNDER_OPACITY, underlayTargetPx,
	tickArcs, pointAt, chevronAt, TICK_NEAR_M, TICK_SPACING_M, TICK_AHEAD_M, TICK_MAX, TICK_ANGLE, TICK_MIN_M, TICK_MAX_M, TICK_WIDTH_PX,
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
	assert.ok(FLOWN_OPACITY >= 0.8, 'and still reads through the lens');
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
	assert.equal(line.group.children.length, 8, 'three lines, three underlays, the ticks and theirs');
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
	assert.equal(line.group.children.length, 8, 'the old lines are gone');
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
	const renderer = { getViewport: (v) => v.set(0, 0, 1280, 800), getSize: (v) => v.set(1280, 720) };
	for (const l of [line.rest, line.flown, line.gate]) l.onBeforeRender(renderer);
	for (const m of [line.restMat, line.flownMat, line.gateMat]) assert.equal(m.resolution.x, 1920);
	line.dispose();
});

t('lineWidthAt: 3 px near, 5 px far, smooth and monotonic between', () => {
	assert.equal(lineWidthAt(0), LINE_WIDTH_PX);
	assert.equal(lineWidthAt(WIDTH_NEAR_M), LINE_WIDTH_PX);
	assert.equal(lineWidthAt(WIDTH_FAR_M), LINE_WIDTH_FAR_PX);
	assert.equal(lineWidthAt(5000), LINE_WIDTH_FAR_PX);
	assert.ok(Math.abs(lineWidthAt((WIDTH_NEAR_M + WIDTH_FAR_M) / 2) - (LINE_WIDTH_PX + LINE_WIDTH_FAR_PX) / 2) < 1e-9);
	let prev = 0;
	for (let d = 0; d <= 400; d += 10) { const w = lineWidthAt(d); assert.ok(w >= prev); prev = w; }
	assert.equal(LINE_WIDTH_PX, 3);
	assert.equal(LINE_WIDTH_FAR_PX, 5, 'readable far off, still a line');
});

t('TraceLine: the width is patched into the shader, per vertex, in screen px', () => {
	const line = new TraceLine(new THREE.Scene());
	for (const m of [line.restMat, line.flownMat, line.gateMat]) {
		assert.doesNotMatch(m.vertexShader, /offset \*= linewidth;/, 'the stock width line is replaced');
		assert.match(m.vertexShader, /smoothstep\( traceNearM, traceFarM, traceDepth \)/);
		assert.ok(m.vertexShader.includes(`max( traceW * traceTargetPx, ${MIN_TARGET_PX.toFixed(2)} )`), 'a floor in target px');
		assert.ok(m.vertexShader.includes('+ 2.0 * max( traceOutlinePx * traceTargetPx, traceOutlineMin )'), 'the outline, each side');
		assert.equal(m.uniforms.traceOutlinePx.value, 0, 'the line itself has no outline');
		assert.equal(m.uniforms.traceOutlineMin.value, 0);
		assert.ok(MIN_TARGET_PX >= 1 && MIN_TARGET_PX <= 2);
		assert.match(m.vertexShader, /^uniform float traceFarPx;/);
		assert.equal(m.uniforms.traceFarPx.value, LINE_WIDTH_FAR_PX);
		assert.equal(m.uniforms.traceNearM.value, WIDTH_NEAR_M);
		assert.equal(m.uniforms.traceFarM.value, WIDTH_FAR_M);
		assert.equal(m.uniforms.linewidth.value, LINE_WIDTH_PX);
	}
	assert.equal(line.restMat.uniforms.traceTargetPx, line.gateMat.uniforms.traceTargetPx, 'one shared uniform');
	// Target px per screen px, passed by main.js with the resolution.
	line.show(straight());
	line.setResolution(448, 280, 0.35); // a hacked sensor, resScale 0.35 of 1280×800
	assert.ok(Math.abs(line.restMat.uniforms.traceTargetPx.value - 0.35) < 1e-9);
	line.setResolution(448, 280, 2); // same size, the ratio still follows
	assert.equal(line.gateMat.uniforms.traceTargetPx.value, 2);
	line.setResolution(448, 280, NaN);
	assert.equal(line.gateMat.uniforms.traceTargetPx.value, 1, 'a bad ratio falls back to 1');
	// The draw does not overwrite the resolution with the canvas's viewport.
	line.rest.onBeforeRender({ getSize: (v) => v.set(1280, 800) });
	assert.deepEqual([line.restMat.resolution.x, line.restMat.resolution.y], [448, 280]);
	// main.js's ratio: the sensor's height over the height it is shown at —
	// viewH·uFrame.y when the window letterboxes it, not viewH.
	const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
	assert.match(main, /const shownH = \(lens\._viewH \?\? 1\) \* lens\._u\.uFrame\.value\.y;/);
	assert.match(main, /traceLine\.setResolution\(res\.x, res\.y, shownH > 0 \? res\.y \/ shownH : 1\);/);
	line.dispose();
});

t('TraceLine: the line marks itself in the target\'s alpha for the lens', () => {
	const line = new TraceLine(new THREE.Scene());
	for (const m of [line.restMat, line.flownMat, line.gateMat]) {
		assert.equal(m.blending, THREE.CustomBlending);
		assert.equal(m.blendSrc, THREE.SrcAlphaFactor, 'colour: normal blending');
		assert.equal(m.blendDst, THREE.OneMinusSrcAlphaFactor);
		assert.equal(m.blendSrcAlpha, THREE.ZeroFactor, 'alpha: dst × (1 − opacity)');
		assert.equal(m.blendDstAlpha, THREE.OneMinusSrcAlphaFactor);
	}
	assert.equal(REST_OPACITY, 1, 'what is left is opaque: a full mark');
	line.dispose();
	// And the lens reads it on the very taps that make `c` (the G tap, as a
	// vec4, no extra fetch), so a smeared or torn line carries its mark along.
	const lens = readFileSync(new URL('../src/lens.js', import.meta.url), 'utf8');
	assert.match(lens, /vec4 tg = texture2D\(tDiffuse, WRAPX\(uvG\)\);/);
	assert.match(lens, /markSum \+= 1\.0 - tg\.a;/);
	assert.match(lens, /float mark = markSum \/ float\(TAPS\);/);
	assert.doesNotMatch(lens, /texture2D\(tDiffuse, uvHere\)\.a/, 'no mark read off the colour taps');
	assert.match(lens, /mix\(ch - chLuma, c - dot\(c, LUMA\), mark\)/);
});

t('TraceLine: a dark underlay under each part, wider, drawn first, fading with it, no lens mark', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	line.show(straight());
	const pairs = [[line.restUnder, line.rest], [line.flownUnder, line.flown], [line.gateUnder, line.gate]];
	for (const [u, l] of pairs) {
		assert.equal(u.geometry, l.geometry, 'the same geometry: the split follows');
		assert.ok(u.id < l.id && u.renderOrder === l.renderOrder, 'three sorts it first (same renderOrder and position, lower id)');
		const m = u.material;
		assert.equal(`#${m.color.getHexString()}`, token('--black'));
		assert.equal(m.opacity, UNDER_OPACITY);
		assert.equal(m.uniforms.traceOutlinePx.value, OUTLINE_PX);
		assert.equal(m.uniforms.traceOutlineMin.value, OUTLINE_MIN_TARGET_PX);
		assert.equal(m.uniforms.traceTargetPx, line.restMat.uniforms.traceTargetPx, 'the shared ratio');
		assert.equal(m.blending, THREE.CustomBlending);
		assert.equal(m.blendSrc, THREE.SrcAlphaFactor);
		assert.equal(m.blendDst, THREE.OneMinusSrcAlphaFactor);
		assert.equal(m.blendSrcAlpha, THREE.ZeroFactor, 'alpha: dst × 1 — untouched, no mark');
		assert.equal(m.blendDstAlpha, THREE.OneFactor);
		assert.equal(m.depthTest, true);
		assert.equal(m.depthWrite, false);
	}
	assert.ok(UNDER_OPACITY >= 0.5 && UNDER_OPACITY <= 0.7);
	// ≈ 1 px each side in HD; a 0.35 sensor keeps a visible rim.
	assert.equal(underlayTargetPx(3, 1), 5);
	assert.equal(underlayTargetPx(5, 1), 7);
	assert.ok(Math.abs(underlayTargetPx(3, 0.35) - (MIN_TARGET_PX + 2 * OUTLINE_MIN_TARGET_PX)) < 1e-9);
	// Visibility and fade follow the part they sit under.
	assert.equal(line.flownUnder.visible, false);
	line.setProgress(0.5, 'on', 0.5);
	assert.equal(line.flownUnder.visible, true);
	assert.ok(Math.abs(line.flownUnderMat.opacity - UNDER_OPACITY / 2) < 1e-9);
	line.setProgress(1, 'done', 0);
	assert.equal(line.restUnder.visible, false);
	line.setResolution(640, 400, 0.5);
	assert.equal(line.gateUnderMat.resolution.x, 640);
	line.dispose();
	assert.equal(scene.children.length, 0);
});

t('tickArcs: every 15 m on the 60 m ahead, short of the end', () => {
	const out = new Float64Array(TICK_MAX);
	assert.equal(TICK_MAX, 4);
	assert.equal(tickArcs(0, 500, out), 4);
	assert.deepEqual([...out], [15, 30, 45, 60]);
	// From the progress: the grid is fixed on the trace, nothing slides with it.
	assert.equal(tickArcs(16, 500, out), 4);
	assert.deepEqual([...out], [30, 45, 60, 75]);
	assert.equal(tickArcs(30, 500, out), 4);
	assert.equal(out[0], 45, 'strictly ahead');
	// Near the end: fewer, never on the last metre.
	assert.equal(tickArcs(80, 100, out), 1);
	assert.equal(out[0], 90);
	assert.equal(tickArcs(0, 15.5, out), 0);
	assert.equal(tickArcs(95, 100, out), 0);
	assert.equal(TICK_SPACING_M * TICK_MAX, TICK_AHEAD_M);
});

t('pointAt / chevronAt: a V pointing along the path, facing the camera, sized on its distance', () => {
	const tr = straight(51); // 100 m along +X at y = 30
	const tmp = new Float64Array(6);
	pointAt(tr.points, tr.cum, 15, tmp);
	assert.deepEqual([...tmp], [15, 30, 0, 1, 0, 0]);
	pointAt(tr.points, tr.cum, 100, tmp);
	assert.equal(tmp[0], 100, 'the end is reachable');
	const out = new Float32Array(12);
	// Camera 50 m above: the V lies flat, arms across the path (±Z).
	chevronAt(tr.points, tr.cum, 15, { x: 15, y: 80, z: 0 }, out, 0, tmp);
	const w = 50 * TICK_ANGLE;
	const near = (a, b) => Math.abs(a - b) < 1e-4;
	// Tip ahead of the point, arms behind it on either side.
	assert.ok(near(out[3], 15 + w / 2) && near(out[6], out[3]), `tip ${out[3]}`);
	assert.ok(out[0] < out[3] && out[9] < out[3], 'the arms trail the tip: it points +X');
	assert.ok(near(Math.abs(out[2]), w) && near(out[2], -out[11]), 'symmetric across the path');
	assert.ok(near(out[1], 30) && near(out[10], 30), 'in the plane the camera sees face on');
	// Camera to the side (+Z): the arms go up and down instead.
	chevronAt(tr.points, tr.cum, 15, { x: 15, y: 30, z: 50 }, out, 0, tmp);
	assert.ok(near(Math.abs(out[1] - 30), w) && near(out[2], 0));
	// Size clamps: a camera on top of it, one far away.
	assert.ok(chevronAt(tr.points, tr.cum, 15, { x: 15, y: 37, z: 0 }, out, 0, tmp));
	assert.ok(near(Math.abs(out[2]), TICK_MIN_M));
	chevronAt(tr.points, tr.cum, 15, { x: 15, y: 5000, z: 0 }, out, 0, tmp);
	assert.ok(near(Math.abs(out[2]), TICK_MAX_M));
	// Seen end-on (down the path, or nearly) or from right on top of it: a bar,
	// not a direction — skipped, nothing written.
	out.fill(7);
	assert.equal(chevronAt(tr.points, tr.cum, 15, { x: -50, y: 30, z: 0 }, out, 0, tmp), false);
	assert.equal(chevronAt(tr.points, tr.cum, 15, { x: 80, y: 32, z: 1 }, out, 0, tmp), false);
	assert.equal(chevronAt(tr.points, tr.cum, 15, { x: 15, y: 30 + TICK_NEAR_M - 0.1, z: 0 }, out, 0, tmp), false);
	assert.ok(out.every((v) => v === 7));
	// Obliquely (≈ 60° off the path) it still draws.
	assert.ok(chevronAt(tr.points, tr.cum, 15, { x: -10, y: 30, z: 43 }, out, 0, tmp));
	assert.ok(out.every(Number.isFinite));
});

t('TraceLine: ticks from the gate while waiting, from the progress on it, gone when done; no allocation', () => {
	const scene = new THREE.Scene();
	const line = new TraceLine(scene);
	line.updateTicks({ x: 0, y: 0, z: 0 }); // no trace: nothing, no throw
	assert.equal(line.ticks.visible, false);
	line.show(straight(101)); // 200 m
	assert.equal(line.tickMat.linewidth, TICK_WIDTH_PX);
	assert.equal(`#${line.tickMat.color.getHexString()}`, token('--yellow'));
	assert.equal(line.tickUnder.geometry, line.ticks.geometry);
	assert.ok(line.tickUnder.id < line.ticks.id && line.ticks.renderOrder > line.rest.renderOrder, 'over the thread, underlay first');
	const cam = { x: 0, y: 80, z: 0 };
	const arr = line.ticks.geometry.attributes.instanceStart.data.array;
	line.updateTicks(cam);
	assert.equal(line.ticks.visible, true);
	assert.equal(line.ticks.geometry.instanceCount, 8, '4 chevrons, 2 segments each');
	assert.ok(Math.abs(arr[3] - (15 + Math.hypot(15, 50) * TICK_ANGLE / 2)) < 1e-3, `first tip ${arr[3]}`);
	line.setProgress(0.5, 'on', 0);
	const v = line.ticks.geometry.attributes.instanceStart.data.version;
	const over = { x: 100, y: 80, z: 0 };
	line.updateTicks(over);
	assert.equal(line.ticks.geometry.attributes.instanceStart.data.array, arr, 'rewritten in place');
	assert.ok(line.ticks.geometry.attributes.instanceStart.data.version > v, 'uploaded');
	assert.ok(arr[3] > 105 && arr[3] < 105 + TICK_MAX_M, `ahead of the progress: ${arr[3]}`);
	// A camera on the thread looking down it: the ticks it looks along are
	// skipped, the list stays packed.
	line.updateTicks({ x: 95, y: 30, z: 0 });
	assert.equal(line.ticks.visible, false, 'end-on: none');
	// Seen from abeam of the first, the far ones (end-on) go (135, 150 m), the list stays packed.
	line.updateTicks({ x: 105, y: 30, z: 12 });
	assert.equal(line.ticks.geometry.instanceCount, 2 * 2);
	assert.ok(arr[3] > 105 && arr[3] < 105 + TICK_MAX_M, `packed: ${arr[3]}`);
	line.setProgress(0.5, 'off', 0.3);
	line.updateTicks(cam);
	assert.ok(arr[3] < 20, 'cooling: back at the gate');
	line.setProgress(0.9, 'on', 0);
	line.updateTicks({ x: 180, y: 80, z: 0 });
	assert.equal(line.ticks.geometry.instanceCount, 2 * 1, 'one left short of the end');
	line.setProgress(1, 'done', 0);
	line.updateTicks(over);
	assert.equal(line.ticks.visible, false);
	line.hide();
	line.show(straight());
	line.setVisible(false);
	assert.equal(line.group.visible, false, 'the ticks are in the group a photo hides');
	line.dispose();
	assert.equal(scene.children.length, 0);
});

t('trace-line.js uses no colour literal and no demo token', () => {
	const src = readFileSync(new URL('../src/trace-line.js', import.meta.url), 'utf8')
		.replace(/\/\/.*$/gm, '');
	assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b|0x[0-9a-f]{6}\b/i, 'colour literal');
	assert.doesNotMatch(src, /--(cyan|magenta|violet|electric)/, 'demo token');
});

console.log(`trace-line-selftest: ${n} tests ok`);
