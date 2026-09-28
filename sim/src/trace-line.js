// The trace in the world (issue #185, look A — a thin line): yellow for what
// is left to fly, green for what is flown, plus a small square entry gate at
// point 0 (yellow, green once entered). Depth-tested, so a building in front
// hides it; drawn into the scene, so it goes through the lens like everything
// else. Fog-free, no glow.
//
// Readability through the lens:
//   - width in screen (CSS) px, 3 px near → 5 px far (lineWidthAt(), the same
//     curve in the vertex shader, per vertex on its view depth), never under
//     MIN_TARGET_PX of the target: a hacked low-res sensor keeps a thin line
//     instead of a tube, a HiDPI screen does not halve it;
//   - a dark underlay (--black at UNDER_OPACITY), OUTLINE_PX wider each side
//     (never under OUTLINE_MIN_TARGET_PX of the target), drawn first: the
//     line keeps its contrast on a bright sky and a busy city. It leaves the
//     target's alpha alone, so it carries no lens mark (below);
//   - the line clears the target's alpha by its own opacity (CustomBlending),
//     and the lens's analog composite keeps the chroma of marked pixels. Without
//     it the link's ~25 px chroma average left a 2 px line only its luma: the
//     yellow read cream, the green grey (src/lens.js, LINK_MODE 1).
//
// Two Line2 objects rather than one with per-vertex colours: LineMaterial has
// no per-vertex alpha, and the flown part must fade out (fade01) on its own.
// Each part gets its own material (colour + opacity), and the split costs no
// upload per frame: both geometries hold the WHOLE trace, uploaded once in
// show(), and only `instanceCount` changes —
//   - flown: points in order, instanceCount = k draws segments 0..k-1;
//   - rest:  points REVERSED, instanceCount = n-1-k draws the original
//            segments k..n-2 (the tail of a reversed list is its head).
// The split sits on a vertex (≈ 2 m spacing), which is finer than the
// tolerance (≥ 3.5 m).
//
// Direction ticks: small chevrons in the line's yellow, every TICK_SPACING_M
// of the trace, only on the TICK_AHEAD_M ahead of the gate (waiting, cooling)
// or of the progress — the way the thread runs, where it matters. One
// LineSegments2 (+ its underlay) made once for the TraceLine's life: 4
// chevrons, 8 segments, rewritten in place each frame (updateTicks), each
// turned to face the camera and sized on its distance so it stays a few px
// wide. No allocation per frame.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { token } from './palette.js';

// Screen px; the depths are view depth in metres. 2 → 3 px (look A's
// hairline) was tiring to follow in play: too thin to read at a glance.
export const LINE_WIDTH_PX = 3;
export const LINE_WIDTH_FAR_PX = 5;
export const WIDTH_NEAR_M = 80;
export const WIDTH_FAR_M = 300;
// Floor in target px: 1 px of a hacked 0.35 sensor stair-stepped and went
// faint over trees; 1.5 still reads as a thin line (~4 screen px).
export const MIN_TARGET_PX = 1.5;
// The dark underlay: this much wider each side, in screen px, and never under
// OUTLINE_MIN_TARGET_PX target px (1 screen px of a 0.35 sensor is a third of
// a pixel: it would vanish).
export const OUTLINE_PX = 1;
export const OUTLINE_MIN_TARGET_PX = 0.75;
export const UNDER_OPACITY = 0.6;
export const GATE_SIDE_M = 3;
// What is left is opaque; what is flown steps back.
export const REST_OPACITY = 1;
export const FLOWN_OPACITY = 0.85; // 0.5 read faint through the lens

// Direction ticks.
export const TICK_SPACING_M = 15;
export const TICK_AHEAD_M = 60;
export const TICK_MAX = Math.floor(TICK_AHEAD_M / TICK_SPACING_M);
// Half-width of a chevron: its distance × TICK_ANGLE (≈ 8 px at 1280×800
// through the FPV lens; 0.009 read as a 4 px nick on the line), within
// [TICK_MIN_M, TICK_MAX_M]; its depth along the path is TICK_DEPTH × that.
export const TICK_ANGLE = 0.022;
export const TICK_MIN_M = 0.3;
export const TICK_MAX_M = 4;
export const TICK_DEPTH = 1;
// A chevron seen along the path (|cos| of tangent and view past this) or this
// close is a bar across the line, not a direction: it is skipped.
export const TICK_EDGE_COS = 0.9;
export const TICK_NEAR_M = 6;
// Hairline: thinner than the thread.
export const TICK_WIDTH_PX = 2;
export const TICK_WIDTH_FAR_PX = 3;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The arcs (metres along the trace) of the ticks ahead of s0: multiples of
// TICK_SPACING_M in (s0, s0 + TICK_AHEAD_M], short of the end. -> count,
// written into `out`.
export function tickArcs(s0, length, out) {
	let n = 0;
	const lim = Math.min(s0 + TICK_AHEAD_M, length - 1);
	for (let s = (Math.floor(s0 / TICK_SPACING_M) + 1) * TICK_SPACING_M; s <= lim + 1e-9 && n < out.length; s += TICK_SPACING_M) out[n++] = s;
	return n;
}

