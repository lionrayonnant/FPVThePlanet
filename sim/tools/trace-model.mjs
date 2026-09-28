// The trace (issue #185, spec docs/superpowers/specs/2026-09-28-signals-traces-design.md):
// shape choice, shape generation from a probed profile, the follower (gate,
// progress, off-timer, reset) and photo scoring. Pure — no DOM, no THREE, no
// Rapier. Local ENU metres: X east, Y up, Z south.
//
// Profile grid convention (shared with src/trace-probe.js): ring i, angle
// index k of n sits at (anchor.x + r·cos θ, anchor.z + r·sin θ), θ = 2πk/n —
// the same convention as src/signal-anchor.js. Heights are absolute Y; a
// non-finite height reads as `profile.ground`.

export const SPACING_M = 2;
export const TOLERANCE_M = { 2: 5, 3: 3.5 };
export const WINDOW_M = 15;
export const OFF_RESET_S = 10;
export const FADE_S = 2;
export const DONE_FRAC = 0.995;
export const PHOTO_CONE_DEG = 35;
export const MAX_ATTEMPTS = 3;

// Orbit / spiral.
const OUTLINE_BAND_M = 8;     // a ring counts in the outline if it reaches top − 8 m
const RADIUS_MARGIN_M = 12;
const RADIUS_STEP_M = 8;      // per attempt
const ORBIT_ABOVE_M = 6;      // above the anchor (the anchor already sits above the top)
const ALT_STEP_M = 6;         // per attempt
const ARC = { 2: Math.PI, 3: 3 * Math.PI };
const SPIRAL_TURNS = { 2: 0.5, 3: 1.5 };
const SPIRAL_FLOOR_M = 15;    // above the ground
const SPIRAL_OVER_SURF_M = 6; // above the profile at the radius
const SPIRAL_OVER_TOP_M = 10;
// Under.
const UNDER_MIN_CLEARANCE_M = 8;
const UNDER_HALF_M = 40;
const UNDER_OVER_DECK_M = 10;
const DECK_THICKNESS_M = 3;   // when the axis carries no deck surface (topY)
const UNDER_DRIFT_M = 12;     // the return pass sits 12 m along the deck from the first
const UNDER_SHIFT_M = [0, 8, -8]; // per attempt, along the deck (a pier in the way)
// Dive.
const DIVE_ABOVE_TOP_M = 40;
const DIVE_CLEAR_M = 10;
const DIVE_CLEAR_STEP_M = 4;  // per attempt
const DIVE_START_OFFSET_M = 10; // from the summit towards the approach
const DIVE_LENGTH_M = { 2: 60, 3: 160 };

const TAU = 2 * Math.PI;

// ------------------------------------------------------------------ shapes
// Natural kinds as tools/signal-model.mjs kindOf() writes them (upper case,
// underscores to spaces). A natural thing is never a spiral, whatever its height.
const NATURAL_KINDS = new Set(['PEAK', 'VOLCANO', 'ARCH', 'CAVE ENTRANCE', 'ROCK', 'STONE', 'CLIFF', 'GEYSER', 'HOT SPRING', 'WATERFALL']);
const UNDER_KINDS = new Set(['BRIDGE', 'ARCH']);
const DIVE_KINDS = new Set(['PEAK', 'VOLCANO', 'WATERFALL', 'CLIFF', 'DAM']);
const SPIRAL_KINDS = new Set(['TOWER', 'LIGHTHOUSE']);
const SPIRAL_HEIGHT_M = 50;

export function shapeOf(signal) {
	const kind = typeof signal?.kind === 'string' ? signal.kind : '';
	if (UNDER_KINDS.has(kind)) return 'under';
	if (DIVE_KINDS.has(kind)) return 'dive';
	if (SPIRAL_KINDS.has(kind)) return 'spiral';
	if (!NATURAL_KINDS.has(kind) && Number.isFinite(signal?.heightM) && signal.heightM > SPIRAL_HEIGHT_M) return 'spiral';
	return 'orbit';
}

