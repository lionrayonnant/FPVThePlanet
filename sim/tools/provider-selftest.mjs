// Selftest du contrat fournisseur (issue #18). Aucune E/S réseau, aucun DOM.
// Lancer : node tools/provider-selftest.mjs
import assert from 'node:assert/strict';
import * as registry from './lib/providers/index.mjs';
import * as flyover from './lib/providers/flyover.mjs';
import * as core from './lib/add-map-core.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
// Variante asynchrone : tileDirName attend polyHash. Même convention que
// map-poly-selftest.mjs.
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

t('registre : google-earth est le fournisseur par défaut (design #18, Stage 3 livré)', () => {
	assert.equal(registry.DEFAULT_PROVIDER_ID, 'google-earth');
	assert.equal(registry.get('google-earth').id, 'google-earth');
});

t('registre : un id inconnu lève une erreur nommant les ids connus', () => {
	assert.throws(() => registry.get('nope'), /nope/);
	assert.throws(() => registry.get('nope'), /flyover/);
});

t('contrat : chaque fournisseur expose la surface attendue', () => {
	for (const p of registry.list()) {
		assert.equal(typeof p.id, 'string', 'id');
		assert.equal(typeof p.label, 'string', 'label');
		assert.ok(Array.isArray(p.attribution), 'attribution est un tableau');
		assert.ok(p.attribution.length > 0, 'attribution non vide');
		for (const fn of ['tileDirPath', 'plan', 'probe', 'fetch']) {
			assert.equal(typeof p[fn], 'function', `${p.id}.${fn}`);
		}
	}
});

// La stabilité des clés de cache elles-mêmes est déjà couverte par
// map-poly-selftest.mjs (les trois formes : poly, radius, bbox), qui les importe
// depuis add-map-core.mjs. On ne la duplique pas ici : on vérifie seulement que
// l'extraction n'a pas rompu le chemin d'import ni l'asynchronisme.
await at('flyover : tileDirName reste asynchrone et traverse la ré-export', async () => {
	const direct = await flyover.tileDirName({ lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 });
	const viaCore = await core.tileDirName({ lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 });
	assert.equal(direct, viaCore, 'la ré-export doit rendre exactement la même clé');
	assert.equal(typeof direct, 'string');
});

await at('flyover : les trois modes de zone donnent trois clés distinctes', async () => {
	const base = { zoom: 20, altitude: 20 };
	const keys = await Promise.all([
		flyover.tileDirName({ ...base, lat: 48.8582, lon: 2.297, radius: 25 }),
		flyover.tileDirName({ ...base, bbox: { south: 48.85, west: 2.29, north: 48.86, east: 2.30 } }),
		flyover.tileDirName({ ...base, poly: [48.85, 2.29, 48.86, 2.29, 48.86, 2.30] }),
	]);
	assert.equal(new Set(keys).size, 3, `clés en collision : ${keys.join(' / ')}`);
});

console.log(`\n${n} vérifications, tout passe.`);