// The point and the unit tangent at arc s, into out[0..5]. Binary search.
export function pointAt(points, cum, s, out) {
	const last = cum.length - 1;
	let lo = 0, hi = last - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (cum[mid] <= s) lo = mid; else hi = mid - 1;
	}
	const i = 3 * lo, seg = cum[lo + 1] - cum[lo];
	const u = seg > 0 ? clamp01((s - cum[lo]) / seg) : 0;
	let tx = points[i + 3] - points[i], ty = points[i + 4] - points[i + 1], tz = points[i + 5] - points[i + 2];
	const l = Math.hypot(tx, ty, tz) || 1;
	tx /= l; ty /= l; tz /= l;
	out[0] = points[i] + (points[i + 3] - points[i]) * u;
	out[1] = points[i + 1] + (points[i + 4] - points[i + 1]) * u;
	out[2] = points[i + 2] + (points[i + 5] - points[i + 2]) * u;
	out[3] = tx; out[4] = ty; out[5] = tz;
	return out;
}

// A chevron at arc s pointing along the trace: two segments (12 floats at
// out[o]) from the arms' ends to the tip, in the plane of the tangent and the
// side seen from `cam` ({x, y, z}). tmp: a 6-float scratch. -> false (nothing
// written) when seen end-on or from closer than TICK_NEAR_M.
export function chevronAt(points, cum, s, cam, out, o, tmp) {
	pointAt(points, cum, s, tmp);
	const px = tmp[0], py = tmp[1], pz = tmp[2], tx = tmp[3], ty = tmp[4], tz = tmp[5];
	const vx = cam.x - px, vy = cam.y - py, vz = cam.z - pz;
	const d = Math.hypot(vx, vy, vz);
	if (d < TICK_NEAR_M || Math.abs(tx * vx + ty * vy + tz * vz) > TICK_EDGE_COS * d) return false;
	const w = Math.min(TICK_MAX_M, Math.max(TICK_MIN_M, d * TICK_ANGLE));
	const h = w * TICK_DEPTH / 2;
	// side = t × view: across the path as the camera sees it.
	let ux = ty * vz - tz * vy, uy = tz * vx - tx * vz, uz = tx * vy - ty * vx;
	let l = Math.hypot(ux, uy, uz);
	if (l < 1e-6 * (d || 1)) { ux = -tz; uy = 0; uz = tx; l = Math.hypot(ux, uz); if (l < 1e-6) { ux = 1; uz = 0; l = 1; } }
	ux /= l; uy /= l; uz /= l;
	const ax = px - tx * h, ay = py - ty * h, az = pz - tz * h;   // the arms' base
	const bx = px + tx * h, by = py + ty * h, bz = pz + tz * h;   // the tip
	out[o] = ax + ux * w; out[o + 1] = ay + uy * w; out[o + 2] = az + uz * w;
	out[o + 3] = bx; out[o + 4] = by; out[o + 5] = bz;
	out[o + 6] = bx; out[o + 7] = by; out[o + 8] = bz;
	out[o + 9] = ax - ux * w; out[o + 10] = ay - uy * w; out[o + 11] = az - uz * w;
	return true;
}

// The line's width in screen px at a view depth: GLSL smoothstep, mirrored in
// WIDTH_GLSL below.
export function lineWidthAt(depthM) {
	const t = clamp01((depthM - WIDTH_NEAR_M) / (WIDTH_FAR_M - WIDTH_NEAR_M));
	return LINE_WIDTH_PX + (LINE_WIDTH_FAR_PX - LINE_WIDTH_PX) * t * t * (3 - 2 * t);
}

