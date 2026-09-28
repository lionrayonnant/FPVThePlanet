// Selftest of operator resolution (loadOperator): fetch + localStorage stubbed.
// Run: node src/operator.selftest.mjs
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

// minimal fetch router: table { 'METHOD path': () => [status, body] }
function fakeFetch(table) {
	return async (url, opts = {}) => {
		const method = opts.method ?? 'GET';
		const path = new URL(url, 'http://x').pathname;
		const key = `${method} ${path}`;
		const entry = table[key];
		if (!entry) throw new Error(`fetch not stubbed: ${key}`);
		const [status, body] = entry(opts);
		return { ok: status < 400, status, json: async () => body };
	};
}

await t('no operator → bootstrap', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'GET /__operator': () => [200, { operators: [] }] }));
	const r = await op.loadOperator();
	assert.deepEqual(r, { operator: null, needsBootstrap: true, choices: null, needsKey: false });
});

await t('one operator, no local id → choices (no auto-adoption)', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'neo-1', name: 'Neo' }] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator, null);
	assert.deepEqual(r.choices, [{ id: 'neo-1', name: 'Neo' }]);
	assert.equal(store.getItem('fpvtp.operatorId'), null);
});

await t('several operators → choices', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator, null);
	assert.deepEqual(r.choices, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
});

await t('valid local id → loaded directly', async () => {
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: ['up', 'up', 'up', 'up'] } }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.operator.id, 'neo-1');
	assert.equal(op.getOperator().name, 'Neo');
});

await t('stale local id (404) → falls back to the list', async () => {
	const store = fakeStore({ 'fpvtp.operatorId': 'ghost-9' });
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator/ghost-9': () => [404, { error: 'nope' }],
		'GET /__operator': () => [200, { operators: [] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, true);
	assert.equal(store.getItem('fpvtp.operatorId'), null);
});

await t('createOperator stores the id and sets the cache', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'POST /__operator': () => [201, { operator: { id: 'vex-2', name: 'Vex', controlVector: [] } }],
	}));
	const s = await op.createOperator('Vex');
	assert.equal(s.id, 'vex-2');
	assert.equal(store.getItem('fpvtp.operatorId'), 'vex-2');
	assert.equal(op.getOperator().id, 'vex-2');
});

await t('createOperator passes the 400 on', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'POST /__operator': () => [400, { error: 'NAME REQUIRED' }] }));
	await assert.rejects(() => op.createOperator(''), /NAME REQUIRED/);
});

await t('patch + flush sends one coalesced PATCH', async () => {
	const calls = [];
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
		'PATCH /__operator/neo-1': (opts) => { calls.push(JSON.parse(opts.body)); return [200, { operator: {} }]; },
	}));
	await op.loadOperator();
	op.patch('controlVector', ['up', 'up', 'up', 'up']);
	op.patch('controlVector', ['down', 'down', 'down', 'down']);   // overwrites the previous one
	await op.flush();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { key: 'controlVector', value: ['down', 'down', 'down', 'down'] });
	assert.deepEqual(op.getOperator().controlVector, ['down', 'down', 'down', 'down']);
});

await t('flush throws when everything failed, then retries successfully', async () => {
	let fail = true;
	const calls = [];
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
		'PATCH /__operator/neo-1': (opts) => {
			calls.push(JSON.parse(opts.body));
			return fail ? [500, { error: 'disk full' }] : [200, { operator: {} }];
		},
	}));
	await op.loadOperator();
	op.patch('controlVector', ['up', 'up', 'up', 'up']);
	await assert.rejects(() => op.flush(), /disk full/);
	fail = false;
	await op.flush();                       // the re-queued value goes through this time
	assert.equal(calls.length, 2);
	assert.deepEqual(op.getOperator().controlVector, ['up', 'up', 'up', 'up']);
});

await t('keepTerrain: a direct POST, not a debounced patch', async () => {
	const calls = [];
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', terrainCache: [] } }],
		'POST /__operator/neo-1/terrain-cache': (opts) => {
			calls.push(JSON.parse(opts.body));
			return [200, { operator: { id: 'neo-1', name: 'Neo', terrainCache: [{ slug: 'tokyo' }] } }];
		},
	}));
	await op.loadOperator();
	const updated = await op.keepTerrain('tokyo');
	assert.deepEqual(calls, [{ slug: 'tokyo' }]);
	assert.deepEqual(updated.terrainCache, [{ slug: 'tokyo' }]);
	assert.deepEqual(op.getOperator().terrainCache, [{ slug: 'tokyo' }]);
});

