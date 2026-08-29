// Selftest des helpers purs du rituel CONTROL VECTOR (PHASE 10). Aucune E/S,
// aucun DOM. Lancer : node tools/ritual-selftest.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { HACK_TYPES } from './target-model.mjs';
import {
	RITUAL_VARIANTS, FALLBACK_VECTOR, pickVariant, ritualVector, checkInput,
} from './ritual-model.mjs';
import { RITUAL_PRIMITIVES, FAMILY_PRIMITIVES } from '../src/hack-grammars.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('pickVariant : déterministe pour un même seed', () => {
	for (const seed of ['abc', 'gnss-spoof::1', '42']) {
		const a = pickVariant(seed);
		const b = pickVariant(seed);
		assert.deepEqual(a, b);
	}
});

t('pickVariant : couvre les 4 variantes sur un échantillon de seeds', () => {
	const seen = new Set();
	for (let i = 0; i < 200; i++) seen.add(pickVariant(`seed-${i}`).id);
	assert.deepEqual([...seen].sort(), ['V1', 'V2', 'V3', 'V4']);
});

t('pickVariant : toujours un élément de RITUAL_VARIANTS', () => {
	for (let i = 0; i < 50; i++) {
		assert.ok(RITUAL_VARIANTS.includes(pickVariant(`x-${i}`)));
	}
});

t('ritualVector : vecteur opérateur vide ou absent → FALLBACK_VECTOR', () => {
	assert.deepEqual(ritualVector([]), FALLBACK_VECTOR);
	assert.deepEqual(ritualVector(undefined), FALLBACK_VECTOR);
	assert.deepEqual(ritualVector(null), FALLBACK_VECTOR);
});

t('ritualVector : vecteur opérateur non vide → renvoyé tel quel', () => {
	const v = ['up', 'up', 'down', 'left'];
	assert.deepEqual(ritualVector(v), v);
});

t('checkInput : préfixe correct avance puis complète au dernier', () => {
	const vector = ['up', 'right', 'down'];
	let typed = [];
	let r = checkInput(vector, typed, 'up');
	assert.equal(r.status, 'advance');
	typed = ['up'];
	r = checkInput(vector, typed, 'right');
	assert.equal(r.status, 'advance');
	typed = ['up', 'right'];
	r = checkInput(vector, typed, 'down');
	assert.equal(r.status, 'complete');
});

t('checkInput : mauvais input à n\'importe quel index → mismatch', () => {
	const vector = ['up', 'right', 'down'];
	assert.equal(checkInput(vector, [], 'down').status, 'mismatch');
	assert.equal(checkInput(vector, ['up'], 'left').status, 'mismatch');
	assert.equal(checkInput(vector, ['up', 'right'], 'up').status, 'mismatch');
});

t('checkInput : au-delà de la longueur du vecteur → mismatch', () => {
	const vector = ['up'];
	assert.equal(checkInput(vector, ['up'], 'up').status, 'mismatch');
});

t('FAMILY_PRIMITIVES : chaque HACK_TYPES a une entrée dont les primitives existent', () => {
	for (const h of HACK_TYPES) {
		const list = FAMILY_PRIMITIVES[h];
		assert.ok(Array.isArray(list) && list.length >= 2, `${h} : au moins 2 primitives`);
		for (const name of list) {
			assert.ok(RITUAL_PRIMITIVES[name], `${h} : primitive inconnue "${name}"`);
		}
	}
});

t('RITUAL_PRIMITIVES : les 11 primitives documentées', () => {
	for (const name of [
		'scanBurst', 'glitchShift', 'pulseRing', 'gridSwarm',
		'waveformSpike', 'vectorSweep', 'memoryScroll', 'chromaSplit',
		'colorFlash', 'textWarp', 'bannerBurst',
	]) {
		assert.equal(typeof RITUAL_PRIMITIVES[name], 'function', `manque ${name}`);
	}
});

t('primitives : contrat (t, seed, dur) tenu de V1 à V4, sortie bornée 44×12', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		for (const dur of [1, 2, 3, 4]) {
			for (const tt of [0, dur * 0.5, dur - 0.016]) {
				const el = { textContent: '' };
				fn(el, { t: tt, seed: 0.37, dur });
				const rows = el.textContent.split('\n');
				assert.equal(rows.length, 12, `${name} dur=${dur} : 12 lignes`);
				for (const r of rows) assert.equal(r.length, 44, `${name} dur=${dur} : 44 colonnes`);
			}
		}
	}
});

t('primitives : dur absent → comportement par défaut (compat PHASE 10)', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		const el = { textContent: '' };
		fn(el, { t: 0.5, seed: 0.37 });
		assert.ok(el.textContent.length > 0, name);
	}
});

t('FAMILY_PRIMITIVES : les nouvelles primitives PHASE 20 sont composées', () => {
	const used = new Set(Object.values(FAMILY_PRIMITIVES).flat());
	for (const name of ['colorFlash', 'textWarp', 'bannerBurst']) {
		assert.ok(used.has(name), `${name} n'est composé par aucune famille`);
	}
});

t('acceptation #57 : aucune primitive demo scene hors événement (seul ritual.js les importe)', () => {
	const dir = new URL('../src/', import.meta.url);
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
		if (f === 'ritual.js' || f === 'hack-grammars.js') continue;
		const src = fs.readFileSync(new URL(f, dir), 'utf8');
		assert.doesNotMatch(src, /RITUAL_PRIMITIVES|FAMILY_PRIMITIVES/,
			`${f} référence les primitives demo scene hors rituel`);
	}
});

console.log(`\n${n} tests ritual OK`);
