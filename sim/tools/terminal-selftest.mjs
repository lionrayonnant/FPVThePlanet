// Selftest de la logique pure de l'Operator Terminal. Aucune E/S.
// Lancer : node tools/terminal-selftest.mjs
import assert from 'node:assert/strict';
import { formatBytes, terminalModel } from './terminal-model.mjs';
import { generateTargetScan, resolveTarget } from './target-model.mjs';

const TGT = resolveTarget(generateTargetScan({ seed: 'terminal-seed', count: 3 }), 0);

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('formatBytes : bornes et unités', () => {
	assert.equal(formatBytes(0), '—');
	assert.equal(formatBytes(null), '—');
	assert.equal(formatBytes(undefined), '—');
	assert.equal(formatBytes(NaN), '—');
	assert.equal(formatBytes(-5), '—');
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(2048), '2 KB');
	assert.equal(formatBytes(3_400_000), '3 MB');
	assert.equal(formatBytes(1_250_000_000), '1.3 GB');
});

t('terminalModel : opérateur neuf, cache vide', () => {
	const m = terminalModel({ operator: { name: 'Neo' }, scenes: [] });
	assert.equal(m.operatorName, 'NEO');
	assert.deepEqual(m.areas, []);
	assert.equal(m.areasKnown, true);
	assert.equal(m.lastSession, null);
	assert.equal(m.footer, 'LOCAL INSTALLATION · OPERATOR NEO · 0 LOCAL AREAS · 0 SESSIONS · 0 TARGETS LOGGED');
});

t('terminalModel : compteurs et dernière session', () => {
	const operator = {
		name: 'Vex',
		// Le Target Log est dérivé des sessions (PHASE 17, spec D1) : la troisième
		// session n'a pas de cible, elle ne compte donc pas comme cible loguée.
		sessions: [
			{ id: 'a', seq: 1, target: TGT, targetSeq: 1 },
			{ id: 'b', area: 'tour-eiffel', seq: 2, target: TGT, targetSeq: 2 },
			{ id: 'c', area: 'tour-eiffel', seq: 3, target: null },
		],
	};
	const scenes = [
		{ slug: 'tour-eiffel', name: 'Tour Eiffel', bytes: 812_000_000 },
		{ slug: 'sacre-coeur', name: 'Sacré-Cœur', bytes: null },
	];
	const m = terminalModel({ operator, scenes });
	assert.equal(m.footer, 'LOCAL INSTALLATION · OPERATOR VEX · 2 LOCAL AREAS · 3 SESSIONS · 2 TARGETS LOGGED');
	assert.deepEqual(m.areas, [
		{ slug: 'tour-eiffel', name: 'Tour Eiffel', size: '812 MB' },
		{ slug: 'sacre-coeur', name: 'Sacré-Cœur', size: '—' },
	]);
	assert.equal(m.lastSession.id, 'c');
});

t('terminalModel : cache terrain injoignable', () => {
	const m = terminalModel({ operator: { name: 'Neo' }, scenes: null });
	assert.equal(m.areasKnown, false);
	assert.deepEqual(m.areas, []);
	assert.equal(m.footer, 'LOCAL INSTALLATION · OPERATOR NEO · ? LOCAL AREAS · 0 SESSIONS · 0 TARGETS LOGGED');
});

t('terminalModel : opérateur sans nom', () => {
	const m = terminalModel({ operator: {}, scenes: [] });
	assert.equal(m.operatorName, 'UNKNOWN');
});

console.log(`\n${n} tests terminal-model OK`);
