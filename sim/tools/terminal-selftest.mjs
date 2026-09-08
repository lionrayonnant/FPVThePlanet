// Selftest de la logique pure de l'Operator Terminal. Aucune E/S.
// Lancer : node tools/terminal-selftest.mjs
import assert from 'node:assert/strict';
import { formatBytes, terminalModel } from './terminal-model.mjs';
import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { NOTES } from './buildnotes-model.mjs';

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
	assert.equal(m.build, NOTES[0].build);
	// D1 : le pied ne compte plus rien. L'opérateur et ses compteurs vivent dans
	// ARCHIVE › OPERATOR, qui est leur place.
	assert.equal(m.footer, `LOCAL INSTALLATION · BUILD ${NOTES[0].build}`);
});

t('terminalModel : compteurs et dernière session', () => {
	const operator = {
		name: 'Vex',
		// Alimente countersOf (BUILD NOTES, PHASE 21) : compteur terrains distinct
		// de la liste `scenes` passée au modèle, qui pilote seulement `areas`.
		terrainCache: [{ slug: 'tour-eiffel' }, { slug: 'sacre-coeur' }],
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
	assert.equal(m.build, NOTES[4].build);
	assert.equal(m.footer, `LOCAL INSTALLATION · BUILD ${NOTES[4].build}`);
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
	assert.equal(m.build, NOTES[0].build);
	assert.equal(m.footer, `LOCAL INSTALLATION · BUILD ${NOTES[0].build}`);
});

// D1/D2 : le pied dit d'abord OÙ le jeu tourne — le MODE du serveur, pas le
// droit d'acquérir (V1). Toute build distribuée a l'acquisition fermée et reste
// une installation locale.
t('terminalModel : le pied nomme l\'installation', () => {
	const m = terminalModel({ operator: { name: 'Neo' }, scenes: [], shared: true });
	assert.equal(m.footer, `SHARED SERVER · BUILD ${NOTES[0].build}`);
	// Aucun compteur, aucun nom : ils sont dans ARCHIVE.
	for (const gone of ['OPERATOR', 'LOCAL AREAS', 'SESSIONS', 'TARGETS LOGGED']) {
		assert.doesNotMatch(m.footer, new RegExp(gone));
	}
	// V1: acquisition closed on a LOCAL server is the default of every
	// distributed build — it is still a local installation.
	const local = terminalModel({ operator: { name: 'Neo' }, scenes: [], shared: false });
	assert.equal(local.footer, `LOCAL INSTALLATION · BUILD ${NOTES[0].build}`);
});

t('terminalModel : opérateur sans nom', () => {
	const m = terminalModel({ operator: {}, scenes: [] });
	assert.equal(m.operatorName, 'UNKNOWN');
});

console.log(`\n${n} tests terminal-model OK`);