// Replaces LineMaterial's `offset *= linewidth;` (screen-px branch). `start` /
// `end` are the segment's view-space ends; traceTargetPx is target px per
// screen px (a hacked sensor: < 1).
const WIDTH_ANCHOR = 'offset *= linewidth;';
const WIDTH_GLSL = `
				float traceDepth = ( position.y < 0.5 ) ? - start.z : - end.z;
				float traceW = linewidth + ( traceFarPx - linewidth )
					* smoothstep( traceNearM, traceFarM, traceDepth );
				offset *= max( traceW * traceTargetPx, ${MIN_TARGET_PX.toFixed(2)} )
					+ 2.0 * max( traceOutlinePx * traceTargetPx, traceOutlineMin );`;
const WIDTH_UNIFORMS = 'uniform float traceFarPx;\nuniform float traceNearM;\nuniform float traceFarM;\nuniform float traceTargetPx;\n'
	+ 'uniform float traceOutlinePx;\nuniform float traceOutlineMin;\n';

// Number of fully flown segments: segment i (point i → i+1) is flown when
// cum[i+1] ≤ progress·length. Binary search, no allocation.
export function flownSegments(cum, length, progress01) {
	const n = cum.length;
	if (n < 2) return 0;
	const s = clamp01(progress01) * length;
	// Largest index j with cum[j] ≤ s; flown segments = j.
	let lo = 0, hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (cum[mid] <= s + 1e-6) lo = mid; else hi = mid - 1;
	}
	return lo;
}

// The flown part cools to nothing over the follower's fade.
export function flownOpacity(fade01) {
	return FLOWN_OPACITY * (1 - clamp01(fade01));
}

// The underlay under the width in screen px `w` (target px per screen px
// `targetPx`): the line's own width plus the outline, both in target px.
export function underlayTargetPx(w, targetPx) {
	return Math.max(w * targetPx, MIN_TARGET_PX) + 2 * Math.max(OUTLINE_PX * targetPx, OUTLINE_MIN_TARGET_PX);
}

// A closed square (5 points, 15 floats) centred on point 0, in the plane
// perpendicular to the path's first segment: one side horizontal, the other
// "up" relative to the path. A vertical first segment falls back to east.
export function gateCorners(points, side = GATE_SIDE_M, out = new Float32Array(15)) {
	const x0 = points[0], y0 = points[1], z0 = points[2];
	let dx = points[3] - x0, dy = points[4] - y0, dz = points[5] - z0;
	let l = Math.hypot(dx, dy, dz) || 1;
	dx /= l; dy /= l; dz /= l;
	// u = d × up (up = +Y) → (-dz, 0, dx), horizontal.
	let ux = -dz, uy = 0, uz = dx;
	l = Math.hypot(ux, uz);
	if (l < 1e-6) { ux = 1; uz = 0; l = 1; }
	ux /= l; uz /= l;
	// v = u × d, unit since u ⟂ d.
	const vx = uy * dz - uz * dy, vy = uz * dx - ux * dz, vz = ux * dy - uy * dx;
	const h = side / 2;
	const sgn = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
	for (let i = 0; i < 5; i++) {
		const a = sgn[i][0] * h, b = sgn[i][1] * h;
		out[i * 3] = x0 + a * ux + b * vx;
		out[i * 3 + 1] = y0 + a * uy + b * vy;
		out[i * 3 + 2] = z0 + a * uz + b * vz;
	}
	return out;
}

// under: the dark underlay — wider, and its alpha factors leave the target's
// alpha as it is (no lens mark: its own chroma is not the line's).
function lineMaterial(color, opacity, targetPx, under = false, widthPx = LINE_WIDTH_PX, farPx = LINE_WIDTH_FAR_PX) {
	const m = new LineMaterial({
		color,
		linewidth: widthPx,
		worldUnits: false,
		transparent: true,
		opacity,
		depthTest: true,
		depthWrite: false,
		fog: false,
		// The lens's composer target is MSAA already; blending + MSAA edges are
		// enough for a few px, alphaToCoverage would add nothing.
		alphaToCoverage: false,
		// Colour: normal blending. Alpha: dst × (1 − opacity) — the lens's mark.
		blending: THREE.CustomBlending,
		blendEquation: THREE.AddEquation,
		blendSrc: THREE.SrcAlphaFactor,
		blendDst: THREE.OneMinusSrcAlphaFactor,
		blendSrcAlpha: THREE.ZeroFactor,
		blendDstAlpha: under ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
	});
	if (!m.vertexShader.includes(WIDTH_ANCHOR)) throw new Error('trace-line: LineMaterial shader changed, width patch anchor not found');
	m.vertexShader = WIDTH_UNIFORMS + m.vertexShader.replace(WIDTH_ANCHOR, WIDTH_GLSL);
	Object.assign(m.uniforms, {
		traceFarPx: { value: farPx },
		traceNearM: { value: WIDTH_NEAR_M },
		traceFarM: { value: WIDTH_FAR_M },
		traceTargetPx: targetPx, // shared by all the materials
		traceOutlinePx: { value: under ? OUTLINE_PX : 0 },
		traceOutlineMin: { value: under ? OUTLINE_MIN_TARGET_PX : 0 },
	});
	return m;
}

