// Selftest du cache disque rocktree (lionrayonnant/FPVTP#296), en Node, avec des doublures de
// `caches` et `fetch` : la Cache API n'existe pas ici, et c'est justement le
// premier cas à couvrir (dégradation en fetch nu, sans erreur).
import assert from 'node:assert/strict';
import { createCachedFetch, CACHE_NAME } from '../src/rocktree-cache.js';

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

// Une doublure de Cache : Map insertion-ordered, comme les moteurs actuels.
function fakeCaches() {
	const store = new Map();
	const cache = {
		match: async (url) => store.get(url) ?? undefined,
		put: async (url, res) => { store.set(url, res); },
		keys: async () => [...store.keys()],
		delete: async (url) => store.delete(url),
	};
	const opened = [];
	return { store, opened, caches: { open: async (name) => { opened.push(name); return cache; } } };
}

// Une doublure de Response : ok, clone() rend un objet distinct, body lisible.
function fakeResponse(body, ok = true) {
	return { ok, body, clone() { return fakeResponse(body, ok); } };
}

await t('sans Cache API (Node, contexte non sécurisé) : fetch nu, aucune erreur', async () => {
	const calls = [];
	const { cachedFetch } = createCachedFetch({ caches: undefined, fetch: async (u) => { calls.push(u); return fakeResponse('a'); } });
	const r1 = await cachedFetch('https://x/1');
	const r2 = await cachedFetch('https://x/1');
	assert.equal(r1.body, 'a'); assert.equal(r2.body, 'a');
	assert.deepEqual(calls, ['https://x/1', 'https://x/1'], 'sans cache, chaque appel passe au réseau');
});

await t('un hit sert la réponse en cache sans toucher au réseau ; un miss la stocke', async () => {
	const { store, opened, caches } = fakeCaches();
	const calls = [];
	const { cachedFetch } = createCachedFetch({ caches, fetch: async (u) => { calls.push(u); return fakeResponse('n:' + u); } });
	const r1 = await cachedFetch('https://x/node/1');
	assert.equal(r1.body, 'n:https://x/node/1');
	assert.deepEqual(calls, ['https://x/node/1']);
	assert.ok(store.has('https://x/node/1'), 'la réponse est stockée sous son URL');
	const r2 = await cachedFetch('https://x/node/1');
	assert.equal(r2.body, 'n:https://x/node/1');
	assert.deepEqual(calls, ['https://x/node/1'], 'le second appel ne repasse pas au réseau');
	assert.deepEqual(opened, [CACHE_NAME], 'un seul open(), sous le nom versionné');
});

await t('une réponse non-ok (404 nœud absent, 5xx) n\'entre jamais dans le cache', async () => {
	const { store, caches } = fakeCaches();
	const { cachedFetch } = createCachedFetch({ caches, fetch: async () => fakeResponse('absent', false) });
	const r = await cachedFetch('https://x/node/404');
	assert.equal(r.ok, false);
	assert.equal(store.size, 0);
});

await t('l\'appelant reçoit l\'original, le cache un clone (un corps ne se lit qu\'une fois)', async () => {
	const { store, caches } = fakeCaches();
	const original = fakeResponse('o');
	const { cachedFetch } = createCachedFetch({ caches, fetch: async () => original });
	const r = await cachedFetch('https://x/1');
	assert.equal(r, original, 'l\'original revient à l\'appelant');
	assert.notEqual(store.get('https://x/1'), original, 'le cache tient un clone');
});

await t('un cache qui refuse (quota, open() en échec) dégrade en fetch nu, une fois pour toutes', async () => {
	let opens = 0;
	const caches = { open: async () => { opens++; throw new Error('quota'); } };
	const { cachedFetch } = createCachedFetch({ caches, fetch: async () => fakeResponse('a') });
	assert.equal((await cachedFetch('https://x/1')).body, 'a');
	assert.equal((await cachedFetch('https://x/2')).body, 'a');
	assert.equal(opens, 1, 'pas de retentative d\'ouverture à chaque requête');
	// put() qui lève : la réponse sert quand même.
	const { caches: c2, store } = fakeCaches();
	const fetched = createCachedFetch({ caches: { open: async () => ({ ...(await c2.open()), put: async () => { throw new Error('quota'); } }) }, fetch: async () => fakeResponse('b') });
	assert.equal((await fetched.cachedFetch('https://x/3')).body, 'b');
	assert.equal(store.size, 0);
});

await t('éviction : au-delà de maxEntries, les plus anciennes partent, par tranches', async () => {
	const { store, caches } = fakeCaches();
	const { cachedFetch, flush } = createCachedFetch({ caches, fetch: async (u) => fakeResponse(u), maxEntries: 10, pruneEvery: 5 });
	for (let i = 0; i < 20; i++) { await cachedFetch(`https://x/${i}`); await flush(); }
	// À la 15ᵉ écriture : 15 clés > 10, excédent 5 + tranche 5 = 10 retirées → 5 restent ;
	// à la 20ᵉ : 10 clés, pas d'excédent. Les plus anciennes sont parties.
	assert.ok(store.size <= 10, `${store.size} entrées pour un plafond de 10`);
	assert.ok(!store.has('https://x/0') && !store.has('https://x/4'), 'les plus anciennes ont été évincées');
	assert.ok(store.has('https://x/19'), 'la plus récente est là');
	// Une entrée évincée est refetchée, pas une erreur.
	const r = await cachedFetch('https://x/0');
	assert.equal(r.body, 'https://x/0');
});

console.log(`rocktree-cache-selftest : ${n} tests ok`);
