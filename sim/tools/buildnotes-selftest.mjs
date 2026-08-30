// Selftest des BUILD NOTES (PHASE 21, D8). Aucune E/S, aucun DOM.
// Lancer : node tools/buildnotes-selftest.mjs
import assert from 'node:assert/strict';
import { NOTES, countersOf, unlockedNotes, currentBuild } from './buildnotes-model.mjs';
import { STYLE_BANS } from './dialogue/validate.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ZERO = { terrains: 0, sessions: 0, targets: 0 };

t('NOTES : une échelle, pas un tas', () => {
	assert.ok(NOTES.length >= 8, `échelle trop courte : ${NOTES.length}`);
	for (const note of NOTES) {
		assert.match(note.build, /^\d+\.\d+\.\d+$/, `numéro de build mal formé : ${note.build}`);
		assert.ok(note.lines.length > 0);
	}
});

t('NOTES : les seuils de déblocage ne redescendent jamais', () => {
	// Sans ça, une entrée « plus haute » pourrait se débloquer avant une plus
	// basse et le numéro de build afficherait n'importe quoi.
	for (let i = 1; i < NOTES.length; i++) {
		for (const k of ['terrains', 'sessions', 'targets']) {
			assert.ok(NOTES[i].unlock[k] >= NOTES[i - 1].unlock[k],
				`${NOTES[i].build} : seuil ${k} en recul`);
		}
	}
});

t('NOTES : la première entrée est visible par un opérateur neuf', () => {
	assert.deepEqual(NOTES[0].unlock, ZERO);
	assert.equal(unlockedNotes(ZERO).length, 1);
	assert.equal(currentBuild(ZERO), NOTES[0].build);
});

t('NOTES : aucune promesse de suite, aucune adresse au joueur (D8)', () => {
	for (const note of NOTES) {
		for (const line of note.lines) {
			for (const ban of STYLE_BANS) {
				assert.ok(!ban.re.test(line), `${note.build} — ${ban.why} : "${line}"`);
			}
		}
	}
});

t('NOTES : les notes parlent de l\'outil au passé, jamais de l\'opérateur', () => {
	for (const note of NOTES) {
		for (const line of note.lines) {
			assert.ok(!/\byou\b|\byour\b/i.test(line), `${note.build} : la note s'adresse à quelqu'un — "${line}"`);
		}
	}
});

t('unlockedNotes : toujours un préfixe de l\'échelle', () => {
	const c = { terrains: 3, sessions: 12, targets: 9 };
	const got = unlockedNotes(c);
	assert.deepEqual(got, NOTES.slice(0, got.length));
	assert.equal(currentBuild(c), got.at(-1).build);
});

t('unlockedNotes : un seul compteur en retard suffit à bloquer', () => {
	const many = { terrains: 999, sessions: 999, targets: 0 };
	const all = { terrains: 999, sessions: 999, targets: 999 };
	assert.ok(unlockedNotes(many).length < unlockedNotes(all).length);
	assert.equal(unlockedNotes(all).length, NOTES.length);
});

t('countersOf : compte depuis l\'état opérateur réel, et survit à un état vide', () => {
	assert.deepEqual(countersOf(null), ZERO);
	assert.deepEqual(countersOf({}), ZERO);
	const op = {
		terrainCache: [{ slug: 'a' }, { slug: 'b' }],
		sessions: [{ target: { id: 't1' } }, { target: { id: 't2' } }, {}],
	};
	assert.deepEqual(countersOf(op), { terrains: 2, sessions: 3, targets: 2 });
});

console.log(`\n${n} vérifications, tout passe.`);
