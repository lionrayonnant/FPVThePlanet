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
import { Geofence } from './geofence.js';

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

// La marge au bord, désormais celle de la clôture (#139) et non plus une
// valeur locale. Elle valait 10 m, ce qui suffisait à ne pas tirer un point
// au-delà du dernier chunk chargé — mais pas à naître HORS de l'avertissement
// de zone : R_CAUTION se compte en dizaines de mètres. Un vol ne doit jamais
// commencer sur un « NO COVERAGE ».
//
// C'est le couloir EFFECTIF de la scène qu'on lit (`effectiveCorridor.caution`)
// et non la constante R_CAUTION : la clôture borne son couloir au tiers du plus
// petit demi-côté (geofence.js), donc sur une petite carte elle avertit BIEN
// plus près du bord que 113 m. Retirer la constante de chaque côté y retirerait
// une bande que la clôture ne réclame pas. Mesuré sur les 25 scènes de
// public/scenes/ : sur parcdesprinces (demi-côtés 139 × 151 m) la constante ne
// laisserait qu'une bande de 51 × 76 m — 4,6 % de l'emprise — là où le couloir
// effectif vaut 46,2 m et en laisse 185 × 209. Et sur une carte de moins de
// 113 m de demi-côté l'encart CROISERAIT (x0 > x1) ; le couloir effectif, qui
// vaut au plus halfMin/3, ne le peut pas.
//
// Un Geofence est construit plutôt que la formule recopiée : c'est lui qui
// décide de la borne, et il n'y a aucune raison d'en tenir un second
// exemplaire ici. Le coût est nul — occupancyOf() ne passe ici qu'au défaut de
// cache, une fois par instance Physics.
//
// La marge est STRICTE, et par construction plutôt que par chance : un tirage
// vaut x = x0 + (i + rand()) * dx avec 0 <= i <= cols-1, et rngFrom() est un
// xorshift32 dont l'état ne peut jamais atteindre 0 depuis un état non nul —
// donc rand() vit dans ]0, 1[, bornes exclues. x est donc strictement dans
// ]x0, x1[, jamais posé dessus. Or zoneOf() bascule en CAUTION dès que la
// marge est <= caution : c'est cette exclusion-là qui garantit la propriété,
// pas les 10 000 tirages de tools/selftest.mjs, qui ne font que la surveiller.
function edgeMarginOf(manifest) {
	return new Geofence(manifest.bbox).effectiveCorridor.caution;
}

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
// La taille de cellule suit une tuile slippy au zoom 20 (~25 m) : assez fine
// pour épouser un corridor, assez grossière pour que le balayage reste court.
const OCCUPANCY_CELL_M = 25;
const OCCUPANCY_MAX_SIDE = 64;

// Clé sur l'instance Physics : c'est le maillage qui décide de l'occupation, et
// une WeakMap laisse le tout partir avec la scène.
const occupancyCache = new WeakMap();

