// Selftest du contrat fournisseur (issue #18). Aucune E/S réseau, aucun DOM.
// Lancer : node tools/provider-selftest.mjs
import assert from 'node:assert/strict';
import * as registry from './lib/providers/index.mjs';
import { planScan, tileDirPath } from './lib/add-map-core.mjs';
// Pas appelé directement dans ce fichier : l'import seul est déjà un smoke test
// (un google-earth.mjs cassé ferait échouer le chargement du module avant même
// que le test de dispatch ci-dessous ne tourne).
import * as ge from './lib/providers/google-earth.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

t('registre : google-earth est le fournisseur par défaut, seul inscrit depuis le retrait d\'Apple Flyover (2026-09-07)', () => {
	assert.equal(registry.DEFAULT_PROVIDER_ID, 'google-earth');
	assert.equal(registry.get('google-earth').id, 'google-earth');
	assert.deepEqual(registry.list().map((p) => p.id), ['google-earth']);
});

t('registre : un id inconnu lève une erreur nommant les ids connus', () => {
	assert.throws(() => registry.get('nope'), /nope/);
	assert.throws(() => registry.get('nope'), /google-earth/);
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

// Task 7 (issue #18) : le dispatch d'add-map-core.mjs lit opts.provider plutôt
// que de câbler un fournisseur en dur. Avec un seul fournisseur inscrit
// aujourd'hui, ce test vérifie surtout ce qui compte encore : un id explicite
// résout au bon endroit, et un id inconnu REJETTE plutôt que de deviner.
await at('dispatch : opts.provider choisit le fournisseur', async () => {
	const opts = { lat: 48.86, lon: 2.35, zoom: 20, radius: 25, altitude: 20 };
	const p = await tileDirPath({ ...opts, provider: 'google-earth' });
	assert.match(p, /\.cache\/google-earth/);
	await assert.rejects(planScan({ ...opts, provider: 'inconnu' }), /fournisseur inconnu/);
});

console.log(`\n${n} vérifications, tout passe.`);
