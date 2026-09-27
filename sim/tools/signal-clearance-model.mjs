// Clearance: the progression ladder over uplinked signals (issue #185, spec
// author's decision 2026-09-28). Pure — no DOM, no THREE, no Rapier — so the
// hangar, the OSD line, the take-off notice and the end-of-flight reveal all
// read the same numbers. Points accrue per uplinked signal, never spent,
// never lost: `pointsOf` only ever grows as `signals` grows
// (tools/signal-store-model.mjs is append-only).
import { fromStored } from './signal-store-model.mjs';

// One point per tier, cumulative — the harder the tier, the more it counts.
export const TIER_POINTS = { 1: 1, 2: 2, 3: 3 };
// Points needed for clearance 0, 1, 2, 3. STEPS[0] is always 0: everyone
// starts at clearance 0 with the freestyle already unlocked.
export const STEPS = [0, 6, 18, 36];
export const MAX_CLEARANCE = STEPS.length - 1;

// Each level includes the previous level's families verbatim: nothing a
// player unlocked is ever taken away by a later level. `opens` is only what
// THIS level adds, for the take-off notice and the hangar's cost labels.
const FREESTYLE = ['freestyle5'];
const LEVEL1_ADD = ['cinewhoop', 'toothpick'];
const LEVEL2_ADD = ['race5', 'longrange', 'heavy5'];

export const LEVELS = [
	{ tiers: [1], families: [...FREESTYLE], opens: [...FREESTYLE] },
	{ tiers: [1, 2], families: [...FREESTYLE, ...LEVEL1_ADD], opens: [...LEVEL1_ADD] },
	{ tiers: [1, 2, 3], families: [...FREESTYLE, ...LEVEL1_ADD, ...LEVEL2_ADD], opens: [...LEVEL2_ADD] },
	{ tiers: [1, 2, 3], families: [...FREESTYLE, ...LEVEL1_ADD, ...LEVEL2_ADD], swarm: true, opens: ['swarm'] },
];

// The swarm is drawable only from clearance MAX_CLEARANCE (spec: "The swarm
// can only appear from clearance 3"), never inferred from `tiers` alone.
export function swarmAllowed(level) {
	return !!LEVELS[level]?.swarm;
}

export function tierAllowed(level, tier) {
	return !!LEVELS[level]?.tiers.includes(tier);
}

export function familiesFor(level) {
	return LEVELS[level]?.families ?? [];
}

// Highest step reached by this many points.
function levelFor(points) {
	let lvl = 0;
	for (let i = STEPS.length - 1; i >= 0; i--) {
		if (points >= STEPS[i]) { lvl = i; break; }
	}
	return lvl;
}

export function pointsOf(store) {
	const { resolved } = fromStored(store);
	let total = 0;
	for (const e of Object.values(resolved)) total += TIER_POINTS[e.tier] ?? 0;
	return total;
}

export function clearanceOf(store) {
	return levelFor(pointsOf(store));
}

// `null` once MAX_CLEARANCE is reached: there is no next step to show.
export function nextStep(store) {
	const points = pointsOf(store);
	const level = levelFor(points);
	if (level >= MAX_CLEARANCE) return null;
	return { level: level + 1, points, need: STEPS[level + 1] };
}

// The step reached when a store change raises the level (a fresh uplink), for
// the take-off notice and the end-screen reveal. `null` when the level did
// not change (still short of the next step, or already past it).
export function crossed(before, after) {
	const a = levelFor(before), b = levelFor(after);
	return b > a ? b : null;
}
