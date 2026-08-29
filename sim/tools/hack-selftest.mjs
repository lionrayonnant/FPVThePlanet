// Selftest des helpers purs de l'écran de hack (PHASE 09). Aucune E/S, aucun DOM.
// Lancer : node tools/hack-selftest.mjs
import assert from 'node:assert/strict';
import { HACK_TYPES, HACK_LOG_LINES, normalizeHackType } from './hack-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('HACK_LOG_LINES : verbatim Bible §18', () => {
	assert.deepEqual(HACK_LOG_LINES, [
		'AUTOMATED BYPASS ........ OK',
		'CONTROL CHANNEL ......... READY',
		'',
		'MANUAL OVERRIDE REQUIRED',
	]);
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
