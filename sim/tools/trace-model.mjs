// The trace (issue #185, spec docs/superpowers/specs/2026-09-28-signals-traces-design.md):
// shape choice, shape generation from a probed profile, the follower (gate,
// progress, off-timer, reset) and photo scoring. Pure — no DOM, no THREE, no
// Rapier. Local ENU metres: X east, Y up, Z south.
//
// Profile grid convention (shared with src/trace-probe.js): ring i, angle
// index k of n sits at (anchor.x + r·cos θ, anchor.z + r·sin θ), θ = 2πk/n —
// the same convention as src/signal-anchor.js. Heights are absolute Y; a
// non-finite height reads as `profile.ground`.
import { ABOVE_M as ANCHOR_ABOVE_M, RING_M as ANCHOR_RING_M } from '../src/signal-anchor.js';
import { UNDER_MIN_CLEARANCE_M } from '../src/trace-probe.js';

export const SPACING_M = 2;
// Wide on purpose: the thread is a line to follow, not a needle to thread
// (5 m / 3.5 m, the first values, were too hard to hold in play). Tier I, the
// most common places, gets the lightest form and the widest tube.
export const TOLERANCE_M = { 1: 15, 2: 12, 3: 9 };
// Vertical gap between two turns of a spiral: a readability floor, not the
// tolerance (the forward search window already stops a jump between turns).
export const TURN_GAP_M = 8;
export const WINDOW_M = 25;
export const OFF_RESET_S = 10;
export const FADE_S = 2;
export const DONE_FRAC = 0.995;
export const PHOTO_CONE_DEG = 35;
export const PHOTO_HIT_SLACK_M = 6; // a line-of-sight hit this close to the landmark still sees it
export const MAX_ATTEMPTS = 3;

// Orbit / spiral.
const OUTLINE_BAND_M = 8;     // a ring is the landmark's if it reaches within 8 m of its top (and not 8 m over)
const RADIUS_MARGIN_M = 12;
const RADIUS_STEP_M = 8;      // per attempt
const ORBIT_ABOVE_M = 6;      // above the anchor (the anchor already sits above the top)
const ORBIT_OVER_SURF_M = 6;  // above the profile at the radius
const ALT_STEP_M = 6;         // per attempt
// An orbit is a ring to fly and read, not the outline of a 300 m bridge: never
// wider than this, whatever the landmark (it may then cross a deck or a quay).
export const ORBIT_MAX_R_M = 50;
const ORBIT_CLEAR_PAD_M = 10; // its altitude clears everything probed within R + 10 m
const ARC = { 1: Math.PI, 2: Math.PI, 3: 3 * Math.PI };
// Tier III orbit: a helix, so its 1.5 turns never overlay. 8 m per turn keeps
// two passes over each other more than 2 × 3.5 m apart.
const ORBIT_RISE_PER_TURN_M = 8;
const SPIRAL_TURNS = { 1: 0.5, 2: 0.5, 3: 1.5 }; // at least; more when the climb needs them
const SPIRAL_TIER3_FACTOR = 1.5;  // tier III turns = 1.5 × tier II's
const SPIRAL_FLOOR_M = 15;    // above the ground
const SPIRAL_OVER_SURF_M = 6; // above the profile under every point
const SPIRAL_OVER_TOP_M = 10;
const SPIRAL_MAX_R_M = 80;
const SPIRAL_CLIMB_MAX = Math.tan(Math.PI / 6); // 30°
const SPIRAL_SMOOTH_M = 15;   // radius steps spread over 15 m of height
const HEIGHT_SLACK_M = 4;     // a ring wraps height y when it reaches y − 4 m
// Under.
const UNDER_HALF_M = 40;
const UNDER_OVER_DECK_M = 10;
const UNDER_OVER_CLEAR_M = 6; // over anything the pass back over the deck crosses
const DECK_THICKNESS_M = 3;   // when the axis carries no deck surface (topY)
const UNDER_DRIFT_M = 12;     // the return pass sits 12 m along the deck from the first
const UNDER_SHIFT_M = [0, 8, -8]; // per attempt, along the deck (a pier in the way)
// Dive.
const DIVE_ABOVE_TOP_M = 40;
const DIVE_CLEAR_M = 10;
const DIVE_CLEAR_STEP_M = 4;  // per attempt
const DIVE_START_OFFSET_M = 10; // from the summit towards the approach
const DIVE_LENGTH_M = { 1: 40, 2: 60, 3: 160 }; // at least
const DIVE_MAX_LENGTH_M = 250;

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

