// Selftest de la résolution des crédits fournisseur (issue #18). Pur.
// Lancer : node tools/provider-credit-selftest.mjs
import assert from 'node:assert/strict';
import { creditLines, creditText, LEGACY_PROVIDER } from '../src/provider-credit.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('manifest version 3 : rend l\'attribution du fournisseur', () => {
	assert.deepEqual(
		creditLines({ version: 3, provider: { id: 'google', label: 'Google', attribution: ['© Google', '© Airbus'] } }),
		['© Google', '© Airbus']);
});

// Les scènes déjà bakées n'ont pas de champ provider et ne doivent pas être
// re-préparées juste pour gagner une ligne de crédit.
t('manifest version 2 : retombe sur Flyover sans re-préparation', () => {
	assert.deepEqual(creditLines({ version: 2, chunks: [] }), LEGACY_PROVIDER.attribution);
	assert.ok(LEGACY_PROVIDER.attribution.length > 0);
	assert.equal(LEGACY_PROVIDER.id, 'flyover');
});

t('provider sans attribution utilisable : retombe sur le défaut', () => {
	assert.deepEqual(creditLines({ version: 3, provider: { id: 'flyover', attribution: [] } }),
		LEGACY_PROVIDER.attribution);
	assert.deepEqual(creditLines({ version: 3, provider: { id: 'flyover' } }),
		LEGACY_PROVIDER.attribution);
});

t('jamais de crash sur une entrée absurde', () => {
	for (const bad of [null, undefined, {}, { provider: null }, { provider: { attribution: 'nope' } }]) {
		const out = creditLines(bad);
		assert.ok(Array.isArray(out) && out.length > 0, `entrée: ${JSON.stringify(bad)}`);
	}
});

t('les lignes sont dédupliquées en préservant l\'ordre', () => {
	assert.deepEqual(
		creditLines({ version: 3, provider: { attribution: ['© A', '© B', '© A'] } }),
		['© A', '© B']);
});

t('creditText joint sur un séparateur médian', () => {
	assert.equal(creditText({ version: 3, provider: { attribution: ['© A', '© B'] } }), '© A · © B');
});

console.log(`\n${n} vérifications, tout passe.`);
