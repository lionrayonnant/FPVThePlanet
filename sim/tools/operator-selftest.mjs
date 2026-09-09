// Selftest de la logique pure de l'état opérateur. Aucune E/S disque.
// Lancer : node tools/operator-selftest.mjs
import assert from 'node:assert/strict';
import {
	SCHEMA_VERSION, slugify, newId, validateName,
	freshState, migrate,
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

t('freshState est complet', () => {
	const s = freshState({ id: 'neo-1a2b', name: 'Neo' });
	assert.equal(s.schemaVersion, SCHEMA_VERSION);
	assert.equal(s.id, 'neo-1a2b');
	assert.equal(s.name, 'Neo');
	assert.equal('controlVector' in s, false);
	assert.deepEqual(s.settings, {});
	assert.deepEqual(s.terrainCache, []);
	assert.deepEqual(s.sessions, []);
	assert.equal('targetLog' in s, false);
	assert.equal(s.sessionSeq, 0);
	assert.equal(s.targetSeq, 0);
	assert.deepEqual(s.worldState, {});
	assert.ok(!Number.isNaN(Date.parse(s.createdAt)));
});

t('migrate comble les clés manquantes', () => {
	const m = migrate({ id: 'x-1', name: 'X', controlVector: ['up', 'up', 'up', 'up'] });
	assert.equal(m.schemaVersion, SCHEMA_VERSION);
	// v2 → v3 : la clé morte part avec la migration (#33). Sans le `delete` de
	// migrate(), le spread `...state` la réinjecterait dans tout état déjà écrit.
	assert.equal('controlVector' in m, false);
	assert.deepEqual(m.sessions, []);
	assert.deepEqual(m.worldState, {});
});

t('migrate préserve un createdAt existant', () => {
	const m = migrate({ id: 'x-1', name: 'X', createdAt: '2019-07-04T12:00:00.000Z' });
	assert.equal(m.createdAt, '2019-07-04T12:00:00.000Z');
});

t('migrate refuse un état illisible', () => {
	assert.throws(() => migrate(null), /illisible/);
	assert.throws(() => migrate('nope'), /illisible/);
});

t('migrate refuse une version future', () => {
	assert.throws(() => migrate({ schemaVersion: 99, id: 'x-1', name: 'X' }), /trop récent/);
});

// --- E/S disque : on pointe le store sur un tmpdir jetable ---
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'op-store-'));
process.env.FPV_OPERATOR_DIR = tmp;                       // lu par tools/lib/paths.mjs
const store = await import('../server/api.mjs');

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