// FNV-1a 32 bits (the hash tools/target-build.mjs seeds with), then the
// murmur3 finaliser: ids that differ by one digit ('wd:Q1'…'wd:Q9') would
// otherwise share their high bits.
function fnv(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

export function seedOf(id) { return fnv(String(id)) / 4294967296; }
export function turnDir(id) { return (fnv(`${id}:turn`) & 1) ? 1 : -1; }

// ----------------------------------------------------------------- profile
function ringHeight(profile, ring, k0, k1, w) {
	const h = ring.heights;
	const a = Number.isFinite(h[k0]) ? h[k0] : profile.ground;
	const b = Number.isFinite(h[k1]) ? h[k1] : profile.ground;
	return a + (b - a) * w;
}

function ringAt(profile, ring, theta) {
	const n = ring.heights.length;
	if (n === 0) return profile.ground;
	let kf = (theta / TAU) * n;
	kf -= Math.floor(kf / n) * n;
	const k0 = Math.floor(kf) % n;
	return ringHeight(profile, ring, k0, (k0 + 1) % n, kf - Math.floor(kf));
}

// The probed surface at (x, z): bilinear in (ring, angle), clamped to the grid.
export function surfaceAt(profile, anchor, x, z) {
	const rings = profile.rings;
	const dx = x - anchor.x, dz = z - anchor.z;
	const r = Math.hypot(dx, dz);
	const theta = Math.atan2(dz, dx);
	if (r <= rings[0].r) return ringAt(profile, rings[0], theta);
	const last = rings.length - 1;
	if (r >= rings[last].r) return ringAt(profile, rings[last], theta);
	let i = 0;
	while (i < last - 1 && rings[i + 1].r <= r) i++;
	const w = (r - rings[i].r) / (rings[i + 1].r - rings[i].r);
	const a = ringAt(profile, rings[i], theta), b = ringAt(profile, rings[i + 1], theta);
	return a + (b - a) * w;
}

function ringMax(profile, ring) {
	let m = -Infinity;
	for (const h of ring.heights) if (Number.isFinite(h) && h > m) m = h;
	return m === -Infinity ? profile.ground : m;
}

// The structure's radius: the widest ring that still reaches within 8 m of the top.
function outlineRadius(profile) {
	let r = 0;
	for (const ring of profile.rings) if (ringMax(profile, ring) >= profile.top - OUTLINE_BAND_M && ring.r > r) r = ring.r;
	return r;
}

// Highest surface around the circle of radius R (sampled at the grid's angles).
function maxAtRadius(profile, anchor, R) {
	const n = profile.rings[profile.rings.length - 1].heights.length || 16;
	let m = -Infinity;
	for (let k = 0; k < n; k++) {
		const th = (k / n) * TAU;
		const h = surfaceAt(profile, anchor, anchor.x + R * Math.cos(th), anchor.z + R * Math.sin(th));
		if (h > m) m = h;
	}
	return m;
}

function validProfile(p) {
	return p && Array.isArray(p.rings) && p.rings.length > 0 && Number.isFinite(p.ground) && Number.isFinite(p.top)
		&& p.rings.every((ring) => Number.isFinite(ring.r) && ring.heights && ring.heights.length > 0);
}

// ------------------------------------------------------------------ builds
// Each builder returns a dense raw polyline (plain array x,y,z,…) — resampled after.

function approachAngle(anchor, approach, id) {
	if (approach && Number.isFinite(approach.x) && Number.isFinite(approach.z)) {
		const dx = approach.x - anchor.x, dz = approach.z - anchor.z;
		if (Math.hypot(dx, dz) > 1) return Math.atan2(dz, dx);
	}
	return seedOf(id) * TAU;
}

function buildRing({ anchor, R, theta0, dir, arc, y0, y1 }) {
	const raw = [];
	const steps = Math.max(8, Math.ceil((arc * R) / 1));
	for (let i = 0; i <= steps; i++) {
		const u = i / steps;
		const th = theta0 + dir * arc * u;
		raw.push(anchor.x + R * Math.cos(th), y0 + (y1 - y0) * u, anchor.z + R * Math.sin(th));
	}
	return raw;
}

function buildOrbit(ctx) {
	const { anchor, profile, tier, attempt, theta0, dir } = ctx;
	const R = outlineRadius(profile) + RADIUS_MARGIN_M + attempt * RADIUS_STEP_M;
	const y = anchor.y + ORBIT_ABOVE_M + attempt * ALT_STEP_M;
	return buildRing({ anchor, R, theta0, dir, arc: ARC[tier], y0: y, y1: y });
}

function buildSpiral(ctx) {
	const { anchor, profile, tier, attempt, theta0, dir } = ctx;
	const R = outlineRadius(profile) + RADIUS_MARGIN_M + attempt * RADIUS_STEP_M;
	const lift = attempt * ALT_STEP_M;
	const y0 = Math.max(profile.ground + SPIRAL_FLOOR_M, maxAtRadius(profile, anchor, R) + SPIRAL_OVER_SURF_M) + lift;
	const y1 = Math.max(profile.top + SPIRAL_OVER_TOP_M + lift, y0 + SPIRAL_OVER_TOP_M);
	return buildRing({ anchor, R, theta0, dir, arc: SPIRAL_TURNS[tier] * TAU, y0, y1 });
}

// A pass perpendicular to the deck, 40 m either side of the axis. Tier III adds
// a vertical half-loop out over the deck, a pass back over it, a half-loop
// down and a return pass under — drifted 12 m along the deck so the two passes
// never overlay.
function buildUnder(ctx) {
	const { anchor, profile, tier, attempt, approach } = ctx;
	const ax = profile.axis;
	const len = Math.hypot(ax.dx, ax.dz);
	const ux = ax.dx / len, uz = ax.dz / len;           // along the deck
	let px = -uz, pz = ux;                               // across it
	const cx0 = Number.isFinite(ax.cx) ? ax.cx : anchor.x;
	const cz0 = Number.isFinite(ax.cz) ? ax.cz : anchor.z;
	// Entry (at −40 m along p) on the drone's side.
	if (approach && (approach.x - cx0) * px + (approach.z - cz0) * pz > 0) { px = -px; pz = -pz; }
	const shift = UNDER_SHIFT_M[attempt] ?? 0;
	const cx = cx0 + ux * shift, cz = cz0 + uz * shift;
	const passY = ax.underY + (ax.deckY - ax.underY) / 2;
	const at = (s, q, y, out) => out.push(cx + px * s + ux * q, y, cz + pz * s + uz * q);
	const raw = [];
	const straight = (s0, s1, q, y) => {
		const steps = Math.ceil(Math.abs(s1 - s0));
		for (let i = 0; i <= steps; i++) at(s0 + (s1 - s0) * (i / steps), q, y, raw);
	};
	straight(-UNDER_HALF_M, UNDER_HALF_M, 0, passY);
	if (tier < 3) return raw;
	const overY = (Number.isFinite(ax.topY) ? ax.topY : ax.deckY + DECK_THICKNESS_M) + UNDER_OVER_DECK_M;
	const rv = (overY - passY) / 2, mid = (passY + overY) / 2;
	const loop = (sEdge, outward, q0, q1, up) => {
		const steps = Math.max(12, Math.ceil(Math.PI * rv));
		for (let i = 1; i <= steps; i++) {
			const phi = -Math.PI / 2 + Math.PI * (i / steps);
			const y = up ? mid + rv * Math.sin(phi) : mid - rv * Math.sin(phi);
			at(sEdge + outward * rv * Math.cos(phi), q0 + (q1 - q0) * (i / steps), y, raw);
		}
	};
	const half = UNDER_DRIFT_M / 2;
	loop(UNDER_HALF_M, 1, 0, half, true);
	straight(UNDER_HALF_M, -UNDER_HALF_M, half, overY);
	loop(-UNDER_HALF_M, -1, half, UNDER_DRIFT_M, false);
	straight(-UNDER_HALF_M, UNDER_HALF_M, UNDER_DRIFT_M, passY);
	return raw;
}

// Start 40 m above the top, 10 m from the summit towards the drone, then down
// the steepest face (the angle whose outer ring drops most), never closer than
// 10 m to the probed surface, ending 10 m above the lowest probed point when
// the path length (60 m / 160 m) allows it.
function buildDive(ctx) {
	const { anchor, profile, tier, attempt, theta0 } = ctx;
	const rings = profile.rings;
	const outer = rings[rings.length - 1];
	const n = outer.heights.length;
	// Summit: the highest grid point.
	let sx = anchor.x, sz = anchor.z, best = -Infinity;
	for (const ring of rings) {
		const m = ring.heights.length;
		for (let k = 0; k < m; k++) {
			const h = ring.heights[k];
			if (Number.isFinite(h) && h > best) {
				best = h;
				const th = (k / m) * TAU;
				sx = anchor.x + ring.r * Math.cos(th); sz = anchor.z + ring.r * Math.sin(th);
			}
		}
	}
	// Steepest: the lowest outer-ring point; within 1 m, the one nearest the approach.
	let kBest = 0, hBest = Infinity, angBest = Infinity;
	for (let k = 0; k < n; k++) {
		const h = Number.isFinite(outer.heights[k]) ? outer.heights[k] : profile.ground;
		const th = (k / n) * TAU;
		let d = Math.abs(th - theta0) % TAU; if (d > Math.PI) d = TAU - d;
		if (h < hBest - 1 || (Math.abs(h - hBest) <= 1 && d < angBest)) { kBest = k; hBest = Math.min(h, hBest); angBest = d; }
	}
	const thE = (kBest / n) * TAU;
	const Sx = sx + DIVE_START_OFFSET_M * Math.cos(theta0), Sz = sz + DIVE_START_OFFSET_M * Math.sin(theta0);
	const Ex = anchor.x + outer.r * Math.cos(thE), Ez = anchor.z + outer.r * Math.sin(thE);
	const H = Math.hypot(Ex - Sx, Ez - Sz);
	const clr = DIVE_CLEAR_M + attempt * DIVE_CLEAR_STEP_M;
	const yStart = profile.top + DIVE_ABOVE_TOP_M + attempt * ALT_STEP_M;
	const yEnd = profile.ground + clr;
	const L = DIVE_LENGTH_M[tier];
	const drop = yStart - yEnd;
	const D = Math.min(H, Math.max(Math.sqrt(Math.max(L * L - drop * drop, 0)), Math.min(H, 10)));
	const raw = [];
	let len = 0, px = Sx, py = yStart, pz = Sz;
	const steps = Math.max(1, Math.ceil(H));
	for (let i = 0; i <= steps; i++) {
		const h = (H * i) / steps;
		const x = Sx + (Ex - Sx) * (h / (H || 1)), z = Sz + (Ez - Sz) * (h / (H || 1));
		const lin = D > 0 ? yStart - drop * Math.min(h / D, 1) : yEnd;
		const y = i === 0 ? yStart : Math.max(surfaceAt(profile, anchor, x, z) + clr, lin);
		const seg = Math.hypot(x - px, y - py, z - pz);
		if (i > 0 && len + seg > L) {
			// Cut the last segment at exactly L.
			const f = (L - len) / seg;
			raw.push(px + (x - px) * f, py + (y - py) * f, pz + (z - pz) * f);
			break;
		}
		len += seg;
		raw.push(x, y, z);
		px = x; py = y; pz = z;
		if (h >= D && y <= yEnd + 0.5) break;
	}
	return raw;
}

// Uniform resampling at ~SPACING_M along the 3D polyline.
function resample(raw) {
	const m = raw.length / 3;
	if (m < 2) return null;
	const rawCum = new Float64Array(m);
	for (let i = 1; i < m; i++) {
		rawCum[i] = rawCum[i - 1] + Math.hypot(raw[3 * i] - raw[3 * i - 3], raw[3 * i + 1] - raw[3 * i - 2], raw[3 * i + 2] - raw[3 * i - 1]);
	}
	const total = rawCum[m - 1];
	if (!(total > SPACING_M)) return null;
	const segs = Math.max(1, Math.round(total / SPACING_M));
	const points = new Float32Array((segs + 1) * 3);
	let j = 0;
	for (let i = 0; i <= segs; i++) {
		const s = (total * i) / segs;
		while (j < m - 2 && rawCum[j + 1] < s) j++;
		const span = rawCum[j + 1] - rawCum[j];
		const f = span > 0 ? Math.min(1, Math.max(0, (s - rawCum[j]) / span)) : 0;
		for (let c = 0; c < 3; c++) points[3 * i + c] = raw[3 * j + c] + (raw[3 * j + 3 + c] - raw[3 * j + c]) * f;
	}
	const cum = new Float32Array(segs + 1);
	let acc = 0;
	for (let i = 1; i <= segs; i++) {
		acc += Math.hypot(points[3 * i] - points[3 * i - 3], points[3 * i + 1] - points[3 * i - 2], points[3 * i + 2] - points[3 * i - 1]);
		cum[i] = acc;
	}
	return { points, cum, length: cum[segs] };
}

// -> { id, shape, points, cum, length, tolerance } | null (tier I, no profile,
// a non-finite anchor). A bridge/arch without a usable axis (none, or less
// than 8 m of clearance) falls back to an orbit.
export function buildTrace({ signal, anchor, profile, tier, approach, attempt = 0 }) {
	const tol = TOLERANCE_M[tier];
	if (!tol || !signal || !anchor || !validProfile(profile)) return null;
	if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) return null;
	let shape = shapeOf(signal);
	if (shape === 'under') {
		const ax = profile.axis;
		const ok = ax && [ax.dx, ax.dz, ax.deckY, ax.underY].every(Number.isFinite) && Math.hypot(ax.dx, ax.dz) > 1e-6
			&& ax.deckY - ax.underY >= UNDER_MIN_CLEARANCE_M;
		if (!ok) shape = 'orbit';
	}
	const a = Math.max(0, Math.min(MAX_ATTEMPTS - 1, Math.floor(attempt) || 0));
	const ctx = { anchor, profile, tier, attempt: a, approach, theta0: approachAngle(anchor, approach, signal.id), dir: turnDir(signal.id) };
	const raw = shape === 'orbit' ? buildOrbit(ctx) : shape === 'spiral' ? buildSpiral(ctx)
		: shape === 'under' ? buildUnder(ctx) : buildDive(ctx);
	const r = resample(raw);
	if (!r) return null;
	return { id: signal.id, shape, points: r.points, cum: r.cum, length: r.length, tolerance: tol };
}

