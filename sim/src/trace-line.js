// The trace in the world (issue #185, look A — a hairline): one thin line,
// yellow for what is left to fly, green for what is flown, plus a small square
// entry gate at point 0 (yellow, green once entered). Depth-tested, so a
// building in front hides it; drawn into the scene, so it goes through the
// lens like everything else. Fog-free, no glow.
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

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { token } from './palette.js';

// CHOSEN (mockup look A): a hairline, the width of the scanner's rules.
export const LINE_WIDTH_PX = 2;
export const GATE_SIDE_M = 3;
// The mockup's opacities: what is left reads clearly, what is flown steps back.
export const REST_OPACITY = 0.9;
export const FLOWN_OPACITY = 0.5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

function lineMaterial(color, opacity) {
	return new LineMaterial({
		color,
		linewidth: LINE_WIDTH_PX,
		worldUnits: false,
		transparent: true,
		opacity,
		depthTest: true,
		depthWrite: false,
		fog: false,
		// The lens's composer target is MSAA already; blending + MSAA edges are
		// enough for 2 px, alphaToCoverage would add nothing.
		alphaToCoverage: false,
	});
}

const noop = () => {};

export class TraceLine {
	constructor(scene) {
		this.scene = scene;
		// With ColorManagement off (main.js), a token's hex lands raw, as the
		// pass-through pipeline wants.
		this._yellow = new THREE.Color(token('--yellow'));
		this._green = new THREE.Color(token('--green'));

		this.restMat = lineMaterial(this._yellow, REST_OPACITY);
		this.flownMat = lineMaterial(this._green, FLOWN_OPACITY);
		this.gateMat = lineMaterial(this._yellow, REST_OPACITY);

		this.group = new THREE.Group();
		this.group.name = 'trace-line';
		this.group.visible = false;
		scene.add(this.group);

		this.rest = null;
		this.flown = null;
		this.gate = null;
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

		this.flown = new Line2(flownGeom, this.flownMat);
		this.rest = new Line2(restGeom, this.restMat);
		this.gate = new Line2(gateGeom, this.gateMat);
		for (const l of [this.flown, this.rest, this.gate]) {
			// LineSegments2.onBeforeRender writes the renderer's viewport (the
			// canvas, CSS px) into `resolution` at every draw — wrong here: the
			// scene is drawn into the lens composer's target (the sensor's
			// pixels). setResolution() is the only writer.
			l.onBeforeRender = noop;
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
		this.rest.geometry.instanceCount = this._segments - k;
		this.rest.visible = this._segments - k > 0;
		this.gateMat.color.copy(state === 'waiting' ? this._yellow : this._green);
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
	setResolution(w, h) {
		if (w === this._resW && h === this._resH) return;
		this._resW = w; this._resH = h;
		for (const m of [this.restMat, this.flownMat, this.gateMat]) m.resolution.set(w, h);
	}

	dispose() {
		this._clear();
		this.scene.remove(this.group);
		this.restMat.dispose();
		this.flownMat.dispose();
		this.gateMat.dispose();
	}

	_apply() {
		this.group.visible = this._shown && this._visible;
	}

	_clear() {
		for (const l of [this.flown, this.rest, this.gate]) {
			if (!l) continue;
			this.group.remove(l);
			l.geometry.dispose();
		}
		this.flown = this.rest = this.gate = null;
		this._trace = null;
		this._segments = 0;
	}
}
