// Selftest du client rocktree (issue #18, Stage 3). Aucune E/S réseau : tout
// tourne sur tools/testdata/rocktree/, figé depuis une capture réelle.
// Lancer : node tools/rocktree-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFields, varints, doubles, floats } from './lib/rocktree/pb.mjs';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from './lib/rocktree/proto.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');
const FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('pb : varint, len-delimited et packed doubles sur un message fabriqué', () => {
	// field 1 varint 300 ; field 2 bytes "ab" ; field 3 packed double [1.5]
	const buf = Buffer.from([0x08, 0xac, 0x02, 0x12, 0x02, 0x61, 0x62, 0x1a, 0x08, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
	const f = readFields(buf);
	assert.equal(f[0].value, 300);
	assert.equal(f[1].value.toString(), 'ab');
	assert.equal(doubles(f[2].value)[0], 1.5);
});

t('pb : varint overflow lève (9 octets encodant >2^53)', () => {
	// field 1 varint de 9 octets encodant 2^54
	const buf = Buffer.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x04]);
	assert.throws(() => readFields(buf), /varint > 2\^53/);
});

t('planetoid : epoch racine 1014 (constaté live le 2026-08-31)', () => {
	assert.equal(parsePlanetoid(read(FIX.planetoid)).rootEpoch, FIX.epoch);
});

t('copyrights : des centaines d\'entrées, du texte utf-8 exploitable', () => {
	const map = parseCopyrights(read(FIX.copyrights));
	assert.ok(map.size > 100, `${map.size} entrées`);
	assert.ok([...map.values()].some((s) => /©|NASA|Maxar|Airbus/.test(s)));
});

t('bulk racine : les chemins relatifs font 1 à 4 digits octaux, la racine a des enfants', () => {
	const bulk = parseBulk(read(FIX.bulks[0].file));
	assert.ok(bulk.nodes.size > 0);
	for (const [p, m] of bulk.nodes) {
		assert.match(p, /^[0-7]{1,4}$/);
		assert.equal(typeof m.flags, 'number');
	}
});

t('bulk : la chaîne de la fixture se suit (chaque nœud du chemin existe dans son bulk)', () => {
	for (const node of FIX.nodes) {
		for (const b of FIX.bulks) {
			if (!node.path.startsWith(b.path) || node.path === b.path) continue;
			const rel = node.path.slice(b.path.length, b.path.length + 4);
			if (rel.length === 0) continue;
			const bulk = parseBulk(read(b.file));
			// Chaque préfixe du chemin relatif doit exister : c'est la propriété
			// qu'exploite la traversée (un enfant sans parent est un bug de parse).
			for (let i = 1; i <= rel.length; i++) {
				assert.ok(bulk.nodes.has(rel.slice(0, i)), `${b.path}+${rel.slice(0, i)} absent`);
			}
		}
	}
});

t('node : matrice 16 doubles dont le translationnel est à ~rayon terrestre', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		assert.equal(node.matrix.length, 16);
		const r = Math.hypot(node.matrix[12], node.matrix[13], node.matrix[14]);
		assert.ok(r > 6.3e6 && r < 6.45e6, `|t| = ${r}`);
		assert.ok(node.meshes.length > 0);
		for (const m of node.meshes) {
			assert.equal(m.vertices.length % 3, 0, 'vertices = 3 plans d\'octets');
			assert.ok(m.texture, 'texture présente');
			assert.equal(m.texture.format, 1, 'format JPG (!2e1)');
			// Un JPEG commence par FFD8.
			assert.equal(m.texture.data.readUInt16BE(0), 0xffd8);
		}
		assert.ok(node.copyrightIds.length > 0, 'copyright_ids présents');
	}
});

console.log(`rocktree-selftest : ${n} tests ok`);
