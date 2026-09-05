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
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

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

// --- textures(), la liste ordonnée des couches (issue #110) -----------------

// tools/selftest.mjs vérifiait la convention UV en relisant exp_model.mtl
// lui-même : la dernière hypothèse « l'entrée est de l'OBJ » hors de
// lib/decoders/. Elle passe désormais par textures(), optionnel au contrat —
// un décodeur qui ne peut pas répondre sans tout décoder ne l'expose pas, et
// le contrôle se met en SKIP en le DISANT plutôt qu'en concluant « pas d'OBJ,
// donc rien à vérifier ».

t('contrat : textures() est optionnel, mais c\'est une fonction quand il existe', () => {
	for (const d of registry.DECODERS) {
		if (d.textures !== undefined) assert.equal(typeof d.textures, 'function', `${d.id}.textures`);
	}
});

t('rocktree ne prétend PAS savoir lister ses textures', () => {
	// Ses atlas sont des Buffers construits pendant le décodage (réparation
	// d'imagerie comprise) : il ne peut pas répondre à moindre coût, et il ne
	// doit pas laisser croire le contraire.
	const rt = registry.DECODERS.find((d) => d.id === 'rocktree');
	assert.ok(rt, 'le décodeur rocktree est inscrit');
	assert.equal(rt.textures, undefined);
});

await ta('obj.textures() rend une texture par matériau, dans l\'ordre de déclaration', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-textures-'));
	try {
		// L'ordre de déclaration DANS le .mtl est l'ordre des couches que
		// prep.mjs assigne : c'est cette correspondance que le contrôle UV
		// utilise pour retrouver le JPEG d'une couche donnée.
		fs.writeFileSync(path.join(dir, 'exp_model.mtl'), [
			'newmtl mat_a', 'map_Kd a.jpg',
			'newmtl mat_sans_texture',
			'newmtl mat_b', 'map_Kd b.jpg',
		].join('\n'));
		fs.writeFileSync(path.join(dir, 'exp_model.obj'), 'v 0 0 0\n');

		const d = registry.pick(dir);
		assert.equal(d.id, 'obj', 'le dossier est bien reconnu comme de l\'OBJ');
		const list = await d.textures(dir);
		assert.equal(list.length, 3, 'un élément par newmtl, texture ou pas');
		assert.equal(path.basename(list[0]), 'a.jpg');
		assert.equal(list[1], null, 'un matériau sans map_Kd rend null, il n\'est pas sauté');
		assert.equal(path.basename(list[2]), 'b.jpg');
		assert.ok(path.isAbsolute(list[0]), 'les chemins rendus sont absolus');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await ta('obj.textures() lève clairement quand le .mtl manque', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-textures-'));
	try {
		fs.writeFileSync(path.join(dir, 'exp_model.obj'), 'v 0 0 0\n');
		const d = registry.pick(dir);
		await assert.rejects(d.textures(dir), /missing .*exp_model\.mtl/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n${n} vérifications, tout passe.`);
