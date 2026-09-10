// Selftest des files du mode live (#75) : ordre du drain, budget, et surtout
// le moment des échanges et des libérations de nœuds « couverts » par un
// autre niveau — l'ancienne image reste intacte jusqu'à la vague complète.
import assert from 'node:assert/strict';
import { LiveNodeQueue, NODE_WORK_BUDGET_MS, DEEP_QUEUE_BUDGET_MS, DEEP_QUEUE_JOBS, WAVE_STALL_MS } from '../src/live-node-queue.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Horloge sous contrôle : chaque lecture avance d'1 ms, un budget de N ms
// permet donc N-1 opérations par drain.
function harness({ pending = 0 } = {}) {
	const q = new LiveNodeQueue();
	const log = [];
	let clock = 0;
	const drain = (opts = {}) => q.drain({
		budgetMs: 1000,
		pendingFetches: () => pending,
		build: (p) => log.push(`build ${p}`),
		dispose: (p) => log.push(`dispose ${p}`),
		now: () => clock++,
		...opts,
	});
	return { q, log, drain, setPending: (v) => { pending = v; }, jump: (ms) => { clock += ms; } };
}

t('les libérations passent avant les builds frais', () => {
	const { q, log, drain } = harness();
	q.queueBuild('a', {});
	q.queueRelease('b');
	drain();
	assert.deepEqual(log, ['dispose b', 'build a']);
	assert.equal(q.idle(), true);
});

t('le budget borne le travail d\'une frame, le reste attend la suivante', () => {
	const { q, log, drain } = harness();
	for (const p of ['a', 'b', 'c', 'd', 'e']) q.queueBuild(p, {});
	drain({ budgetMs: 4 });
	assert.deepEqual(log, ['build a', 'build b', 'build c']);
	assert.equal(q.builds.size, 2);
	assert.equal(q.idle(), false);
});

t('budget adaptatif : profond au-delà de DEEP_QUEUE_JOBS, échanges compris', () => {
	const q = new LiveNodeQueue();
	assert.equal(q.budgetMs(), NODE_WORK_BUDGET_MS);
	for (let i = 0; i <= DEEP_QUEUE_JOBS; i++) q.queueBuild(String(i), {}, { swap: i % 2 === 0 });
	assert.equal(q.budgetMs(), DEEP_QUEUE_BUDGET_MS);
});

t('les builds frais sont posés au fil de l\'eau, même avec des fetchs en vol', () => {
	const { q, log, drain } = harness({ pending: 200 });
	q.queueBuild('new1', {});
	drain();
	assert.deepEqual(log, ['build new1']);
});

t('#75 : les couverts NE sont PAS libérés tant que des fetchs sont en vol, même builds vides', () => {
	// Le cas exact du recentrage : la fenêtre a libéré (synchrone), les
	// fetchs de la vague n'ont pas encore répondu, la file de builds est vide.
	const { q, log, drain } = harness({ pending: 200 });
	q.queueCovered('old1');
	q.queueCovered('old2');
	drain();
	assert.deepEqual(log, []);
	assert.equal(q.covered.size, 2);
	q.queueBuild('new1', {});
	drain();
	assert.deepEqual(log, ['build new1']);
	assert.equal(q.covered.size, 2);
});

t('#75 : un échange (mesh déjà à l\'écran) attend la vague complète', () => {
	// Le grossier rebâti avec un octant en moins ne doit pas être posé avant
	// l'enfant fin qui redessine cet octant.
	const { q, log, drain, setPending } = harness({ pending: 1 });
	q.queueBuild('coarse', {}, { swap: true });
	drain();
	assert.deepEqual(log, []);
	q.queueBuild('child', {});
	drain();
	assert.deepEqual(log, ['build child']);
	setPending(0);
	drain();
	assert.deepEqual(log, ['build child', 'build coarse']);
	assert.equal(q.idle(), true);
});

t('#75 : vague complète = échanges puis libération des couverts, dans cet ordre', () => {
	const { q, log, drain, setPending } = harness({ pending: 1 });
	q.queueCovered('old1');
	q.queueBuild('swap1', {}, { swap: true });
	q.queueBuild('new1', {});
	drain();
	assert.deepEqual(log, ['build new1']);
	setPending(0);
	drain();
	assert.deepEqual(log, ['build new1', 'build swap1', 'dispose old1']);
	assert.equal(q.idle(), true);
});

t('un build qui reconstruit un couvert (demi-tour) le sort des couverts', () => {
	const { q, log, drain, setPending } = harness({ pending: 1 });
	q.queueCovered('x');
	q.queueBuild('x', {}, { swap: true });
	drain();
	setPending(0);
	drain();
	// Le mesh neuf de x n'est jamais retiré par le vidage des couverts.
	assert.deepEqual(log, ['build x']);
});

t('queueCovered jette un build en file : un build posé après la libération de son entrée serait orphelin', () => {
	const { q, log, drain } = harness({ pending: 0 });
	q.queueBuild('a', {});
	q.queueCovered('a');
	drain();
	assert.deepEqual(log, ['dispose a']);
});

t('queueRelease jette un build ou un échange en file, et sort des couverts', () => {
	const { q, log, drain } = harness({ pending: 5 });
	q.queueBuild('a', {});
	q.queueBuild('b', {}, { swap: true });
	q.queueCovered('c');
	q.queueRelease('a'); q.queueRelease('b'); q.queueRelease('c');
	drain();
	assert.deepEqual(log, ['dispose a', 'dispose b', 'dispose c']);
	assert.equal(q.idle(), true);
});

t('dropBuild dit s\'il y avait un build ou un échange en file', () => {
	const q = new LiveNodeQueue();
	q.queueBuild('a', {});
	q.queueBuild('b', {}, { swap: true });
	assert.equal(q.dropBuild('a'), true);
	assert.equal(q.dropBuild('a'), false);
	assert.equal(q.dropBuild('b'), true);
});

t('un même couvert signalé deux fois n\'est libéré qu\'une fois', () => {
	const { q, log, drain } = harness({ pending: 0 });
	q.queueCovered('x');
	q.queueCovered('x');
	drain();
	assert.deepEqual(log, ['dispose x']);
});

t('soupape : une vague qui ne finit jamais est échangée après WAVE_STALL_MS', () => {
	const { q, log, drain, jump } = harness({ pending: 50 });
	q.queueCovered('old');
	q.queueBuild('swap', {}, { swap: true });
	drain();
	assert.deepEqual(log, []);
	jump(WAVE_STALL_MS - 100);
	drain();
	assert.deepEqual(log, [], 'pas encore');
	jump(200);
	drain();
	assert.deepEqual(log, ['build swap', 'dispose old']);
	// Et l'attente repart de zéro pour la vague suivante.
	q.queueCovered('old2');
	drain();
	assert.deepEqual(log, ['build swap', 'dispose old']);
});

console.log(`live-node-queue-selftest : ${n} tests ok`);
