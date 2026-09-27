// Selftest of the clearance ladder (issue #185, spec author's decision
// 2026-09-28). Run: node tools/signal-clearance-selftest.mjs
import assert from 'node:assert/strict';
import {
	TIER_POINTS, STEPS, MAX_CLEARANCE, LEVELS,
	swarmAllowed, tierAllowed, familiesFor, pointsOf, clearanceOf, nextStep, crossed,
} from './signal-clearance-model.mjs';
import { TARGET_FAMILIES } from './target-model.mjs';
import { withResolved, fromStored } from './signal-store-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A synthetic store with exactly `points` worth of tier-1 entries (1 point
// each), so pointsOf/clearanceOf can be driven to an exact number.
function storeWith(points) {
	let s = fromStored(null);
	for (let i = 0; i < points; i++) {
		s = withResolved(s, `wd:Q${i + 1}`, {
			at: i, name: 'X', lat: 0, lon: 0, tier: 1,
			family: 'freestyle5', holdS: 5, distM: 100, sessionId: null, photo: null,
		});
	}
	return s;
}

t('constants from the spec', () => {
	assert.deepEqual(TIER_POINTS, { 1: 1, 2: 2, 3: 3 });
	assert.deepEqual(STEPS, [0, 6, 18, 36]);
	assert.equal(MAX_CLEARANCE, 3);
});

t('pointsOf sums TIER_POINTS over resolved entries', () => {
	let s = fromStored(null);
	s = withResolved(s, 'wd:Q1', { at: 1, name: 'a', lat: 0, lon: 0, tier: 1, family: 'freestyle5', holdS: 5, distM: 1, sessionId: null, photo: null });
	s = withResolved(s, 'wd:Q2', { at: 2, name: 'b', lat: 0, lon: 0, tier: 2, family: 'freestyle5', holdS: 5, distM: 1, sessionId: null, photo: null });
	s = withResolved(s, 'wd:Q3', { at: 3, name: 'c', lat: 0, lon: 0, tier: 3, family: 'freestyle5', holdS: 5, distM: 1, sessionId: null, photo: null });
	assert.equal(pointsOf(s), 1 + 2 + 3);
});

t('clearanceOf at the step boundaries', () => {
	assert.equal(clearanceOf(storeWith(5)), 0);
	assert.equal(clearanceOf(storeWith(6)), 1);
	assert.equal(clearanceOf(storeWith(17)), 1);
	assert.equal(clearanceOf(storeWith(18)), 2);
	assert.equal(clearanceOf(storeWith(35)), 2);
	assert.equal(clearanceOf(storeWith(36)), 3);
});

t('nextStep: the level, points and points still needed; null at max', () => {
	assert.deepEqual(nextStep(storeWith(5)), { level: 1, points: 5, need: 6 });
	assert.deepEqual(nextStep(storeWith(18)), { level: 3, points: 18, need: 36 });
	assert.equal(nextStep(storeWith(36)), null);
});

t('crossed: a step reached is the new level, otherwise null', () => {
	assert.equal(crossed(5, 7), 1);
	assert.equal(crossed(7, 8), null);
	assert.equal(crossed(17, 18), 2);
	assert.equal(crossed(0, 0), null);
});

t('level 0 is exactly freestyle5, tier I only', () => {
	assert.deepEqual(LEVELS[0].families, ['freestyle5']);
	assert.deepEqual(LEVELS[0].tiers, [1]);
});

t('each level includes the previous families verbatim', () => {
	for (let i = 1; i < LEVELS.length; i++) {
		for (const f of LEVELS[i - 1].families) assert.ok(LEVELS[i].families.includes(f), `${f} missing at level ${i}`);
	}
});

t('the union of the top level equals TARGET_FAMILIES exactly', () => {
	assert.deepEqual([...LEVELS[MAX_CLEARANCE].families].sort(), [...TARGET_FAMILIES].sort());
});

t('swarmAllowed only at MAX_CLEARANCE', () => {
	assert.equal(swarmAllowed(0), false);
	assert.equal(swarmAllowed(1), false);
	assert.equal(swarmAllowed(2), false);
	assert.equal(swarmAllowed(3), true);
});

t('tierAllowed and familiesFor follow LEVELS', () => {
	assert.equal(tierAllowed(0, 1), true);
	assert.equal(tierAllowed(0, 2), false);
	assert.equal(tierAllowed(2, 3), true);
	assert.deepEqual(familiesFor(1), ['freestyle5', 'cinewhoop', 'toothpick']);
});

console.log(`signal-clearance: ${n} ok`);
