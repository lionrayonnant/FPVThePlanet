// Selftest de la logique pure de l'état opérateur. Aucune E/S disque.
// Lancer : node tools/operator-selftest.mjs
import assert from 'node:assert/strict';
import {
	SCHEMA_VERSION, slugify, newId, validateName,
	validateControlVector, freshState, migrate,
} from './operator-store.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('slugify normalise', () => {
	assert.equal(slugify('NEO'), 'neo');
	assert.equal(slugify('  Agent Vex 7 !! '), 'agent-vex-7');
	assert.equal(slugify('***'), '');
});

t('newId ajoute un suffixe hex', () => {
	const id = newId('Neo');
	assert.match(id, /^neo-[0-9a-f]{4}$/);
	assert.throws(() => newId('***'), /inutilisable/);
});

t('validateName', () => {
	assert.equal(validateName('  Neo  '), 'Neo');
	assert.throws(() => validateName(''), /NAME REQUIRED/);
	assert.throws(() => validateName('   '), /NAME REQUIRED/);
	assert.throws(() => validateName('x'.repeat(25)), /NAME TOO LONG/);
	assert.throws(() => validateName('***'), /NAME UNUSABLE/);
});

t('validateControlVector', () => {
	assert.deepEqual(
		validateControlVector(['up', 'right', 'down', 'left', 'up', 'left']),
		['up', 'right', 'down', 'left', 'up', 'left'],
	);
	assert.throws(() => validateControlVector(['up', 'up', 'up']), /invalide/);       // trop court
	assert.throws(() => validateControlVector(new Array(9).fill('up')), /invalide/);  // trop long
	assert.throws(() => validateControlVector(['up', 'north', 'up', 'up']), /invalide/);
	assert.throws(() => validateControlVector('uuuu'), /invalide/);
});

t('freshState est complet', () => {
	const s = freshState({ id: 'neo-1a2b', name: 'Neo' });
	assert.equal(s.schemaVersion, SCHEMA_VERSION);
	assert.equal(s.id, 'neo-1a2b');
	assert.equal(s.name, 'Neo');
	assert.deepEqual(s.controlVector, []);
	assert.deepEqual(s.settings, {});
	assert.deepEqual(s.terrainCache, []);
	assert.deepEqual(s.sessions, []);
	assert.deepEqual(s.targetLog, []);
	assert.deepEqual(s.worldState, {});
	assert.ok(!Number.isNaN(Date.parse(s.createdAt)));
});

t('migrate comble les clés manquantes', () => {
	const m = migrate({ id: 'x-1', name: 'X', controlVector: ['up', 'up', 'up', 'up'] });
	assert.equal(m.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(m.controlVector, ['up', 'up', 'up', 'up']);
	assert.deepEqual(m.sessions, []);
	assert.deepEqual(m.worldState, {});
});

t('migrate refuse une version future', () => {
	assert.throws(() => migrate({ schemaVersion: 99, id: 'x-1', name: 'X' }), /trop récent/);
});

// --- E/S disque : on pointe le store sur un tmpdir jetable ---
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'op-store-'));
process.env.FPV_OPERATOR_DIR = tmp;                       // lu par map-api-plugin
const store = await import('./map-api-plugin.mjs');

t('write + read round-trip', () => {
	const s = freshState({ id: 'neo-aaaa', name: 'Neo' });
	store._writeOperator(s);
	const back = store._readOperator('neo-aaaa');
	assert.equal(back.name, 'Neo');
	assert.equal(back.schemaVersion, SCHEMA_VERSION);
});

t('read inconnu renvoie null', () => {
	assert.equal(store._readOperator('nope-0000'), null);
});

t('read migre un fichier v0 sur disque', () => {
	store._writeOperator({ id: 'old-bbbb', name: 'Old', controlVector: ['up', 'up', 'up', 'up'] });
	const back = store._readOperator('old-bbbb');
	assert.equal(back.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(back.sessions, []);
});

t('list trie par createdAt', () => {
	const a = freshState({ id: 'a-0001', name: 'A' }); a.createdAt = '2020-01-01T00:00:00.000Z';
	const b = freshState({ id: 'b-0002', name: 'B' }); b.createdAt = '2021-01-01T00:00:00.000Z';
	store._writeOperator(b); store._writeOperator(a);
	const ids = store._listOperators().map((o) => o.id);
	assert.ok(ids.indexOf('a-0001') < ids.indexOf('b-0002'));
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${n} tests OK`);
