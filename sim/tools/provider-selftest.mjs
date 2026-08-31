// Selftest du contrat fournisseur (issue #18). Aucune E/S réseau, aucun DOM.
// Lancer : node tools/provider-selftest.mjs
import assert from 'node:assert/strict';
import * as registry from './lib/providers/index.mjs';
import * as flyover from './lib/providers/flyover.mjs';
import { planScan, tileDirPath } from './lib/add-map-core.mjs';
// Pas appelé directement dans ce fichier : l'import seul est déjà un smoke test
// (un google-earth.mjs cassé ferait échouer le chargement du module avant même
// que le test de dispatch ci-dessous ne tourne).
import * as ge from './lib/providers/google-earth.mjs';

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
// désormais directement depuis lib/providers/flyover.mjs — tileDirName n'est
// plus sur la surface d'add-map-core.mjs (Task 7, issue #18 : le shim câblé
// Flyover meurt). On vérifie seulement que tileDirName reste asynchrone.
await at('flyover : tileDirName reste asynchrone', async () => {
	const direct = await flyover.tileDirName({ lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 });
	assert.equal(typeof direct, 'string');
});

// Task 7 (issue #18) : le shim d'add-map-core.mjs câblait plan/probe/tileDirPath
// sur Flyover sans regarder opts.provider. Avec deux fournisseurs inscrits,
// c'était /plan et /probe interrogeant Flyover pour une carte Google, et
// DELETE ?raw=1 orphelinant le cache Google. Ce test prouve que le dispatch
// regarde bien opts.provider.
await at('dispatch : opts.provider choisit le fournisseur, plus de câblage Flyover', async () => {
	// tileDirPath d'une même zone diffère par fournisseur : la preuve que le
	// shim est mort. (flyover -> downloaded_files/obj, google-earth -> .cache)
	const opts = { lat: 48.86, lon: 2.35, zoom: 20, radius: 25, altitude: 20 };
	const pFly = await tileDirPath({ ...opts, provider: 'flyover' });
	const pGe = await tileDirPath({ ...opts, provider: 'google-earth' });
	assert.notEqual(pFly, pGe);
	assert.match(pGe, /\.cache\/google-earth/);
	await assert.rejects(planScan({ ...opts, provider: 'inconnu' }), /fournisseur inconnu/);
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