// The landmark's own top: the anchor sits ABOVE_M over the highest hit near
// its OSM point (src/signal-anchor.js). The grid-wide `top` may be a hillside
// or a taller neighbour.
function landmarkTop(anchor) { return anchor.y - ANCHOR_ABOVE_M; }

// The landmark's radius: rings scanned outward while they reach its band —
// [top − 8 m, top + 8 m], and above half its height over the ground (a low
// landmark) — stopping at the first that does not (a separate hill or a
// taller neighbour further out is not the landmark). Rings inside the
// anchor's own probe ring never stop the scan (an OSM point in a courtyard).
function outlineRadius(profile, anchor) {
	const lt = landmarkTop(anchor);
	const lo = Math.max(lt - OUTLINE_BAND_M, profile.ground + (lt - profile.ground) / 2);
	const hi = lt + OUTLINE_BAND_M;
	let r = 0;
	for (const ring of profile.rings) {
		let reaches = false;
		for (const h0 of ring.heights) {
			const h = Number.isFinite(h0) ? h0 : profile.ground;
			if (h >= lo && h <= hi) { reaches = true; break; }
		}
		if (reaches) r = Math.max(r, ring.r);
		else if (ring.r >= ANCHOR_RING_M) break;
	}
	return r;
}

// The landmark's radius at height y: rings scanned outward while one of their
// heights lies in [y − 4 m, top + 8 m] (a taller neighbour is not the
// landmark), stopping at the first that does not once past the anchor's probe
// ring — outlineRadius' contiguity rule. Past the anchor's ring, between a
// ring that reaches and the next that does not, the edge is where their
// highest points cross y − 4 m: a base spreading between two rings is still
// the landmark (inside it, a wall between two rings is not assumed a slope).
function radiusAtHeight(profile, anchor, y) {
	const lo = y - HEIGHT_SLACK_M;
	const hi = landmarkTop(anchor) + OUTLINE_BAND_M;
	let r = 0, last = null, lastMax = 0, prev = null;
	for (const ring of profile.rings) {
		const before = prev; prev = ring;
		let reaches = false, m = -Infinity;
		for (const h0 of ring.heights) {
			const h = Number.isFinite(h0) ? h0 : profile.ground;
			if (h >= lo && h <= hi) { reaches = true; m = Math.max(m, h); }
		}
		if (reaches) { r = Math.max(r, ring.r); last = ring; lastMax = m; continue; }
		if (ring.r < ANCHOR_RING_M) continue;
		const out = ringMax(profile, ring);
		if (last && last === before && last.r >= ANCHOR_RING_M && out < lo && lastMax > out) r = Math.max(r, last.r + (ring.r - last.r) * (lastMax - lo) / (lastMax - out));
		break;
	}
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

// Highest probed surface within radius R: every ring inside it, and the
// circle at R itself (interpolated between the rings that straddle it).
function maxWithin(profile, anchor, R) {
	let m = maxAtRadius(profile, anchor, R);
	for (const ring of profile.rings) if (ring.r <= R) m = Math.max(m, ringMax(profile, ring));
	return m;
}

function validProfile(p) {
	// A partial profile read unstreamed geometry as ground: no trace from it.
	return p && !p.partial && Array.isArray(p.rings) && p.rings.length > 0 && Number.isFinite(p.ground) && Number.isFinite(p.top)
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
	// Capped at ORBIT_MAX_R_M (and the probed grid). Once capped, the
	// attempt's radius step is a no-op: retries then differ by altitude
	// (ALT_STEP_M) alone.
	const edge = profile.rings[profile.rings.length - 1].r;
	const R = Math.min(outlineRadius(profile, anchor) + RADIUS_MARGIN_M + attempt * RADIUS_STEP_M, ORBIT_MAX_R_M, edge);
	const y = Math.max(anchor.y + ORBIT_ABOVE_M, maxWithin(profile, anchor, R + ORBIT_CLEAR_PAD_M) + ORBIT_OVER_SURF_M) + attempt * ALT_STEP_M;
	// Tiers I/II (half a turn) stay level; tier III climbs so its turns never overlay.
	const rise = tier >= 3 ? ORBIT_RISE_PER_TURN_M * ARC[tier] / TAU : 0;
	return buildRing({ anchor, R, theta0, dir, arc: ARC[tier], y0: y, y1: y + rise });
}

// The spiral wraps the whole structure: from ground + 15 m to the top + 10 m,
// its radius at each height the landmark's radius there + 12 m (capped at
// 80 m), never widening with height and eased over 15 m of height at each
// step. The angle advances as 1/R so the climb is constant and ≤ 30°; more
// turns than the tier's minimum when the climb needs them. One turn never
// rises less than TURN_GAP_M over the previous one (no overlay).
function spiralRadii(profile, anchor, y0, n, pad) {
	const raw = new Float64Array(n);
	for (let j = 0; j < n; j++) raw[j] = Math.min(SPIRAL_MAX_R_M, radiusAtHeight(profile, anchor, y0 + j) + pad);
	for (let j = n - 2; j >= 0; j--) raw[j] = Math.max(raw[j], raw[j + 1]); // non-increasing with height
	// Trailing mean over the 15 m below: never under the requirement (it is non-increasing).
	const R = new Float64Array(n);
	let acc = 0;
	for (let j = 0; j < n; j++) {
		acc += raw[j];
		if (j >= SPIRAL_SMOOTH_M) acc -= raw[j - SPIRAL_SMOOTH_M];
		const k = Math.min(j + 1, SPIRAL_SMOOTH_M);
		R[j] = (acc + raw[0] * (SPIRAL_SMOOTH_M - k)) / SPIRAL_SMOOTH_M;
	}
	return R;
}

function buildSpiral(ctx) {
	const { anchor, profile, tier, attempt, theta0, dir } = ctx;
	const pad = RADIUS_MARGIN_M + attempt * RADIUS_STEP_M;
	const lift = attempt * ALT_STEP_M;
	const minRise = TURN_GAP_M;
	const maxRate = TAU / minRise; // radians per metre of height
	const y0 = profile.ground + SPIRAL_FLOOR_M + lift;
	let y1 = Math.max(landmarkTop(anchor) + SPIRAL_OVER_TOP_M + lift, y0 + SPIRAL_OVER_TOP_M);
	let R, n, turns;
	for (let pass = 0; pass < 2; pass++) {
		n = Math.max(2, Math.ceil(y1 - y0) + 1);
		const dy = (y1 - y0) / (n - 1);
		R = spiralRadii(profile, anchor, y0, n, pad);
		let W = 0; // ∫ dy / R
		for (let j = 1; j < n; j++) W += dy * 2 / (R[j - 1] + R[j]);
		const need = W / (SPIRAL_CLIMB_MAX * TAU);
		const t2 = Math.max(SPIRAL_TURNS[tier >= 3 ? 2 : tier], need);
		turns = tier >= 3 ? Math.max(SPIRAL_TURNS[3], SPIRAL_TIER3_FACTOR * t2) : t2;
		// Too short a climb for these turns: climb higher.
		if (y1 - y0 >= minRise * turns - 1e-9) break;
		y1 = y0 + minRise * turns;
	}
	const dy = (y1 - y0) / (n - 1);
	const Theta = turns * TAU;
	// Angle per metre of height: min(1 / (t·R), maxRate); t (the climb's
	// tangent) solved so the whole spiral makes `turns`.
	const rate = (t, j) => Math.min(1 / (t * R[j]), maxRate);
	const total = (t) => { let a = 0; for (let j = 1; j < n; j++) a += dy * (rate(t, j - 1) + rate(t, j)) / 2; return a; };
	let lo = 1e-4, hi = SPIRAL_CLIMB_MAX;
	for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (total(m) > Theta) lo = m; else hi = m; }
	const t = hi;
	const raw = [];
	let th = 0;
	const push = (a, rr, y) => {
		const x = anchor.x + rr * Math.cos(theta0 + dir * a), z = anchor.z + rr * Math.sin(theta0 + dir * a);
		raw.push(x, Math.max(y, surfaceAt(profile, anchor, x, z) + SPIRAL_OVER_SURF_M), z);
	};
	push(0, R[0], y0);
	for (let j = 1; j < n; j++) {
		const dth = dy * (rate(t, j - 1) + rate(t, j)) / 2;
		const steps = Math.max(1, Math.ceil(Math.hypot(dth * R[j], dy, R[j] - R[j - 1])));
		for (let s2 = 1; s2 <= steps; s2++) {
			const f = s2 / steps;
			push(th + dth * f, R[j - 1] + (R[j] - R[j - 1]) * f, y0 + dy * (j - 1 + f));
		}
		th += dth;
	}
	return raw;
}

