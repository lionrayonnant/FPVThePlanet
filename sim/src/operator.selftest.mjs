// Selftest de la résolution d'opérateur (loadOperator) : fetch + localStorage stubbés.
// Lancer : node src/operator.selftest.mjs
import assert from 'node:assert/strict';
import * as op from './operator.js';

let n = 0;
const t = (name, fn) => fn().then(() => { n++; console.log(`  ok  ${name}`); });

function fakeStore(init = {}) {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
		_dump: () => Object.fromEntries(m),
	};
}

// routeur fetch minimal : table { 'METHOD path': () => [status, body] }
function fakeFetch(table) {
	return async (url, opts = {}) => {
		const method = opts.method ?? 'GET';
		const path = new URL(url, 'http://x').pathname;
		const key = `${method} ${path}`;
		const entry = table[key];
		if (!entry) throw new Error(`fetch non stubbé : ${key}`);
		const [status, body] = entry(opts);
		return { ok: status < 400, status, json: async () => body };
	};
}

await t('aucun opérateur → bootstrap', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'GET /__operator': () => [200, { operators: [] }] }));
	const r = await op.loadOperator();
	assert.deepEqual(r, { operator: null, needsBootstrap: true, choices: null });
});

await t('un opérateur → adopté', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'neo-1', name: 'Neo' }] }],
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator.id, 'neo-1');
	assert.equal(store.getItem('fpvmaps.operatorId'), 'neo-1');
});

await t('plusieurs opérateurs → choices', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator, null);
	assert.deepEqual(r.choices, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
});

await t('id local valide → chargé direct', async () => {
	op._setStore(fakeStore({ 'fpvmaps.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: ['up', 'up', 'up', 'up'] } }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.operator.id, 'neo-1');
	assert.equal(op.getOperator().name, 'Neo');
});

await t('id local périmé (404) → repli sur la liste', async () => {
	const store = fakeStore({ 'fpvmaps.operatorId': 'ghost-9' });
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator/ghost-9': () => [404, { error: 'nope' }],
		'GET /__operator': () => [200, { operators: [] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, true);
	assert.equal(store.getItem('fpvmaps.operatorId'), null);
});

await t('createOperator stocke l’id et met le cache', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'POST /__operator': () => [201, { operator: { id: 'vex-2', name: 'Vex', controlVector: [] } }],
	}));
	const s = await op.createOperator('Vex');
	assert.equal(s.id, 'vex-2');
	assert.equal(store.getItem('fpvmaps.operatorId'), 'vex-2');
	assert.equal(op.getOperator().id, 'vex-2');
});

await t('createOperator propage l’erreur 400', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'POST /__operator': () => [400, { error: 'NAME REQUIRED' }] }));
	await assert.rejects(() => op.createOperator(''), /NAME REQUIRED/);
});

await t('patch + flush envoie un PATCH coalescé', async () => {
	const calls = [];
	op._setStore(fakeStore({ 'fpvmaps.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
		'PATCH /__operator/neo-1': (opts) => { calls.push(JSON.parse(opts.body)); return [200, { operator: {} }]; },
	}));
	await op.loadOperator();
	op.patch('controlVector', ['up', 'up', 'up', 'up']);
	op.patch('controlVector', ['down', 'down', 'down', 'down']);   // écrase le précédent
	await op.flush();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { key: 'controlVector', value: ['down', 'down', 'down', 'down'] });
	assert.deepEqual(op.getOperator().controlVector, ['down', 'down', 'down', 'down']);
});

console.log(`\n${n} tests OK`);
