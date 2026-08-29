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

// Retour de revue (issue #18) : le repli Apple était calculé sans jamais
// regarder provider.id, donc un fournisseur non-legacy sans attribution se
// faisait créditer à Apple. Un provider.id différent doit produire un repli
// générique dérivé de son propre label — jamais « © Apple ».
t('provider google sans attribution utilisable : repli générique, jamais Apple', () => {
	const lines = creditLines({ version: 3, provider: { id: 'google', label: 'Google', attribution: [] } });
	assert.ok(lines.length > 0, 'ne doit jamais rendre un tableau vide');
	assert.ok(!lines.some((l) => /apple/i.test(l)), `ne doit pas citer Apple : ${lines}`);
	assert.ok(lines.some((l) => /google/i.test(l)), `doit dériver du label du fournisseur : ${lines}`);
});

t('provider google sans label ni attribution : repli sur l\'id, toujours pas Apple', () => {
	const lines = creditLines({ version: 3, provider: { id: 'google' } });
	assert.ok(lines.length > 0);
	assert.ok(!lines.some((l) => /apple/i.test(l)), `ne doit pas citer Apple : ${lines}`);
	assert.ok(lines.some((l) => /google/i.test(l)), `doit dériver de l'id à défaut de label : ${lines}`);
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
