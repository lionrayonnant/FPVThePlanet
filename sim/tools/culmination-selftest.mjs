// Selftest of the pure helpers behind the hack culmination (PHASE 10, #101).
// No I/O, no DOM. Run: node tools/culmination-selftest.mjs
import assert from 'node:assert/strict';
import { HACK_TYPES } from './target-model.mjs';
import { CULMINATION_VARIANTS, pickVariant } from './culmination-model.mjs';
import { RITUAL_PRIMITIVES, FAMILY_PRIMITIVES } from '../src/hack-grammars.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('pickVariant: deterministic for a given seed', () => {
	for (const seed of ['abc', 'gnss-spoof::1', '42']) {
		assert.deepEqual(pickVariant(seed), pickVariant(seed));
	}
});

t('pickVariant: covers the 4 variants over a sample of seeds', () => {
	const seen = new Set();
	for (let i = 0; i < 200; i++) seen.add(pickVariant(`seed-${i}`).id);
	assert.deepEqual([...seen].sort(), ['V1', 'V2', 'V3', 'V4']);
});

t('pickVariant: always an element of CULMINATION_VARIANTS', () => {
	for (let i = 0; i < 50; i++) {
		assert.ok(CULMINATION_VARIANTS.includes(pickVariant(`x-${i}`)));
	}
});

// Bible §18: one to four seconds, and a beat that stays a beat — a V4 breathes,
// it is not a V1 stretched thin.
t('CULMINATION_VARIANTS: V1..V4, 1 to 4 s, one beat per second', () => {
	assert.deepEqual(CULMINATION_VARIANTS.map((v) => v.id), ['V1', 'V2', 'V3', 'V4']);
	for (const v of CULMINATION_VARIANTS) {
		assert.ok(v.ms >= 1000 && v.ms <= 4000, `${v.id}: ${v.ms} ms out of range`);
		assert.equal(v.ms / v.beats, 1000, `${v.id}: beat is not a second`);
	}
});

t('FAMILY_PRIMITIVES: every HACK_TYPES has an entry whose primitives exist', () => {
	for (const h of HACK_TYPES) {
		const list = FAMILY_PRIMITIVES[h];
		assert.ok(Array.isArray(list) && list.length >= 2, `${h}: at least 2 primitives`);
		for (const name of list) {
			assert.ok(RITUAL_PRIMITIVES[name], `${h}: unknown primitive "${name}"`);
		}
	}
});

t('FAMILY_PRIMITIVES: the PHASE 20 primitives are composed by a family', () => {
	const used = new Set(Object.values(FAMILY_PRIMITIVES).flat());
	for (const name of ['colorFlash', 'textWarp', 'bannerBurst']) {
		assert.ok(used.has(name), `${name} is composed by no family`);
	}
});

// La signature sonore par famille (CULMINATION_SCORES, scoreFor) vit dans
// tools/ui-audio-model.mjs : c'est ui-audio-selftest.mjs qui la couvre.

console.log(`\n${n} tests culmination OK`);