// LineSegments2.onBeforeRender writes the renderer's viewport (the canvas)
// into `resolution` at every draw — wrong here: the scene is drawn into the
// lens composer's target (the sensor's pixels), and setResolution() is the
// only writer.
const keepResolution = () => {};

export class TraceLine {
	constructor(scene) {
		this.scene = scene;
		// With ColorManagement off (main.js), a token's hex lands raw, as the
		// pass-through pipeline wants.
		this._yellow = new THREE.Color(token('--yellow'));
		this._green = new THREE.Color(token('--green'));

		this._targetPx = { value: 1 };
		this.restMat = lineMaterial(this._yellow, REST_OPACITY, this._targetPx);
		this.flownMat = lineMaterial(this._green, FLOWN_OPACITY, this._targetPx);
		this.gateMat = lineMaterial(this._yellow, REST_OPACITY, this._targetPx);
		const black = new THREE.Color(token('--black'));
		this.restUnderMat = lineMaterial(black, UNDER_OPACITY, this._targetPx, true);
		this.flownUnderMat = lineMaterial(black, UNDER_OPACITY, this._targetPx, true);
		this.gateUnderMat = lineMaterial(black, UNDER_OPACITY, this._targetPx, true);
		this.tickMat = lineMaterial(this._yellow, REST_OPACITY, this._targetPx, false, TICK_WIDTH_PX, TICK_WIDTH_FAR_PX);
		this.tickUnderMat = lineMaterial(black, UNDER_OPACITY, this._targetPx, true, TICK_WIDTH_PX, TICK_WIDTH_FAR_PX);
		this._mats = [this.restMat, this.flownMat, this.gateMat, this.restUnderMat, this.flownUnderMat, this.gateUnderMat,
			this.tickMat, this.tickUnderMat];
		this.group = new THREE.Group();
		this.group.name = 'trace-line';
		this.group.visible = false;
		scene.add(this.group);

		// The ticks: made once, rewritten in place. Drawn after the thread
		// (renderOrder 1), their underlay first (lower id); never culled (the
		// positions move under a fixed bounding sphere).
		this._tickPos = new Float32Array(TICK_MAX * 12);
		this._tickArcs = new Float64Array(TICK_MAX);
		this._tickTmp = new Float64Array(6);
		this._tickS0 = 0;
		this._tickDone = false;
		const tickGeom = new LineSegmentsGeometry();
		tickGeom.setPositions(this._tickPos);
		this.tickUnder = new LineSegments2(tickGeom, this.tickUnderMat);
		this.ticks = new LineSegments2(tickGeom, this.tickMat);
		for (const l of [this.tickUnder, this.ticks]) {
			l.onBeforeRender = keepResolution;
			l.frustumCulled = false;
			l.renderOrder = 1;
			l.visible = false;
			this.group.add(l);
		}

		this.rest = null;
		this.flown = null;
		this.gate = null;
		this.restUnder = null;
		this.flownUnder = null;
		this.gateUnder = null;
		this._trace = null;
		this._segments = 0;
		this._shown = false;
		this._visible = true;
		this._resW = 1;
		this._resH = 1;
	}

	get trace() { return this._trace; }

	show(trace) {
		this._clear();
		const pts = trace?.points;
		const n = pts ? Math.floor(pts.length / 3) : 0;
		if (n < 2) { this.hide(); return; }

		const reversed = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const j = (n - 1 - i) * 3;
			reversed[i * 3] = pts[j];
			reversed[i * 3 + 1] = pts[j + 1];
			reversed[i * 3 + 2] = pts[j + 2];
		}
		const flownGeom = new LineGeometry();
		flownGeom.setPositions(pts);
		const restGeom = new LineGeometry();
		restGeom.setPositions(reversed);
		const gateGeom = new LineGeometry();
		gateGeom.setPositions(gateCorners(pts));