// ---------------------------------------------------------------- follower
// Gate at point 0, progress along the polyline inside a 15 m forward window,
// pause when off, reset (after a 2 s fade) when off for 10 s. Allocates
// nothing per update: `out` is reused.
export class TraceFollower {
	constructor({ trace, tolerance }) {
		this.trace = trace;
		this.tolerance = Number.isFinite(tolerance) ? tolerance : trace.tolerance;
		this.out = { state: 'waiting', progress01: 0, offS: 0, flownM: 0, fade01: 0, elapsedS: 0 };
		this._s = 0;
		this._seg = 0;
		this._fading = false;
	}

	reset() {
		const o = this.out;
		o.state = 'waiting'; o.progress01 = 0; o.offS = 0; o.flownM = 0; o.fade01 = 0; o.elapsedS = 0;
		this._s = 0; this._seg = 0; this._fading = false;
	}

	update({ dt, pos }) {
		const o = this.out;
		if (!(dt > 0) || o.state === 'done' || !pos) return o;
		const { points: P, cum, length } = this.trace;
		const tol = this.tolerance;
		if (o.state === 'waiting') {
			if (Math.hypot(pos.x - P[0], pos.y - P[1], pos.z - P[2]) > tol) return o;
			o.state = 'on'; o.offS = 0; o.fade01 = 0; o.elapsedS = 0;
			this._s = 0; this._seg = 0;
		} else {
			o.elapsedS += dt;
		}
		if (this._fading) {
			// Committed: the flown part cools, then the gate again.
			o.offS += dt;
			o.fade01 = Math.min(1, (o.offS - OFF_RESET_S) / FADE_S);
			if (o.fade01 >= 1) this.reset();
			return o;
		}
		// Nearest point of the polyline ahead of the progress, within the window.
		const s0 = this._s, sMax = s0 + WINDOW_M;
		const last = cum.length - 1;
		let bestD2 = Infinity, bestS = s0;
		for (let j = this._seg; j < last && cum[j] <= sMax; j++) {
			const i = 3 * j;
			const ax = P[i], ay = P[i + 1], az = P[i + 2];
			const ex = P[i + 3] - ax, ey = P[i + 4] - ay, ez = P[i + 5] - az;
			const segLen = cum[j + 1] - cum[j];
			const l2 = ex * ex + ey * ey + ez * ez;
			let t = l2 > 0 ? ((pos.x - ax) * ex + (pos.y - ay) * ey + (pos.z - az) * ez) / l2 : 0;
			const tMin = segLen > 0 ? Math.max(0, (s0 - cum[j]) / segLen) : 0;
			const tMax = segLen > 0 ? Math.min(1, (sMax - cum[j]) / segLen) : 1;
			t = Math.min(tMax, Math.max(tMin, t));
			const dx = ax + ex * t - pos.x, dy = ay + ey * t - pos.y, dz = az + ez * t - pos.z;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 < bestD2) { bestD2 = d2; bestS = cum[j] + segLen * t; }
		}
		if (bestD2 <= tol * tol) {
			o.state = 'on'; o.offS = 0;
			if (bestS > this._s) {
				this._s = bestS;
				while (this._seg < last - 1 && cum[this._seg + 1] <= this._s) this._seg++;
			}
		} else {
			o.state = 'off';
			o.offS += dt;
			if (o.offS >= OFF_RESET_S) { this._fading = true; o.fade01 = Math.min(1, (o.offS - OFF_RESET_S) / FADE_S); }
		}
		o.flownM = this._s;
		o.progress01 = length > 0 ? Math.min(1, this._s / length) : 0;
		if (o.progress01 >= DONE_FRAC) { o.state = 'done'; o.progress01 = 1; o.flownM = length; o.offS = 0; }
		return o;
	}
}

// ------------------------------------------------------------------ photo
// Score of a view of the landmark: 1 dead centre, 0 at the cone's edge, null
// outside the 35° cone or without line of sight.
export function photoScore({ angleDeg, los }) {
	if (!los || !Number.isFinite(angleDeg) || angleDeg < 0 || angleDeg > PHOTO_CONE_DEG) return null;
	return 1 - angleDeg / PHOTO_CONE_DEG;
}
