// Selftest du contrat décodeur (issue #18). Aucune E/S réseau, aucun DOM.
// Miroir de tools/provider-selftest.mjs pour l'autre seam du pipeline.
// Lancer : node tools/decoder-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as registry from './lib/decoders/index.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('contrat : chaque décodeur inscrit expose id/sniff/decode', () => {
	assert.ok(registry.DECODERS.length > 0, 'au moins un décodeur inscrit');
	for (const d of registry.DECODERS) {
		assert.equal(typeof d.id, 'string', 'id');
		assert.ok(d.id.length > 0, 'id non vide');
		assert.equal(typeof d.sniff, 'function', `${d.id}.sniff`);
		assert.equal(typeof d.decode, 'function', `${d.id}.decode`);
	}
});

t('pick() : un dossier non reconnu lève en nommant les décodeurs connus', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-selftest-'));
	try {
		assert.throws(
			() => registry.pick(dir),
			(err) => {
				assert.match(err.message, /aucun décodeur ne reconnaît/);
				for (const d of registry.DECODERS) {
					assert.ok(err.message.includes(d.id), `message muet sur ${d.id} : ${err.message}`);
				}
				return true;
			},
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

t('sniff() : faux pour un dossier sans la paire OBJ/MTL', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-selftest-'));
	try {
		for (const d of registry.DECODERS) {
			assert.equal(d.sniff(dir), false, `${d.id}.sniff aurait dû rejeter un dossier vide`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n${n} vérifications, tout passe.`);
