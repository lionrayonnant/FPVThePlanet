// Selftest des helpers purs de l'écran de hack (PHASE 09). Aucune E/S, aucun DOM.
// Lancer : node tools/hack-selftest.mjs
import assert from 'node:assert/strict';
import {
	HACK_TYPES, HACK_OVERRIDE, HACK_VOCAB, normalizeHackType,
	hackSequence, hackSequenceMs,
} from './hack-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('HACK_OVERRIDE : verbatim Bible §18', () => {
	assert.equal(HACK_OVERRIDE, 'MANUAL OVERRIDE REQUIRED');
});

t('hackSequence : tête et queue fixes pour toute famille', () => {
	for (const h of HACK_TYPES) {
		const seq = hackSequence(h);
		assert.deepEqual(seq[0], { label: 'AUTOMATED BYPASS', verdict: 'OK', dwellMs: 1200 });
		assert.deepEqual(seq.at(-1), { label: 'CONTROL CHANNEL', verdict: 'READY', dwellMs: 1100 });
		assert.equal(seq.length, 4, `${h} : tête + 2 beats + queue`);
	}
});

t('hackSequence : type inconnu → tête + queue seulement', () => {
	assert.equal(hackSequence('NOPE').length, 2);
});

t('hackSequenceMs : dans une fourchette de quelques secondes par famille', () => {
	for (const h of HACK_TYPES) {
		const ms = hackSequenceMs(h);
		assert.ok(ms >= 3500 && ms <= 5000, `${h} : ${ms} ms hors fourchette`);
	}
});

t('sûreté : chaque mot d\'un label/verdict appartient à la liste blanche', () => {
	for (const h of HACK_TYPES) {
		for (const step of hackSequence(h)) {
			for (const word of `${step.label} ${step.verdict}`.split(/\s+/)) {
				assert.ok(HACK_VOCAB.has(word), `${h} : mot hors liste blanche "${word}"`);
			}
		}
	}
	for (const word of HACK_OVERRIDE.split(/\s+/)) {
		assert.ok(HACK_VOCAB.has(word), `HACK_OVERRIDE : mot hors liste blanche "${word}"`);
	}
});

t('normalizeHackType : tolère tirets, underscores, casse, espaces', () => {
	assert.equal(normalizeHackType('GNSS SPOOF'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('gnss-spoof'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('gnss_spoof'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('  Gnss   Spoof '), 'GNSS SPOOF');
	assert.equal(normalizeHackType('command-injection'), 'COMMAND INJECTION');
	assert.equal(normalizeHackType('firmware-override'), 'FIRMWARE OVERRIDE');
});

t('normalizeHackType : inconnu → null', () => {
	assert.equal(normalizeHackType('nope'), null);
	assert.equal(normalizeHackType(''), null);
	assert.equal(normalizeHackType(undefined), null);
	assert.equal(normalizeHackType('gnss'), null);
});

t('chaque HACK_TYPES a une forme slug qui round-trip', () => {
	for (const h of HACK_TYPES) {
		assert.equal(normalizeHackType(h.toLowerCase().replace(/ /g, '-')), h);
	}
});

console.log(`\n${n} tests hack OK`);