await t('keepTerrain: passes the server error on', async () => {
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo' } }],
		'POST /__operator/neo-1/terrain-cache': () => [404, { error: 'no map "tokyo"' }],
	}));
	await op.loadOperator();
	await assert.rejects(() => op.keepTerrain('tokyo'), /no map/);
});

// --- the operator key (issue #60) ------------------------------------------
//
// A technical mechanism, distinct from the Control Vector (Bible §33): it
// tells a `shared` server who is speaking, nothing more.

await t('createOperator keeps the key SILENTLY — nothing to write down, nothing to click', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'POST /__operator': () => [201, { operator: { id: 'vex-2', name: 'Vex' }, key: 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE' }],
	}));
	await op.createOperator('Vex');
	assert.equal(store.getItem('fpvtp.operatorKey'), 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE');
	assert.equal(op.hasKey(), true);
	assert.equal(op.getKey(), 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE', 'readable back by [ SHOW KEY ], and by it alone');
	// No "consume once" API: the YOUR OPERATOR KEY screen does not exist.
	assert.equal(op.takeIssuedKey, undefined);
});

await t('every request carries the key as a Bearer', async () => {
	const seen = [];
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1', 'fpvtp.operatorKey': 'AAAA-BBBB' }));
	op._setFetch(async (url, opts = {}) => {
		seen.push(opts.headers?.authorization ?? null);
		return { ok: true, status: 200, json: async () => ({ operator: { id: 'neo-1', name: 'Neo' } }) };
	});
	await op.loadOperator();
	assert.deepEqual(seen, ['Bearer AAAA-BBBB']);
});

await t('401 on one\'s operator → needsKey, and nothing left locally', async () => {
	const store = fakeStore({ 'fpvtp.operatorId': 'neo-1', 'fpvtp.operatorKey': 'STALE' });
	op._setStore(store);
	op._setFetch(fakeFetch({ 'GET /__operator/neo-1': () => [401, { error: 'operator key required' }] }));
	const r = await op.loadOperator();
	assert.equal(r.needsKey, true);
	assert.equal(r.needsBootstrap, false);
	assert.equal(store.getItem('fpvtp.operatorId'), null);
	assert.equal(store.getItem('fpvtp.operatorKey'), null);
});

await t('403 on one\'s operator → needsKey too', async () => {
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1', 'fpvtp.operatorKey': 'WRONG' }));
	op._setFetch(fakeFetch({ 'GET /__operator/neo-1': () => [403, { error: 'bad operator key' }] }));
	assert.equal((await op.loadOperator()).needsKey, true);
});

await t('404 on the LIST → needsKey: a server that publishes none', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'GET /__operator': () => [404, { error: 'no operator directory on this server' }] }));
	const r = await op.loadOperator();
	assert.equal(r.needsKey, true);
	assert.equal(r.needsBootstrap, false, 'above all NOT a bootstrap: the list may exist, we are not allowed to read it');
});

await t('resumeWithKey: the key designates the operator, whoami returns it', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator/whoami': (o) => (o.headers?.authorization === 'Bearer GOOD-KEY'
			? [200, { operator: { id: 'neo-1', name: 'Neo' } }]
			: [403, { error: 'bad operator key' }]),
	}));
	const s = await op.resumeWithKey('GOOD-KEY');
	assert.equal(s.id, 'neo-1');
	assert.equal(store.getItem('fpvtp.operatorId'), 'neo-1');
	assert.equal(store.getItem('fpvtp.operatorKey'), 'GOOD-KEY');
});

await t('resumeWithKey: a wrong key throws and does not replace the old one', async () => {
	const store = fakeStore({ 'fpvtp.operatorKey': 'OLDKEY' });
	op._setStore(store);
	op._setFetch(fakeFetch({ 'GET /__operator/whoami': () => [403, { error: 'bad operator key' }] }));
	await assert.rejects(() => op.resumeWithKey('N1MPORTEQU01'), /bad operator key/);
	assert.equal(store.getItem('fpvtp.operatorKey'), 'OLDKEY');
});

// --- one session photo (issue #185) ---------------------------------------

await t('fetchPhoto: the session id and index are URL-encoded path segments', async () => {
	const seen = [];
	op._setStore(fakeStore({ 'fpvtp.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({ 'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo' } }] }));
	await op.loadOperator();
	op._setFetch(async (url) => { seen.push(url); return { ok: false, status: 404 }; });
	assert.equal(await op.fetchPhoto('a/../b?x=1', 2), null, 'a refused photo is null, not a throw');
	assert.deepEqual(seen, ['/__operator/neo-1/sessions/a%2F..%2Fb%3Fx%3D1/photos/2']);
});

console.log(`\n${n} tests OK`);
