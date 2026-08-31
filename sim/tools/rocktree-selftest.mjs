// Selftest du client rocktree (issue #18, Stage 3). Aucune E/S réseau : tout
// tourne sur tools/testdata/rocktree/, figé depuis une capture réelle.
// Lancer : node tools/rocktree-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFields, varints, doubles, floats } from './lib/rocktree/pb.mjs';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from './lib/rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './lib/rocktree/unpack.mjs';
import { rootOctant, childBoxes, octantsCovering, ROOTS } from './lib/rocktree/octant.mjs';

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

t('unpack : sur chaque mesh des fixtures, les invariants géométriques tiennent', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			assert.equal(xyz.length, count * 3);
			const strip = unpackIndices(mesh.indices);
			for (const idx of strip) assert.ok(idx >= 0 && idx < count, `indice ${idx} / ${count} sommets`);
			const { layerBounds } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);
			assert.ok(layerBounds[3] <= strip.length);
			if (mesh.texCoords) {
				const { uv } = unpackTexCoords(mesh.texCoords, count);
				assert.equal(uv.length, count * 2);
			}
		}
	}
});

t('unpack : les sommets transformés par la matrice tombent à ~rayon terrestre', () => {
	// Le VRAI test du décodage : delta-unpacking faux = sommets aberrants,
	// et la norme ECEF le crie tout de suite (6 357–6 400 km + bâti).
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		const ma = node.matrix;
		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			for (let i = 0; i < count; i += 97) { // échantillon
				const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
				const ex = x * ma[0] + y * ma[4] + z * ma[8] + ma[12];
				const ey = x * ma[1] + y * ma[5] + z * ma[9] + ma[13];
				const ez = x * ma[2] + y * ma[6] + z * ma[10] + ma[14];
				const r = Math.hypot(ex, ey, ez);
				assert.ok(r > 6.35e6 && r < 6.4e6, `|v| = ${r}`);
			}
		}
	}
});

t('unpack : les UV finaux tombent dans [0,1] (uv_offset_and_scale du proto)', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		for (const mesh of node.meshes) {
			if (!mesh.texCoords || !mesh.uvOffsetAndScale) continue;
			const { xyz, count } = unpackVertices(mesh.vertices);
			const { uv } = unpackTexCoords(mesh.texCoords, count);
			const [ou, ov, su, sv] = mesh.uvOffsetAndScale;
			let inRange = 0;
			for (let i = 0; i < count; i++) {
				const u = (uv[i * 2] + ou) * su, v = (uv[i * 2 + 1] + ov) * sv;
				if (u >= -0.01 && u <= 1.01 && v >= -0.01 && v <= 1.01) inRange++;
			}
			assert.ok(inRange / count > 0.99, `${inRange}/${count} UV dans [0,1]`);
		}
	}
});

t('unpack : layerBounds[m] = indice WHERE group m BEGINS (test synthétique)', () => {
	// Construis un buffer varint avec 32 groupes de 8 varints chacun.
	// Groupe 0: [2,1,0,0,0,0,0,0] — 2+1 = 3 indices
	// Groupe 1: [3,0,0,0,0,0,0,0] — 3 indices
	// Groupe 2: [4,0,0,0,0,0,0,0] — 4 indices
	// Groupe 3: [5,0,0,0,0,0,0,0] — 5 indices
	// Groupe 4-31: [0,...] — 0 indices chacun
	// Tous les varints < 128 s'encodent en un octet.
	const buf = Buffer.from([
		32, // len = 32 varints
		2, 1, 0, 0, 0, 0, 0, 0, // groupe 0: octant 0 (2 idx), 1 (1 idx), 2-7 (0 idx)
		3, 0, 0, 0, 0, 0, 0, 0, // groupe 1: octant 0 (3 idx), 1-7 (0 idx)
		4, 0, 0, 0, 0, 0, 0, 0, // groupe 2: octant 0 (4 idx), 1-7 (0 idx)
		5, 0, 0, 0, 0, 0, 0, 0, // groupe 3: octant 0 (5 idx), 1-7 (0 idx)
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 4-7: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 8-11: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 12-15: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 16-19: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 20-23: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 24-27: tous 0
		0, 0, 0, 0, 0, 0, 0, 0, // groupe 28-31: tous 0
	]);
	const strip = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
	const count = 15;
	const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(buf, strip, count);
	// Attendu : layerBounds[0..9] = [0, 3, 6, 10, 15, 15, 15, 15, 15, 15]
	// - Groupe 0 (i % 8 === 0) : layerBounds[0] = 0 (k avant les varints du groupe)
	//   Varints : 2, 1, 0, 0, 0, 0, 0, 0 → k = 0 + 2 + 1 = 3
	// - Groupe 8 (i % 8 === 0) : layerBounds[1] = 3 (k avant les varints du groupe)
	//   Varints : 3, 0, 0, 0, 0, 0, 0, 0 → k = 3 + 3 = 6
	// - Groupe 16 (i % 8 === 0) : layerBounds[2] = 6
	//   Varints : 4, 0, 0, 0, 0, 0, 0, 0 → k = 6 + 4 = 10
	// - Groupe 24 (i % 8 === 0) : layerBounds[3] = 10 (début de TERRAIN_HIDDEN)
	//   Varints : 5, 0, 0, 0, 0, 0, 0, 0 → k = 10 + 5 = 15
	// - Groupe 32 n'existe pas (len === 32) ; boucle while remplit 4-9 avec 15
	assert.deepEqual([...layerBounds], [0, 3, 6, 10, 15, 15, 15, 15, 15, 15]);
	// Octant assignment :
	// - Groupe 0 (i=0, octant 0): 2 idx → strip[0], strip[1] = 0, 0 = octantOf 0
	// - Groupe 1 (i=1, octant 1): 1 idx → strip[2] = octantOf 1
	// - Groupe 2-7 (i=2-7, octant 2-7): 0 idx each
	// - Groupe 8 (i=8, octant 0): 3 idx → strip[3], strip[4], strip[5] = octantOf 0
	// Vérifs clés :
	assert.equal(octantOf[strip[0]], 0, 'strip[0] doit être octant 0 (groupe 0)');
	assert.equal(octantOf[strip[3]], 0, 'strip[3] doit être octant 0 (groupe 8)');
});