// A pass perpendicular to the deck, 40 m either side of the axis. Tier III adds
// a vertical half-loop out over the deck, a pass back over it, a half-loop
// down and a return pass under — drifted 12 m along the deck so the two passes
// never overlay.
function buildUnder(ctx) {
	const { anchor, profile, tier, attempt, approach } = ctx;
	// One verified site per attempt (src/trace-probe.js profile.axes); past
	// them, the first one shifted along the deck.
	const sites = Array.isArray(profile.axes) && profile.axes.length ? profile.axes : [profile.axis];
	const own = attempt < sites.length;
	const ax = own ? sites[attempt] : sites[0];
	const len = Math.hypot(ax.dx, ax.dz);
	const ux = ax.dx / len, uz = ax.dz / len;           // along the deck
	let px = -uz, pz = ux;                               // across it
	const cx0 = Number.isFinite(ax.cx) ? ax.cx : anchor.x;
	const cz0 = Number.isFinite(ax.cz) ? ax.cz : anchor.z;
	// Entry (at −40 m along p) on the drone's side.
	if (approach && (approach.x - cx0) * px + (approach.z - cz0) * pz > 0) { px = -px; pz = -pz; }
	const shift = own ? 0 : UNDER_SHIFT_M[attempt - sites.length + 1] ?? 0;
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
	// Over the deck, and over whatever stands by it along that pass (a tree on
	// an island, a truss: axis.overTopY, from the probe's deck grid).
	const overY = Math.max((Number.isFinite(ax.topY) ? ax.topY : ax.deckY + DECK_THICKNESS_M) + UNDER_OVER_DECK_M,
		Number.isFinite(ax.overTopY) ? ax.overTopY + UNDER_OVER_CLEAR_M : -Infinity);
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

// Start 40 m above the landmark's top, 10 m from its summit towards the drone, then down
// the steepest face (the angle whose outer ring drops most), never closer than
// 10 m to the probed surface, ending 10 m above the lowest probed point when
// the path allows it: 60 m / 160 m at least, longer for a deeper drop so the
// descent stays ≤ 45°, 250 m at most.
function buildDive(ctx) {
	const { anchor, profile, tier, attempt, theta0 } = ctx;
	const rings = profile.rings;
	const outer = rings[rings.length - 1];
	const n = outer.heights.length;
	// Summit: the highest grid point inside the anchor's probe ring (a higher
	// ridge further out is not this landmark).
	let sx = anchor.x, sz = anchor.z, best = -Infinity;
	for (const ring of rings) {
		if (ring.r > ANCHOR_RING_M) continue;
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
	const yStart = Math.max(landmarkTop(anchor) + DIVE_ABOVE_TOP_M, surfaceAt(profile, anchor, Sx, Sz) + clr) + attempt * ALT_STEP_M;
	// Never steeper than 45° (the face aside): the path grows with the drop,
	// up to DIVE_MAX_LENGTH_M; a drop deeper than that, or than the grid
	// reaches, ends the dive higher up the face.
	const drop = Math.max(0, Math.min(yStart - (profile.ground + clr), H, DIVE_MAX_LENGTH_M / Math.SQRT2));
	const yEnd = yStart - drop;
	const L = Math.min(DIVE_MAX_LENGTH_M, Math.max(DIVE_LENGTH_M[tier], drop * Math.SQRT2));
	// L ≥ drop·√2, so the horizontal run is already ≥ drop: ≤ 45°.
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

// -> { id, shape, points, cum, length, tolerance } | null (no tier, no profile,
// a non-finite anchor). Tiers I and II share the short form (half a turn, a
// single pass under); tier I's dive is 40 m and its tolerance 15 m. A
// bridge/arch without a usable axis (none, or less than UNDER_MIN_CLEARANCE_M
// of clearance) falls back to an orbit.
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
		// index: the segment the progress is on (its start point), for liftStart's minIndex.
		this.out = { state: 'waiting', progress01: 0, offS: 0, flownM: 0, fade01: 0, elapsedS: 0, index: 0 };
		this._s = 0;
		this._seg = 0;
		this._fading = false;
	}

	reset() {
		const o = this.out;
		o.state = 'waiting'; o.progress01 = 0; o.offS = 0; o.flownM = 0; o.fade01 = 0; o.elapsedS = 0; o.index = 0;
		this._s = 0; this._seg = 0; this._fading = false;
	}

	update({ dt, pos }) {
		const o = this.out;
		if (!(dt > 0) || o.state === 'done' || !pos) return o;
		if (!(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))) return o;
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
		o.index = this._seg;
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

// Where the photo aims: the landmark's mid-height over the anchor's point,
// (profile ground + anchor.y) / 2 — the anchor sits on the top (the Eiffel
// Tower's spire tip), so aiming there kept a photo of the tip alone. No
// usable profile: the anchor itself. The line of sight is photoInSight().
export function photoAim(anchor, profile) {
	if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) return null;
	if (!validProfile(profile) || !(profile.ground < anchor.y)) return { x: anchor.x, y: anchor.y, z: anchor.z };
	return { x: anchor.x, y: (profile.ground + anchor.y) / 2, z: anchor.z };
}

// The photo's line of sight, cam -> aim, given where the ray first hit
// (hitM, metres from cam; Infinity when clear). The aim sits inside the
// landmark, so a hit on the landmark itself is a view of it: within
// PHOTO_HIT_SLACK_M of the aim, or no further from the anchor's vertical than
// the landmark's radius at the hit's height (+ the slack). Anything else in
// front of it — a neighbour, the ground — blocks the photo.
export function photoInSight(cam, aim, hitM, anchor, profile) {
	if (!(hitM < Infinity)) return true;
	const dx = aim.x - cam.x, dy = aim.y - cam.y, dz = aim.z - cam.z;
	const d = Math.hypot(dx, dy, dz);
	if (!(d > 1e-6) || d - hitM <= PHOTO_HIT_SLACK_M) return true;
	const k = hitM / d;
	const hx = cam.x + dx * k, hy = cam.y + dy * k, hz = cam.z + dz * k;
	if (!anchor || !validProfile(profile) || !(hy > profile.ground + PHOTO_HIT_SLACK_M)) return false;
	return Math.hypot(hx - anchor.x, hz - anchor.z) <= radiusAtHeight(profile, anchor, hy) + PHOTO_HIT_SLACK_M;
}

// Angle (degrees) between the camera's forward {fx, fy, fz} and the direction to p.
export function viewAngleDeg(cam, p) {
	const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
	const d = Math.hypot(dx, dy, dz);
	if (!(d > 1e-6)) return 0;
	const cos = (dx * cam.fx + dy * cam.fy + dz * cam.fz) / d;
	return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}
