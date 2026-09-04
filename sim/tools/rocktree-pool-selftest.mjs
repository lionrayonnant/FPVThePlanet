// Selftest du pool de Workers rocktree (#179) : la file d'attente et le
// plafond de requêtes en vol. Faux Worker injecté par createPool() — le vrai
// n'existe pas sous Node, et de toute façon ce qui est testé ici est la
// politique de dispatch, pas le fetch.
import assert from 'node:assert/strict';
import { createPool } from '../src/rocktree-worker-pool.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

class FakeWorker {
	// `sink` est le journal de dispatch PARTAGÉ du pool : concaténer les
	// `posted` de chaque worker perdrait l'entrelacement, c'est-à-dire
	// justement l'ordre qu'on veut vérifier.
	constructor(sink) { this.posted = []; this.sink = sink; this.onmessage = null; this.onerror = null; }
	postMessage(msg) { this.posted.push(msg); this.sink.push(msg); }
	// Réponse du worker, telle que rocktree-worker.js la formule.
	reply(id, extra = {}) { this.onmessage({ data: { id, ok: true, matrix: null, copyrightIds: [], meshes: [], ...extra } }); }
	fail(id, error, status = null) { this.onmessage({ data: { id, ok: false, error, status } }); }
	crash(message) { this.onerror({ message }); }
}

// Un pool de test : `size` faux workers, dont on inspecte les postMessage.
const makeTestPool = (size, maxInFlight) => {
	const workers = [], sink = [];
	const pool = createPool({ makeWorker: () => { const w = new FakeWorker(sink); workers.push(w); return w; }, size, maxInFlight });
	// Les requêtes portent un path reconnaissable ; le reste du descripteur
	// n'intervient pas dans le dispatch.
	const send = (path, opts) => pool.fetchNode({ path, epoch: 1, imageryEpoch: 1, flags: 0 }, opts);
	const postedPaths = () => sink.map((m) => m.path);
	return { pool, workers, send, postedPaths };
};

t('plafond : rien au-delà de size × maxInFlight n\'est posté, et rien n\'est perdu', () => {
	const { workers, send, postedPaths } = makeTestPool(2, 3);
	const promises = Array.from({ length: 10 }, (_, i) => send(`n${i}`).catch(() => {}));
	assert.equal(postedPaths().length, 6, 'capacité dépassée ou sous-utilisée');
	for (const w of workers) assert.ok(w.posted.length <= 3, `worker à ${w.posted.length} requêtes en vol`);

	// Chaque réponse libère exactement une place.
	workers[0].reply(workers[0].posted[0].id);
	assert.equal(postedPaths().length, 7);
	assert.equal(promises.length, 10);
});

t('ordre : la file est FIFO, le tri par distance de la fenêtre est donc respecté', () => {
	const { workers, send, postedPaths } = makeTestPool(2, 2);
	for (let i = 0; i < 8; i++) send(`n${i}`).catch(() => {});
	assert.deepEqual(postedPaths(), ['n0', 'n1', 'n2', 'n3']);
	// Vide la capacité dans l'ordre où elle a été prise : la suite doit sortir
	// dans l'ordre d'arrivée, pas dans celui des réponses.
	for (const w of workers) for (const m of [...w.posted]) w.reply(m.id);
	assert.deepEqual(postedPaths(), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
});

t('annulation en file : le nœud abandonné ne coûte AUCUN fetch', async () => {
	const { workers, send, postedPaths } = makeTestPool(1, 2);
	const c = new AbortController();
	const kept = [send('n0'), send('n1')].map((p) => p.catch(() => {}));
	const dropped = send('n2', { signal: c.signal });
	send('n3').catch(() => {});
	assert.deepEqual(postedPaths(), ['n0', 'n1'], 'préparation : n2/n3 doivent être en file');

	c.abort();
	await assert.rejects(dropped, (e) => e.name === 'AbortError');
	for (const m of [...workers[0].posted]) workers[0].reply(m.id);
	assert.deepEqual(postedPaths(), ['n0', 'n1', 'n3'], 'n2 a été posté alors qu\'il était annulé');
	assert.equal(kept.length, 2);
});

t('annulation en vol : la place n\'est rendue qu\'à la réponse, et le bitmap est fermé', async () => {
	const { workers, send, postedPaths } = makeTestPool(1, 1);
	const c = new AbortController();
	const dropped = send('n0', { signal: c.signal });
	send('n1').catch(() => {});
	assert.deepEqual(postedPaths(), ['n0']);

	c.abort();
	await assert.rejects(dropped, (e) => e.name === 'AbortError');
	// Le worker travaille toujours : tant qu'il n'a pas répondu, sa place est
	// prise. La rendre plus tôt ferait poster une requête de trop.
	assert.deepEqual(postedPaths(), ['n0'], 'place rendue avant la réponse du worker');

	let closed = 0;
	workers[0].reply(workers[0].posted[0].id, { meshes: [{ bitmap: { close: () => { closed++; } } }] });
	assert.equal(closed, 1, 'ImageBitmap d\'une réponse orpheline non fermé');
	assert.deepEqual(postedPaths(), ['n0', 'n1']);
});

t('panne d\'un worker : ses requêtes en vol sont rejetées ET ses places rendues', async () => {
	const { workers, send, postedPaths } = makeTestPool(2, 1);
	const a = send('n0'), b = send('n1');
	send('n2').catch(() => {});
	send('n3').catch(() => {});
	assert.equal(postedPaths().length, 2);

	workers[0].crash('boom');
	await assert.rejects(workers[0].posted[0].path === 'n0' ? a : b, /rocktree worker: boom/);
	// La capacité perdue serait définitive si onerror ne vidait pas inflight.
	assert.equal(postedPaths().length, 3, 'place non rendue après la panne');
	assert.equal(workers[1].posted.length, 1, 'l\'autre worker ne doit pas avoir été touché');
});

t('corrélation : chaque réponse va à SA promesse, succès comme échec', async () => {
	const { workers, send } = makeTestPool(1, 4);
	const ok = send('n0'), ko = send('n1');
	const [m0, m1] = workers[0].posted;
	workers[0].fail(m1.id, '404 https://example/n1', 404);
	workers[0].reply(m0.id, { matrix: [1], copyrightIds: [7] });
	assert.deepEqual((await ok).copyrightIds, [7]);
	await assert.rejects(ko, (e) => e.status === 404 && /404/.test(e.message));
});

t('stats() : file, requêtes en vol et capacité, pour la calibration (#179 point 3)', () => {
	const { pool, workers, send } = makeTestPool(2, 2);
	for (let i = 0; i < 7; i++) send(`n${i}`).catch(() => {});
	assert.deepEqual(pool.stats(), { queued: 3, inFlight: 4, capacity: 4 });
	workers[0].reply(workers[0].posted[0].id);
	assert.deepEqual(pool.stats(), { queued: 2, inFlight: 4, capacity: 4 });
});

console.log(`rocktree-pool-selftest : ${n} tests ok`);