export function occupancyOf(physics, manifest) {
	const cached = occupancyCache.get(physics);
	if (cached) return cached;

	const edgeMargin = edgeMarginOf(manifest);
	const x0 = manifest.bbox.min[0] + edgeMargin, x1 = manifest.bbox.max[0] - edgeMargin;
	const z0 = manifest.bbox.min[2] + edgeMargin, z1 = manifest.bbox.max[2] - edgeMargin;
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

// Which category this entry uses: the one the bench asked for, or the weighted
// draw of Bible §20. Split out of generateEntryState() so it can be checked
// without a scene and without a Physics — the rest of that function cannot.
//
// An unknown forced value falls back to the draw rather than throwing: the
// bench normalises its own config, so anything arriving here that isn't a
// category is a bug elsewhere, and a bug elsewhere should not stop a flight.
//
// Note that forcing skips pickCategory(), so the sampling stream starts one
// draw earlier for the same seed. FIELD never forces, so its sequence is
// untouched, seed for seed.
export function resolveCategory(forced, rand) {
	return forced && CATEGORIES.includes(forced) ? forced : pickCategory(rand);
}

// Le rectangle où un vol a le droit de commencer : la bbox moins le couloir
// CAUTION effectif de la scène, exactement celui qu'utilise occupancyOf() pour
// le tirage. Sorti en fonction parce que le REPLI doit désormais s'y ramener
// lui aussi (issue #149).
//
// La borne du couloir (halfMin/3, geofence.js) interdit à l'encart de croiser
// sur une carte réelle. Une bbox dégénérée — le banc, où il n'y a pas de carte
// — le peut : on retombe alors sur le centre plutôt que de rendre un intervalle
// à l'envers.
export function insetRect(manifest) {
	const m = edgeMarginOf(manifest);
	const { min, max } = manifest.bbox;
	let x0 = min[0] + m, x1 = max[0] - m;
	let z0 = min[2] + m, z1 = max[2] - m;
	if (x0 > x1) { const c = (min[0] + max[0]) / 2; x0 = x1 = c; }
	if (z0 > z1) { const c = (min[2] + max[2]) / 2; z0 = z1 = c; }
	return { x0, x1, z0, z1 };
}

// zoneOf() bascule en CAUTION dès que la marge est <= caution : se poser PILE
// sur le bord de l'encart naîtrait donc encore dans l'avertissement. On rentre
// d'une petite longueur, bornée par la moitié du côté pour ne jamais traverser.
const INSET_EPS_M = 0.5;

const clampInto = (v, lo, hi) => {
	const eps = Math.min(INSET_EPS_M, (hi - lo) / 2);
	return Math.min(hi - eps, Math.max(lo + eps, v));
};

// Hauteur au-dessus du sol qu'on redonne à un repli qu'on a dû déplacer :
// geometrySafe() exige déjà plus d'un mètre, et un repli est censé être le
// point le plus tranquille de la scène, pas le plus juste.
const FALLBACK_CLEARANCE_M = 2;

// Le point de repli, au repos. Exporté pour le banc (PHASE 26), où se poser au
// sol moteurs au ralenti est un état qu'on demande, pas celui où l'on finit
// après vingt tirages ratés.
//
// manifest.spawn N'EST PAS contraint par la clôture : mesuré sur les 25
// manifestes de public/scenes/, il tombe en HOLD sur parcdesprinces et en
// CAUTION sur bastille et triomphe (issue #149). Un repli — ou tout chemin qui
// repart de là — commençait donc le vol sur un « NO COVERAGE », et sur
// parcdesprinces avec le rappel de clôture déjà actif.
//
// On ramène donc le point dans l'encart. Le déplacer horizontalement sans
// retoucher son altitude le poserait dans un bâtiment ou sous le terrain : dès
// qu'on a une Physics, on le REPOSE sur le sol qui est réellement là. Sans
// Physics (appel purement manifeste), on corrige ce qu'on peut — les x/z — et
// on laisse le y, ce qui reste strictement mieux que le point d'origine.
//
// manifest.spawn lui-même n'est pas touché : il reste la position de la station
// sol (l'`emitter` de main.js), qui, elle, n'a aucune raison de bouger.
export function fallbackCandidate(manifest, physics = null) {
	const { x0, x1, z0, z1 } = insetRect(manifest);
	const spawn = manifest.spawn;
	const x = clampInto(spawn.x, x0, x1);
	const z = clampInto(spawn.z, z0, z1);

	let y = spawn.y;
	const moved = x !== spawn.x || z !== spawn.z;
	if (moved && physics) {
		const ground = groundAt(physics, manifest, x, z);
		if (ground !== null) {
			// On garde la garde au sol d'origine quand elle est mesurable et
			// plus généreuse : un spawn déjà perché ne doit pas se retrouver
			// collé au toit sur lequel on vient de le déplacer.
			const from = groundAt(physics, manifest, spawn.x, spawn.z);
			const agl = from === null ? FALLBACK_CLEARANCE_M : Math.max(FALLBACK_CLEARANCE_M, spawn.y - from);
			y = ground + agl;
		}
	}

	return {
		category: 'COMFORTABLE',
		position: { x, y, z },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
}

// Never returns null: after maxAttempts unsuccessful draws it falls back to
// manifest.spawn at rest, which trivially satisfies both safety nets (it's
// exactly what physics.reset() has always spawned into).
//
// `category` and `idle` are the bench's two overrides (PHASE 26) and nothing
// else passes them. Omitted, the draw is the weighted one of Bible §20, seed
// for seed and bit for bit — which is what keeps FIELD untouched by the
// existence of a bench.
//   category: 'ACTIVE'  force that category, still through both safety nets
//   idle: true          spawn at rest on the ground, no draw at all
export function generateEntryState({
	physics, manifest, seed, maxAttempts = DEFAULT_MAX_ATTEMPTS,
	category: forced = null, idle = false,
} = {}) {
	if (idle) {
		const at = fallbackCandidate(manifest, physics);
		// IDLE ON GROUND, not IDLE IN THE AIR: the sampled categories carry
		// their own AGL, but manifest.spawn is the ground station's own point
		// and is already the one physics.reset() uses.
		at.category = 'IDLE';
		physics.applyEntryState(at);
		return at;
	}
	const rand = rngFrom(seed);
	const category = resolveCategory(forced, rand);
	for (let i = 0; i < maxAttempts; i++) {
		const candidate = sampleCandidate(category, manifest, physics, rand);
		if (candidate && geometrySafe(candidate, physics) && rolloutSafe(candidate, physics)) {
			physics.applyEntryState(candidate);
			return candidate;
		}
	}
	const fallback = fallbackCandidate(manifest, physics);
	physics.applyEntryState(fallback);
	return fallback;
}
