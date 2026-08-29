// PHASE 11 — Entry State. After JACK IN (and after every in-session respawn)
// the drone starts already in flight: a weighted category picks how gentle or
// hairy that moment is, a candidate is sampled anywhere in the scene, and two
// safety nets (geometry, then a headless physics rollout) reject anything
// that would crash before the player can touch a stick. See
// docs/superpowers/specs/2026-08-29-phase-11-entry-state-design.md.
//
// Runs both in the browser (bundled by Vite) and in Node (selftest) — no
// browser-only API, no `node:` import.

import { FlightController, hoverThrottle } from './flightController.js';
import { crashThreshold } from './quad.js';

export const CATEGORIES = ['COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const WEIGHTS = [60, 25, 12, 3];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
// tools/target-model.mjs et src/link.js : petit, déterministe, rejouable).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

export function pickCategory(rand) {
	const r = rand() * 100;
	let acc = 0;
	for (let i = 0; i < CATEGORIES.length; i++) {
		acc += WEIGHTS[i];
		if (r < acc) return CATEGORIES[i];
	}
	return CATEGORIES[CATEGORIES.length - 1];
}

const DEG = Math.PI / 180;

// Starting points, hand-picked like target-model.mjs's proportions — not
// measured, tunable to feel without touching the safety net (geometrySafe /
// rolloutSafe are what actually keep every draw fair).
export const RANGES = {
	COMFORTABLE: { aglM: [15, 40], speedMs: [2, 8], tiltDeg: [0, 10], rateDps: [0, 30] },
	ACTIVE: { aglM: [8, 25], speedMs: [8, 18], tiltDeg: [5, 25], rateDps: [20, 90] },
	CHALLENGING: { aglM: [3, 12], speedMs: [18, 30], tiltDeg: [20, 50], rateDps: [60, 200] },
	HOLY_SHIT: { aglM: [1.5, 5], speedMs: [25, 40], tiltDeg: [40, 80], rateDps: [150, 400] },
};

// How far past the bbox edge sampling stays away from, so a draw never lands
// past the last chunk actually loaded.
const EDGE_MARGIN = 10;

function lerp(rand, [lo, hi]) { return lo + rand() * (hi - lo); }

function qAxisAngle(axis, angle) {
	const s = Math.sin(angle / 2);
	return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

function qMul(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

// Local copy of flightController.js's rotate(): body-frame convention X=right,
// Y=up, Z=back (forward is -Z). No shared import — this file has no
// dependency on flightController.js beyond what rolloutSafe needs later.
function qRotateVec(q, v) {
	const tx = 2 * (q.y * v.z - q.z * v.y);
	const ty = 2 * (q.z * v.x - q.x * v.z);
	const tz = 2 * (q.x * v.y - q.y * v.x);
	return {
		x: v.x + q.w * tx + (q.y * tz - q.z * ty),
		y: v.y + q.w * ty + (q.z * tx - q.x * tz),
		z: v.z + q.w * tz + (q.x * ty - q.y * tx),
	};
}

const Y_AXIS = { x: 0, y: 1, z: 0 };
const X_AXIS = { x: 1, y: 0, z: 0 };
const Z_AXIS = { x: 0, y: 0, z: 1 };

// Height of the ground at an (x, z) with no prior y guess: cast from above the
// whole loaded scene downward, all the way to below it.
function groundAt(physics, manifest, x, z) {
	const top = manifest.bbox.max[1] + 50;
	const span = (manifest.bbox.max[1] - manifest.bbox.min[1]) + 100;
	return physics.groundBelow(x, top, z, span);
}

// Où, dans cette scène, y a-t-il du sol ?
//
// Le tirage prenait un point n'importe où dans la bbox du manifeste. Une scène
// rectangulaire remplit la sienne, donc ça marchait. Une scène tracée au
// polygone (issue #30) ne la remplit pas : sur un corridor de fleuve, 315
// tirages sur 400 tombaient dans le vide, et generateEntryState() finissait par
// se rabattre sur un spawn au repos — exactement ce que PHASE 13 existe pour
// éviter.
//
// On balaie donc une grille grossière une seule fois, et on ne tire plus que
// dans les cellules qui ont du sol. Le balayage coûte quelques milliers de
// rayons ; il remplace des milliers de tirages perdus.
//
// La taille de cellule suit la tuile Flyover (~25 m au zoom 20) : assez fine
// pour épouser un corridor, assez grossière pour que le balayage reste court.
const OCCUPANCY_CELL_M = 25;
const OCCUPANCY_MAX_SIDE = 64;

// Clé sur l'instance Physics : c'est le maillage qui décide de l'occupation, et
// une WeakMap laisse le tout partir avec la scène.
const occupancyCache = new WeakMap();

export function occupancyOf(physics, manifest) {
	const cached = occupancyCache.get(physics);
	if (cached) return cached;

	const x0 = manifest.bbox.min[0] + EDGE_MARGIN, x1 = manifest.bbox.max[0] - EDGE_MARGIN;
	const z0 = manifest.bbox.min[2] + EDGE_MARGIN, z1 = manifest.bbox.max[2] - EDGE_MARGIN;
	const cols = Math.max(1, Math.min(OCCUPANCY_MAX_SIDE, Math.round((x1 - x0) / OCCUPANCY_CELL_M)));
	const rows = Math.max(1, Math.min(OCCUPANCY_MAX_SIDE, Math.round((z1 - z0) / OCCUPANCY_CELL_M)));
	const dx = (x1 - x0) / cols, dz = (z1 - z0) / rows;

	const cells = [];
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < cols; i++) {
			// Le centre de la cellule : un point par cellule suffit à dire
			// « il y a du terrain par ici », et le tirage repique ensuite au hasard
			// dans la cellule retenue.
			if (groundAt(physics, manifest, x0 + (i + 0.5) * dx, z0 + (j + 0.5) * dz) !== null) {
				cells.push(j * cols + i);
			}
		}
	}

	// Aucune cellule touchée : soit la scène est vide, soit elle est plus fine
	// que la grille. On rend alors toute l'emprise plutôt qu'une liste vide, ce
	// qui ramène exactement au comportement d'avant — le tirage rejette, et
	// generateEntryState() garde son repli.
	const grid = cells.length
		? { x0, z0, dx, dz, cols, rows, cells, cellSize: Math.min(dx, dz), full: cells.length === cols * rows }
		: { x0, z0, dx: x1 - x0, dz: z1 - z0, cols: 1, rows: 1, cells: [0], cellSize: Math.min(dx, dz), full: true };

	occupancyCache.set(physics, grid);
	return grid;
}

export function sampleCandidate(category, manifest, physics, rand) {
	const ranges = RANGES[category];
	// Sur une scène pleine, toutes les cellules sont occupées et le tirage
	// redevient uniforme dans la bbox : le comportement historique, intact.
	const grid = occupancyOf(physics, manifest);
	const cell = grid.cells[Math.min(grid.cells.length - 1, Math.floor(rand() * grid.cells.length))];
	const x = grid.x0 + (cell % grid.cols + rand()) * grid.dx;
	const z = grid.z0 + (Math.floor(cell / grid.cols) + rand()) * grid.dz;
	const ground = groundAt(physics, manifest, x, z);
	if (ground === null) return null;
	const y = ground + lerp(rand, ranges.aglM);

	const heading = rand() * Math.PI * 2;
	const tilt = lerp(rand, ranges.tiltDeg) * DEG;
	const tiltSplit = rand();
	const pitch = tilt * tiltSplit * (rand() < 0.5 ? -1 : 1);
	const roll = tilt * (1 - tiltSplit) * (rand() < 0.5 ? -1 : 1);

	const qYaw = qAxisAngle(Y_AXIS, heading);
	const qPitch = qAxisAngle(X_AXIS, pitch);
	const qRoll = qAxisAngle(Z_AXIS, roll);
	const qYawPitch = qMul(qYaw, qPitch);
	const quaternion = qMul(qYawPitch, qRoll);

	// Velocity follows heading+pitch (where the nose points), not the roll bank
	// on top of it — banking turns the drone without turning its velocity.
	const forward = qRotateVec(qYawPitch, { x: 0, y: 0, z: -1 });
	const speed = lerp(rand, ranges.speedMs);
	const linvel = { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed };

	// Body-frame rate split across the three axes, converted to world frame —
	// Physics.step()/Rapier expect angvel in world frame (see physics.js).
	const rateMag = lerp(rand, ranges.rateDps) * DEG;
	const split1 = rand(), split2 = rand();
	const bodyRate = {
		x: rateMag * split1 * (rand() < 0.5 ? -1 : 1),
		y: rateMag * (1 - split1) * split2 * (rand() < 0.5 ? -1 : 1),
		z: rateMag * (1 - split1) * (1 - split2) * (rand() < 0.5 ? -1 : 1),
	};
	const angvel = qRotateVec(quaternion, bodyRate);

	return { category, position: { x, y, z }, quaternion, linvel, angvel };
}

// How far ahead along the velocity direction the obstruction check looks, and
// how much of that stretch may legitimately be "material" (a roof edge
// clipped tangentially) before it counts as a wall in the way.
const LOOKAHEAD_M = 15;
const BLOCK_SPAN_M = 2;

export function geometrySafe(candidate, physics) {
	const { position, linvel } = candidate;
	const ground = physics.groundBelow(position.x, position.y, position.z);
	if (ground === null || position.y - ground < 1) return false;

	const speed = Math.hypot(linvel.x, linvel.y, linvel.z);
	if (speed < 1e-6) return true;
	const dir = { x: linvel.x / speed, y: linvel.y / speed, z: linvel.z / speed };
	const ahead = {
		x: position.x + dir.x * LOOKAHEAD_M,
		y: position.y + dir.y * LOOKAHEAD_M,
		z: position.z + dir.z * LOOKAHEAD_M,
	};
	const o = physics.obstructionBetween(position.x, position.y, position.z, ahead.x, ahead.y, ahead.z);
	if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	return true;
}

const NEUTRAL_STICKS = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
const ROLLOUT_SECONDS = 1.0;

// Validates a candidate by living one second with it, unattended: sticks
// neutral, throttle held at whatever cancels gravity at the current tilt (a
// drone "already in flight" is already near its own trim, not at the
// throttle floor — see the design doc's decision on this). If a contact
// force ever exceeds the game's own crash threshold during that second, the
// candidate is rejected. Reuses the real Physics/FlightController — no
// second physics model.
export function rolloutSafe(candidate, physics) {
	physics.applyEntryState(candidate);
	const profile = physics.profile;
	const controller = new FlightController({ profile });
	controller.setMode('acro');
	const dt = physics.world.timestep;
	const steps = Math.round(ROLLOUT_SECONDS / dt);
	const sticks = { ...NEUTRAL_STICKS };
	for (let i = 0; i < steps; i++) {
		sticks.throttle = hoverThrottle(profile, physics.rotation);
		const { motors } = controller.update(sticks, physics, dt);
		const impact = physics.step(motors, dt);
		if (impact > 0 && impact > crashThreshold(physics.rotation)) return false;
	}
	return true;
}

const DEFAULT_MAX_ATTEMPTS = 20;

function fallbackCandidate(manifest) {
	return {
		category: 'COMFORTABLE',
		position: { ...manifest.spawn },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
}

// Never returns null: after maxAttempts unsuccessful draws it falls back to
// manifest.spawn at rest, which trivially satisfies both safety nets (it's
// exactly what physics.reset() has always spawned into).
export function generateEntryState({ physics, manifest, seed, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
	const rand = rngFrom(seed);
	const category = pickCategory(rand);
	for (let i = 0; i < maxAttempts; i++) {
		const candidate = sampleCandidate(category, manifest, physics, rand);
		if (candidate && geometrySafe(candidate, physics) && rolloutSafe(candidate, physics)) {
			physics.applyEntryState(candidate);
			return candidate;
		}
	}
	const fallback = fallbackCandidate(manifest);
	physics.applyEntryState(fallback);
	return fallback;
}