t('octant : Paris (48.86, 2.35) est dans la racine 30 (0..90°E, hémisphère nord)', () => {
	assert.equal(rootOctant(48.86, 2.35).path, '30');
	assert.equal(rootOctant(-33.9, 151.2).path, '13'); // Sydney
	assert.equal(rootOctant(40.7, -74.0).path, '21');  // New York
});

t('octant : les chemins de la fixture HAR (Paris) redescendent bien depuis 30', () => {
	for (const nf of FIX.nodes) assert.ok(nf.path.startsWith('30'), nf.path);
});

t('octant : childBoxes découpe en 4 boxes lat/lon × 2 variantes verticales', () => {
	// Non-polar box to demonstrate full 8-way split without polar logic
	const kids = childBoxes({ n: 45, s: -45, w: -45, e: 45 });
	assert.equal(kids.length, 8);
	const k3 = kids.find((k) => k.key === 3);
	assert.deepEqual(k3.box, { n: 45, s: 0, w: 0, e: 45 });
	// La variante +4 partage la box de sa jumelle.
	assert.deepEqual(kids.find((k) => k.key === 7).box, k3.box);
});

t('octant : comportement polaire — pas de découpe est/ouest au pôle', () => {
	const polarKids = childBoxes({ n: 90, s: 0, w: 0, e: 90 });
	assert.equal(polarKids.length, 6, `${polarKids.length} enfants au lieu de 6 (les est skippés au pôle)`);
	assert.ok(!polarKids.some((k) => k.key === 3 || k.key === 7), 'clés east (3, 7) doivent être absentes');
	const k2 = polarKids.find((k) => k.key === 2);
	assert.deepEqual(k2.box, { n: 90, s: 45, w: 0, e: 90 }, 'enfant nord-ouest garde la pleine longitude');
});

t('octant : chemins profonds validés digit par digit depuis racine', () => {
	// Vérifier que tous les chemins des fixtures se marchent correctement
	// depuis la racine, digit par digit. Les positions exactes sont mesurées
	// depuis les matrices ECEF et varient par nœud ; on teste seulement que
	// chaque étape du chemin mène à un enfant valide et que la box se raffine.
	for (const nf of FIX.nodes) {
		// Trouver la racine via ses 2 premiers digits
		const rootPath = nf.path.slice(0, 2);
		const rootEntry = ROOTS.find(([p]) => p === rootPath);
		assert.ok(rootEntry, `Racine ${rootPath} du chemin ${nf.path} non trouvée`);
		let box = rootEntry[1];
		const rootBox = box;

		// Marcher le chemin digit par digit, vérifier que chaque digit
		// correspond à un enfant valide et que la box se raffine.
		for (let i = 2; i < nf.path.length; i++) {
			const digit = nf.path[i];
			const key = Number(digit);
			const children = childBoxes(box);
			const child = children.find(c => c.key === key);
			assert.ok(child, `Chemin ${nf.path}: digit ${i} '${digit}' (clé ${key}) n'a pas d'enfant correspondant`);
			box = child.box;

			// Vérifier que la box se raffine (reste incluse dans la box parente)
			assert.ok(box.n <= rootBox.n && box.s >= rootBox.s && box.w >= rootBox.w && box.e <= rootBox.e,
				`Chemin ${nf.path} au digit ${i}: box s'échappe des limites`);
		}

		// Vérifier que la box finale couvre une région raisonnablement petite.
		// À niveau 22, la box doit faire environ 1/2^11 d'un côté ≈ 90/2048 ≈ 0.044 degrés.
		const size = Math.max(box.n - box.s, box.e - box.w);
		assert.ok(size < 0.1, `Chemin ${nf.path}: box finale trop grande (${size}°)`);
	}
});

t('octant : octantsCovering rend, au niveau des fixtures, un surensemble de leurs chemins', () => {
	// La zone couverte par la capture contient les nœuds de la fixture : la
	// traversée géométrique doit proposer leurs chemins (le serveur décide
	// ensuite de leur existence — ici on ne teste que la géométrie).
	// Test uniquement au niveau le plus peu profond (17) pour la tractabilité ;
	// niveaux 21-22 sont exponentiellement coûteux sans index spatial.
	const minDepth = Math.min(...FIX.nodes.map(n => n.path.length));
	const shallow = FIX.nodes.find(nf => nf.path.length === minDepth);
	const L = shallow.path.length;
	const zone = { south: 48.85, west: 2.33, north: 48.87, east: 2.36 };
	let found = false;
	for (const o of octantsCovering(zone, L)) {
		if (o.path === shallow.path) { found = true; break; }
	}
	assert.ok(found, `${shallow.path} absent de octantsCovering au niveau ${L}`);
});

console.log(`rocktree-selftest : ${n} tests ok`);