		// The underlays share their line's geometry (instanceCount included) and
		// are added first: same renderOrder, same position, so three draws them
		// first (its transparent sort falls back on the object id).
		this.flownUnder = new Line2(flownGeom, this.flownUnderMat);
		this.restUnder = new Line2(restGeom, this.restUnderMat);
		this.gateUnder = new Line2(gateGeom, this.gateUnderMat);
		this.flown = new Line2(flownGeom, this.flownMat);
		this.rest = new Line2(restGeom, this.restMat);
		this.gate = new Line2(gateGeom, this.gateMat);
		for (const l of [this.flownUnder, this.restUnder, this.gateUnder, this.flown, this.rest, this.gate]) {
			l.onBeforeRender = keepResolution;
			this.group.add(l);
		}

		this._trace = trace;
		this._segments = n - 1;
		this._shown = true;
		this.setProgress(0, 'waiting', 0);
		this._apply();
	}

	// Called every frame by the follower's owner: no allocation.
	setProgress(progress01, state, fade01 = 0) {
		if (!this._trace) return;
		const k = flownSegments(this._trace.cum, this._trace.length, progress01);
		const op = flownOpacity(fade01);
		this.flown.geometry.instanceCount = k;
		this.flown.visible = k > 0 && op > 0;
		this.flownMat.opacity = op;
		this.flownUnder.visible = this.flown.visible;
		this.flownUnderMat.opacity = UNDER_OPACITY * op / FLOWN_OPACITY;
		this.rest.geometry.instanceCount = this._segments - k;
		this.rest.visible = this._segments - k > 0;
		this.restUnder.visible = this.rest.visible;
		this.gateMat.color.copy(state === 'waiting' ? this._yellow : this._green);
		// The ticks run from the gate until it is entered, and again once the
		// reset is committed; else from the progress.
		this._tickS0 = state === 'waiting' || fade01 > 0 ? 0 : clamp01(progress01) * this._trace.length;
		this._tickDone = state === 'done';
	}

	// Each frame, after the camera is placed: the ticks ahead, facing it.
	updateTicks(cam) {
		const tr = this._trace;
		const k = tr && !this._tickDone && cam ? tickArcs(this._tickS0, tr.length, this._tickArcs) : 0;
		let n = 0;
		for (let i = 0; i < k; i++) if (chevronAt(tr.points, tr.cum, this._tickArcs[i], cam, this._tickPos, n * 12, this._tickTmp)) n++;
		const g = this.ticks.geometry;
		g.instanceCount = n * 2;
		if (n > 0) g.attributes.instanceStart.data.needsUpdate = true;
		this.ticks.visible = this.tickUnder.visible = n > 0;
	}

	hide() {
		this._shown = false;
		this._apply();
	}

	// Around lens.capture(): the photo never shows the trace.
	setVisible(v) {
		this._visible = !!v;
		this._apply();
	}

	// Pixel size of the target the scene is rendered into (the lens composer's
	// drawing buffer); LineMaterial turns its width in px into clip space with it.
	// Mandatory: the Line2 objects do not take the canvas size (see show()).
	// targetPx: target px per screen (CSS) px, the widths being screen px — the
	// sensor's height over the height it is shown at (letterbox included).
	setResolution(w, h, targetPx = 1) {
		this._targetPx.value = targetPx > 0 && Number.isFinite(targetPx) ? targetPx : 1;
		if (w === this._resW && h === this._resH) return;
		this._resW = w; this._resH = h;
		for (const m of this._mats) m.resolution.set(w, h);
	}

	dispose() {
		this._clear();
		this.ticks.geometry.dispose();
		this.scene.remove(this.group);
		for (const m of this._mats) m.dispose();
	}

	_apply() {
		this.group.visible = this._shown && this._visible;
	}

	_clear() {
		for (const l of [this.flownUnder, this.restUnder, this.gateUnder]) if (l) this.group.remove(l);
		for (const l of [this.flown, this.rest, this.gate]) {
			if (!l) continue;
			this.group.remove(l);
			l.geometry.dispose(); // shared with its underlay
		}
		this.flown = this.rest = this.gate = null;
		this.flownUnder = this.restUnder = this.gateUnder = null;
		this._trace = null;
		this._segments = 0;
		if (this.ticks) this.ticks.visible = this.tickUnder.visible = false;
	}
}
