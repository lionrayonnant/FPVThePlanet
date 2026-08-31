// Selftest du client rocktree (issue #18, Stage 3). Aucune E/S réseau : tout
// tourne sur tools/testdata/rocktree/, figé depuis une capture réelle.
// Lancer : node tools/rocktree-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFields, varints, doubles, floats } from './lib/rocktree/pb.mjs';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from './lib/rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './lib/rocktree/unpack.mjs';
import { rootOctant, childBoxes, descendBox, boxIntersects, ROOTS } from './lib/rocktree/octant.mjs';
import * as rocktree from './lib/decoders/rocktree.mjs';
import { pick } from './lib/decoders/index.mjs';
import * as ge from './lib/providers/google-earth.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');
const FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

// Fabrique un tileDir depuis les fixtures (c'est le format que produit le
// fournisseur — ce helper EST le contrat entre fournisseur et décodeur).
// Partagé par le test décodeur et le test de régression sphère→WGS84
// ci-dessous plutôt que dupliqué : les deux décodent le même tileDir.
function makeFixtureTileDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocktree-dec-'));
	fs.mkdirSync(path.join(dir, 'nodes'));
	const copyrights = {};
	for (const nf of FIX.nodes) {
		fs.copyFileSync(path.join(DIR, nf.file), path.join(dir, 'nodes', `${nf.path}.pb`));
	}
	// Résout les copyright_ids réels des fixtures contre copyrights.pb.
	const crMap = parseCopyrights(read(FIX.copyrights));
	for (const nf of FIX.nodes) {
		for (const id of parseNode(read(nf.file)).copyrightIds) {
			if (crMap.has(id)) copyrights[id] = crMap.get(id);
		}
	}
	// radius : lu du vrai planetoid.pb de la fixture (comme fetch() le ferait
	// réellement, issue #18 revue post-cdd7e7c), pas la valeur en dur du
	// décodeur — ce tileDir exerce donc le chemin "radius fourni", le
	// fallback restant couvert par les tileDir déjà cuits sans ce champ.
	const radius = parsePlanetoid(read(FIX.planetoid)).radius;
	fs.writeFileSync(path.join(dir, 'rocktree-tile.json'), JSON.stringify({
		provider: 'google-earth', epoch: FIX.epoch, radius, level: 16,
		fetchedAt: '2026-08-31T00:00:00.000Z', copyrights,
		nodes: FIX.nodes.map((nf) => ({ path: nf.path, file: `nodes/${nf.path}.pb`, exclude: [] })),
	}, null, '\t'));
	return dir;
}

// ---------------------------------------------------------------- oracle
// L'ANCIEN algorithme de traversée (énumération géométrique des octants, puis
// descente des bulks chemin par chemin), gardé ici et NULLE PART ailleurs.
//
// Il n'a plus sa place dans la lib : au niveau 21 il énumère 2^19 variantes
// VERTICALES par cellule lat/lon — 68 M de chemins et 42 s mesurés pour une
// zone de 240 m, sans terminer sur 1 km (issue #153). Le laisser exporté,
// c'était laisser un piège de 42 s à portée d'import.
//
// Mais il reste l'oracle : lent et évidemment correct. La marche par bulks
// doit rendre EXACTEMENT le même ensemble de nœuds, et c'est ce que le test
// d'équivalence plus bas vérifie sur les fixtures réelles. Sans lui, « j'ai
// réécrit la traversée » ne serait garanti par rien.
function* octantsCoveringReference(zone, level) {
	function* walk(pathArr, box) {
		if (pathArr.length === level) { yield { path: pathArr.join(''), box }; return; }
		for (const { key, box: b } of childBoxes(box)) {
			if (boxIntersects(b, zone)) {
				pathArr.push(key);
				yield* walk(pathArr, b);
				pathArr.pop();
			}
		}
	}
	const pathArr = [];
	for (const [path, box] of ROOTS) {
		if (boxIntersects(box, zone)) {
			for (const ch of path) pathArr.push(ch);
			yield* walk(pathArr, box);
			pathArr.length = 0;
		}
	}
}

// L'ancienne traverse(), rendue pure : au lieu d'aller chercher les bulks sur
// le réseau, elle les lit dans une Map path -> bulk parsé. Même logique digit
// par digit, même `lastGood`, même condition d'arrêt — c'est une transcription,
// pas une réécriture, sinon l'oracle ne prouverait rien.
function traverseByEnumerationReference(bulksByPath, zone, level) {
	const nodesOut = new Map();
	for (const { path: target } of octantsCoveringReference(zone, level)) {
		let bulk = bulksByPath.get('') ?? null;
		let consumed = 0;
		let lastGood = null;

		while (bulk && consumed < target.length) {
			const remain = Math.min(4, target.length - consumed);
			let matchedLen = 0, leafHit = false;
			for (let len = 1; len <= remain; len++) {
				const rel = target.slice(consumed, consumed + len);
				const meta = bulk.nodes.get(rel);
				if (!meta) break;
				matchedLen = len;
				if (!(meta.flags & 8)) lastGood = { path: target.slice(0, consumed + len), meta, bulk };
				if (meta.flags & 4) { leafHit = true; break; }
			}
			if (matchedLen === 0 || leafHit) break;
			consumed += matchedLen;
			if (consumed >= target.length || matchedLen < 4) break;
			bulk = bulksByPath.get(target.slice(0, consumed)) ?? null;
		}

		if (lastGood && !nodesOut.has(lastGood.path)) {
			const { meta, bulk: b } = lastGood;
			nodesOut.set(lastGood.path, {
				path: lastGood.path,
				epoch: meta.epoch ?? b.epoch,
				imageryEpoch: (meta.flags & 16) ? (meta.imageryEpoch ?? b.defaultImageryEpoch) : null,
				flags: meta.flags,
			});
		}
	}
	ge.dropFillinAncestors(nodesOut);
	return nodesOut;
}

// Les bulks des fixtures, parsés une fois, indexés par chemin de bulk.
function fixtureBulks() {
	const m = new Map();
	for (const b of FIX.bulks) m.set(b.path, { ...parseBulk(read(b.file)), epoch: b.epoch });
	return m;
}

// Sert les fixtures à la place de kh.google.com. Toute URL hors fixture
// répond 404 (nœud/bulk absent) : la traversée doit s'en accommoder.
function fixtureNet() {
	const served = new Map();
	served.set('PlanetoidMetadata', read(FIX.planetoid));
	served.set(`Copyrights/pb=!1u${FIX.epoch}`, read(FIX.copyrights));
	for (const b of FIX.bulks) served.set(`BulkMetadata/pb=!1m2!1s${b.path}!2u${b.epoch}`, read(b.file));
	for (const nf of FIX.nodes) served.set(nf.url.replace('https://kh.google.com/rt/earth/', ''), read(nf.file));
	return async (url) => {
		const key = url.replace('https://kh.google.com/rt/earth/', '');
		if (!served.has(key)) { const e = new Error(`404 ${key}`); e.status = 404; throw e; }
		return served.get(key);
	};
}

// Installe un réseau mock le temps d'un appel, et le retire quoi qu'il arrive.
async function withNet(http, fn) {
	const real = ge._net.http;
	ge._net.http = http;
	try { return await fn(); } finally { ge._net.http = real; }
}

// ---------------------------------------------------------- encodeur bulk
// Encodeur protobuf minimal, réservé aux tests : il permet de FABRIQUER des
// octrees synthétiques de forme choisie (cf. le test de complexité), ce
// qu'aucune fixture figée ne peut offrir. Miroir exact de unpackPathAndFlags()
// dans proto.mjs — si l'un des deux dérive, le test aller-retour plus bas
// tombe.
function encodeVarint(n) {
	const out = [];
	while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
	out.push(n);
	return out;
}

function encodePathAndFlags(relPath, flags) {
	// unpackPathAndFlags lit : level = 1 + (v & 3), puis `level` digits de 3
	// bits du poids faible au poids fort, puis les flags. On empile donc à
	// l'envers : flags d'abord, digits du dernier au premier, longueur enfin.
	let v = flags;
	for (let i = relPath.length - 1; i >= 0; i--) v = v * 8 + Number(relPath[i]);
	return v * 4 + (relPath.length - 1);
}

// entries : [{ relPath, flags, bulkEpoch? }] -> Buffer d'un BulkMetadata.
function encodeBulk(entries) {
	const out = [];
	for (const e of entries) {
		const node = [0x08, ...encodeVarint(encodePathAndFlags(e.relPath, e.flags))]; // champ 1 varint
		if (e.bulkEpoch != null) node.push(0x28, ...encodeVarint(e.bulkEpoch));       // champ 5 varint
		out.push(0x0a, ...encodeVarint(node.length), ...node);                        // champ 1 len-delimited
	}
	return Buffer.from(out);
}

await (async () => {

await t('pb : varint, len-delimited et packed doubles sur un message fabriqué', () => {
	// field 1 varint 300 ; field 2 bytes "ab" ; field 3 packed double [1.5]
	const buf = Buffer.from([0x08, 0xac, 0x02, 0x12, 0x02, 0x61, 0x62, 0x1a, 0x08, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
	const f = readFields(buf);
	assert.equal(f[0].value, 300);
	assert.equal(f[1].value.toString(), 'ab');
	assert.equal(doubles(f[2].value)[0], 1.5);
});

await t('pb : varint overflow lève (9 octets encodant >2^53)', () => {
	// field 1 varint de 9 octets encodant 2^54
	const buf = Buffer.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x04]);
	assert.throws(() => readFields(buf), /varint > 2\^53/);
});

await t('planetoid : epoch racine 1014, rayon 6 371 010 m (constatés live le 2026-08-31)', () => {
	const p = parsePlanetoid(read(FIX.planetoid));
	assert.equal(p.rootEpoch, FIX.epoch);
	// Champ 2 du message racine (pas de `meta`) : le rayon de la sphère que
	// rocktree.mjs reconvertit en ellipsoïde WGS84 — 6 371 010, pas la
	// constante IUGG 6 371 000 qui biaisait chaque altitude de +10 m.
	assert.equal(p.radius, 6371010);
});

await t('copyrights : des centaines d\'entrées, du texte utf-8 exploitable', () => {
	const map = parseCopyrights(read(FIX.copyrights));
	assert.ok(map.size > 100, `${map.size} entrées`);
	assert.ok([...map.values()].some((s) => /©|NASA|Maxar|Airbus/.test(s)));
});

await t('bulk racine : les chemins relatifs font 1 à 4 digits octaux, la racine a des enfants', () => {
	const bulk = parseBulk(read(FIX.bulks[0].file));
	assert.ok(bulk.nodes.size > 0);
	for (const [p, m] of bulk.nodes) {
		assert.match(p, /^[0-7]{1,4}$/);
		assert.equal(typeof m.flags, 'number');
	}
});

await t('bulk : la chaîne de la fixture se suit (chaque nœud du chemin existe dans son bulk)', () => {
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

await t('node : matrice 16 doubles dont le translationnel est à ~rayon terrestre', () => {
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

await t('unpack : sur chaque mesh des fixtures, les invariants géométriques tiennent', () => {
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

await t('unpack : les sommets transformés par la matrice tombent à ~rayon terrestre', () => {
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

await t('unpack : les UV finaux tombent dans [0,1] (uv_offset_and_scale du proto)', () => {
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

await t('unpack : layerBounds[m] = indice WHERE group m BEGINS (test synthétique)', () => {
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

await t('octant : Paris (48.86, 2.35) est dans la racine 30 (0..90°E, hémisphère nord)', () => {
	assert.equal(rootOctant(48.86, 2.35).path, '30');
	assert.equal(rootOctant(-33.9, 151.2).path, '13'); // Sydney
	assert.equal(rootOctant(40.7, -74.0).path, '21');  // New York
});

await t('octant : les chemins de la fixture HAR (Paris) redescendent bien depuis 30', () => {
	for (const nf of FIX.nodes) assert.ok(nf.path.startsWith('30'), nf.path);
});

await t('octant : childBoxes découpe en 4 boxes lat/lon × 2 variantes verticales', () => {
	// Non-polar box to demonstrate full 8-way split without polar logic
	const kids = childBoxes({ n: 45, s: -45, w: -45, e: 45 });
	assert.equal(kids.length, 8);
	const k3 = kids.find((k) => k.key === 3);
	assert.deepEqual(k3.box, { n: 45, s: 0, w: 0, e: 45 });
	// La variante +4 partage la box de sa jumelle.
	assert.deepEqual(kids.find((k) => k.key === 7).box, k3.box);
});

await t('octant : comportement polaire — pas de découpe est/ouest au pôle', () => {
	const polarKids = childBoxes({ n: 90, s: 0, w: 0, e: 90 });
	assert.equal(polarKids.length, 6, `${polarKids.length} enfants au lieu de 6 (les est skippés au pôle)`);
	assert.ok(!polarKids.some((k) => k.key === 3 || k.key === 7), 'clés east (3, 7) doivent être absentes');
	const k2 = polarKids.find((k) => k.key === 2);
	assert.deepEqual(k2.box, { n: 90, s: 45, w: 0, e: 90 }, 'enfant nord-ouest garde la pleine longitude');
});

await t('octant : chemins profonds validés digit par digit depuis racine', () => {
	// Vérifier que tous les chemins des fixtures se marchent correctement
	// depuis la racine, digit par digit, et aboutissent sur le centre mesuré
	// de chaque nœud (extrait de la matrice ECEF).
	for (const nf of FIX.nodes) {
		// Charger le nœud et extraire la matrice ECEF
		const node = parseNode(read(nf.file));
		const ma = node.matrix;

		// Calculer le centre du cube local (128,128,128) en ECEF
		const cx = 128 * ma[0] + 128 * ma[4] + 128 * ma[8] + ma[12];
		const cy = 128 * ma[1] + 128 * ma[5] + 128 * ma[9] + ma[13];
		const cz = 128 * ma[2] + 128 * ma[6] + 128 * ma[10] + ma[14];

		// Convertir en lat/lon
		const r = Math.hypot(cx, cy, cz);
		const lat = Math.asin(cz / r) * 180 / Math.PI;
		const lon = Math.atan2(cy, cx) * 180 / Math.PI;

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

		// Vérifier que la box finale contient le centre mesuré du nœud
		assert.ok(box.s <= lat && lat <= box.n && box.w <= lon && lon <= box.e,
			`${nf.path} : centre (${lat.toFixed(5)}, ${lon.toFixed(5)}) hors box ${JSON.stringify(box)}`);
	}
});

await t('octant : descendBox — racines à 2 digits, puis childBoxes, null hors géométrie', () => {
	// Profondeur 0 : un digit seul ne nomme pas une racine (celles-ci font 2
	// digits) mais l'union des deux qui commencent par lui — un quart de globe.
	assert.deepEqual(descendBox(null, '', '3'), { n: 90, s: 0, w: 0, e: 180 });
	assert.deepEqual(descendBox(null, '', '0'), { n: 0, s: -90, w: -180, e: 0 });
	// Profondeur 1 : on tombe exactement sur la racine de ROOTS.
	assert.deepEqual(descendBox(null, '3', '0'), ROOTS.find(([p]) => p === '30')[1]);
	// Profondeur >= 2 : childBoxes ordinaire, et la jumelle verticale (+4)
	// partage la boîte de son homologue — c'est LA raison du 2^(niveau-2).
	const b30 = ROOTS.find(([p]) => p === '30')[1];
	assert.deepEqual(descendBox(b30, '30', '2'), descendBox(b30, '30', '6'));
	// Digit géométriquement impossible : sous une boîte qui touche le pôle, les
	// enfants NORD (clés 2/3/6/7) touchent le pôle à leur tour, et childBoxes
	// n'y émet pas de découpe est/ouest — les clés nord-EST (3 et 7) n'existent
	// donc pas, et descendBox rend null plutôt qu'une boîte inventée. Les
	// enfants SUD (clés 0/1/4/5), eux, ne touchent plus le pôle et se
	// découpent normalement.
	const polar = { n: 90, s: 45, w: 0, e: 90 };
	assert.equal(descendBox(polar, '3021', '3'), null, 'nord-est sous une calotte polaire');
	assert.equal(descendBox(polar, '3021', '7'), null, 'jumelle verticale du nord-est');
	assert.deepEqual(descendBox(polar, '3021', '2'), { n: 90, s: 67.5, w: 0, e: 90 },
		'le nord-ouest garde la pleine longitude');
	assert.deepEqual(descendBox(polar, '3021', '1'), { n: 67.5, s: 45, w: 45, e: 90 },
		'le sud-est ne touche plus le pôle : découpe est/ouest normale');
	// Racine inexistante : null plutôt qu'une boîte inventée.
	assert.equal(descendBox(null, '', '9'), null);
	assert.equal(descendBox(null, '0', '0'), null); // '00' n'est pas une racine
});

await t('octant : descendBox reproduit, digit par digit, la boîte de chaque chemin de fixture', () => {
	// Même propriété que le test « chemins profonds » plus haut, mais par la
	// fonction que la traversée utilise réellement : la boîte finale doit
	// contenir le centre ECEF mesuré du nœud.
	for (const nf of FIX.nodes) {
		const ma = parseNode(read(nf.file)).matrix;
		const cx = 128 * ma[0] + 128 * ma[4] + 128 * ma[8] + ma[12];
		const cy = 128 * ma[1] + 128 * ma[5] + 128 * ma[9] + ma[13];
		const cz = 128 * ma[2] + 128 * ma[6] + 128 * ma[10] + ma[14];
		const r = Math.hypot(cx, cy, cz);
		const lat = Math.asin(cz / r) * 180 / Math.PI, lon = Math.atan2(cy, cx) * 180 / Math.PI;

		let box = null;
		for (let i = 0; i < nf.path.length; i++) {
			box = descendBox(box, nf.path.slice(0, i), nf.path[i]);
			assert.ok(box, `${nf.path} : digit ${i} sans boîte`);
		}
		assert.ok(box.s <= lat && lat <= box.n && box.w <= lon && lon <= box.e,
			`${nf.path} : centre (${lat.toFixed(5)}, ${lon.toFixed(5)}) hors box ${JSON.stringify(box)}`);
	}
});

await t('proto : encodeBulk/parseBulk font un aller-retour (l\'encodeur de test est fidèle)', () => {
	// L'encodeur ci-dessus sert à fabriquer les octrees synthétiques du test de
	// complexité. S'il encode faux, ce test-là mesurerait une fiction : on
	// verrouille donc d'abord l'encodeur contre le VRAI parseur de proto.mjs.
	const entries = [
		{ relPath: '0', flags: 0 },
		{ relPath: '47', flags: 4 },
		{ relPath: '036', flags: 8 },
		{ relPath: '4703', flags: 16, bulkEpoch: 1013 },
	];
	const bulk = parseBulk(encodeBulk(entries));
	assert.equal(bulk.nodes.size, entries.length);
	for (const e of entries) {
		const m = bulk.nodes.get(e.relPath);
		assert.ok(m, `${e.relPath} absent après aller-retour`);
		assert.equal(m.flags, e.flags, `flags de ${e.relPath}`);
		assert.equal(m.bulkEpoch, e.bulkEpoch ?? null, `bulkEpoch de ${e.relPath}`);
	}
});

await t('fournisseur : expandBulk retient/élague/descend selon les flags et la zone', () => {
	// Unité pure : aucun réseau. Les quatre décisions qu'expandBulk doit
	// prendre, isolées l'une de l'autre sur un bulk fabriqué.
	//
	// Racine '30' = (0..90°N, 0..90°E). Sous elle, digit 0 = sud-ouest
	// (0..45°N, 0..45°E) ; digit 2 = nord-ouest (45..90°N, ...). La zone
	// couvre largement le quart sud-ouest — assez pour que les DEUX frères
	// '000' et '001' y tombent (sinon le cas LEAF ne serait jamais atteint,
	// élagué par la géométrie et non par les flags) — mais s'arrête bien en
	// dessous de 45°N, donc la branche nord doit être élaguée.
	const b30 = ROOTS.find(([p]) => p === '30')[1];
	const zone = { south: 0.1, north: 22, west: 0.1, east: 22 };
	const bulk = { ...parseBulk(encodeBulk([
		{ relPath: '0', flags: 0 },                    // sud-ouest, retenu, on descend
		{ relPath: '2', flags: 0 },                    // nord-ouest : hors zone
		{ relPath: '00', flags: 8 },                   // NODATA : pas retenu, mais traversé
		{ relPath: '000', flags: 0 },                  // retenu sous un NODATA
		{ relPath: '001', flags: 4 },                  // LEAF : retenu, on ne descend plus
		{ relPath: '0010', flags: 0 },                 // sous un LEAF : jamais atteint
		{ relPath: '0000', flags: 0, bulkEpoch: 77 },  // frontière 4 digits -> bulk enfant
	])), epoch: 1014 };

	const { retained, children } = ge.expandBulk(bulk, '30', b30, zone, 22);
	const paths = retained.map((r) => r.path).sort();

	assert.ok(paths.includes('300'), 'le nœud sud-ouest doit être retenu');
	assert.ok(!paths.some((p) => p.startsWith('302')), 'la branche nord est hors zone');
	assert.ok(!paths.includes('3000'), 'un NODATA (flags & 8) ne se retient pas');
	assert.ok(paths.includes('30000'), 'on traverse un NODATA pour retenir dessous');
	assert.ok(paths.includes('30001'), 'un LEAF se retient');
	assert.ok(!paths.includes('300010'), 'un LEAF referme la branche');

	assert.deepEqual(children, [{ bulkPath: '300000', box: children[0]?.box, epoch: 77 }]);
	assert.equal(children[0].epoch, 77, 'le bulk enfant hérite du bulkEpoch déclaré, pas de celui du bulk courant');
});

await t('fournisseur : expandBulk ne rend jamais un nœud plus profond que le niveau demandé', () => {
	// Les chemins relatifs vont jusqu'à 4 digits : sans garde, un bulk à la
	// profondeur 20 rendrait des nœuds de profondeur 24 pour un niveau 21.
	// L'ancienne traversée ne le pouvait pas (ses cibles faisaient exactement
	// `level` digits) — c'est une divergence à ne pas introduire.
	const b30 = ROOTS.find(([p]) => p === '30')[1];
	const zone = { south: 0.1, north: 22, west: 0.1, east: 22 };
	const bulk = { ...parseBulk(encodeBulk([
		{ relPath: '0', flags: 0 }, { relPath: '00', flags: 0 },
		{ relPath: '000', flags: 0 }, { relPath: '0000', flags: 0 },
	])), epoch: 1014 };

	for (const level of [3, 4, 5]) {
		const { retained, children } = ge.expandBulk(bulk, '30', b30, zone, level);
		for (const r of retained) {
			assert.ok(r.path.length <= level, `niveau ${level} : ${r.path} (${r.path.length} digits) trop profond`);
		}
		for (const c of children) {
			assert.ok(c.bulkPath.length <= level, `niveau ${level} : bulk enfant ${c.bulkPath} au-delà du niveau`);
		}
	}
});

await t('fournisseur : la marche par bulks rend EXACTEMENT le même ensemble que l\'ancienne énumération', async () => {
	// LE test de la réécriture (issue #153). L'oracle en haut de ce fichier est
	// l'ancien algorithme, transcrit sans réseau ; la nouvelle traverse() passe
	// par le mock des fixtures. Les deux doivent rendre le même ensemble de
	// nœuds, avec les mêmes epochs et les mêmes flags — sinon la réécriture a
	// changé la sémantique en même temps que la complexité.
	//
	// Zone : l'emprise du nœud le plus profond de la capture, élargie, pour
	// que plusieurs branches de bulks soient réellement visitées.
	const deepest = FIX.nodes.reduce((a, b) => (a.path.length >= b.path.length ? a : b));
	const kml = doubles(readFields(read(deepest.file)).find((f) => f.num === 5).value);
	const pad = 0.002;
	const zone = { west: kml[0] - pad, south: kml[1] - pad, east: kml[3] + pad, north: kml[4] + pad };

	const bulks = fixtureBulks();
	const http = fixtureNet();

	// Niveaux 17 et 20 : l'oracle coûte 2^(niveau-2) chemins par cellule, donc
	// au-delà il ne termine pas en un temps de selftest (c'est tout le sujet de
	// l'issue). 20 traverse quand même QUATRE frontières de bulks (4/8/12/16),
	// donc la descente inter-bulks est bien exercée.
	for (const level of [17, 20]) {
		const expected = traverseByEnumerationReference(bulks, zone, level);
		const { nodes } = await withNet(http, () => ge.traverse(zone, level));

		const got = new Map(nodes.map((n) => [n.path, n]));
		assert.ok(expected.size > 0, `niveau ${level} : l'oracle ne retient rien, le test ne prouverait rien`);
		assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort(),
			`niveau ${level} : ensembles de chemins différents`);
		for (const [path, exp] of expected) {
			assert.equal(got.get(path).epoch, exp.epoch, `${path} : epoch`);
			assert.equal(got.get(path).imageryEpoch, exp.imageryEpoch, `${path} : imageryEpoch`);
			assert.equal(got.get(path).flags, exp.flags, `${path} : flags`);
		}
	}
});

await t('décodeur : un tileDir de fixtures se décode et respecte le contrat', async () => {
	const dir = makeFixtureTileDir();
	try {
		assert.equal(pick(dir).id, 'rocktree', 'sniff par reniflage');
		const lines = [];
		const d = await rocktree.decode(dir, { onLog: (l) => lines.push(l) });

		assert.ok(d.vertCount > 0);
		assert.equal(d.tu.length, d.vertCount, 'un UV par sommet');
		for (const m of d.materials) assert.ok(Buffer.isBuffer(m.texture), 'textures en Buffer');
		// ECEF plausible sur un échantillon.
		const vx = d.vx.view(), vy = d.vy.view(), vz = d.vz.view();
		const r = Math.hypot(vx[0], vy[0], vz[0]);
		assert.ok(r > 6.35e6 && r < 6.4e6, `|v0| = ${r}`);
		// UV moteur dans [0,1].
		const tu = d.tu.view(), tv = d.tv.view();
		for (let i = 0; i < d.vertCount; i += 101) {
			assert.ok(tu[i] >= -0.01 && tu[i] <= 1.01);
			assert.ok(tv[i] >= -0.01 && tv[i] <= 1.01);
		}
		// Les indices de triangles pointent dans les sommets.
		for (const g of d.triByMat) {
			const gv = g.view();
			for (let i = 0; i < g.length; i += 2) assert.ok(gv[i] < d.vertCount);
		}
		// L'attribution vient des tuiles (niveau 3 du design).
		assert.ok(d.attribution.length > 0);
		assert.ok(d.attribution.some((s) => /Google/.test(s)));
		// Les deux lignes au mot près du contrat parsePrepLine.
		assert.ok(lines.some((l) => /^\s*\d+ materials, \d+ without a texture$/.test(l)), lines.join('|'));
		assert.ok(lines.some((l) => /^\s*[\d\s, .]+ vertices, [\d\s, .]+ uvs, [\d\s, .]+ triangles$/.test(l)));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await t('décodeur : les sommets ECEF convertissent en altitude WGS84 plausible (verrou sphère→ellipsoïde, issue #18 Task 9)', async () => {
	// Régression pour le bug réel du bake Champ de Mars : rocktree.mjs plaçait
	// ses sommets sur une SPHÈRE (le rayon protocolaire de PlanetoidMetadata,
	// 6 371 010 m — pas la constante IUGG 6 371 000 utilisée un temps par ce
	// décodeur, qui biaisait chaque altitude de +10 m), pas sur l'ellipsoïde
	// WGS84 que prep.mjs (Bowring) attend. Sans la reconversion
	// sphereToWgs84Ecef(), la même conversion ci-dessous rend une latitude
	// fausse de 0,19° et une altitude ~5100 m au lieu de quelques dizaines de
	// mètres — c'est ce que ce test aurait détecté.
	// Bowring réécrite ici (et non importée de prep.mjs) : prep.mjs n'exporte
	// pas ecefToGeodetic, et CLAUDE.md demande de ne pas retoucher sa
	// géodésie ECEF→ENU sans raison — la dupliquer dans un test n'en est pas
	// une modification.
	const A = 6378137.0, F = 1 / 298.257223563, B = A * (1 - F);
	const E2 = 1 - (B * B) / (A * A), EP2 = (A * A - B * B) / (B * B);
	function ecefToGeodeticAlt(x, y, z) {
		const p = Math.hypot(x, y);
		const theta = Math.atan2(z * A, p * B);
		const lat = Math.atan2(z + EP2 * B * Math.sin(theta) ** 3, p - E2 * A * Math.cos(theta) ** 3);
		const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
		return p / Math.cos(lat) - N; // altitude seule ; lat/lon non nécessaires ici
	}

	const dir = makeFixtureTileDir();
	try {
		const d = await rocktree.decode(dir, {});
		const vx = d.vx.view(), vy = d.vy.view(), vz = d.vz.view();
		// Mesuré sur cette fixture (capture Paris réelle, rayon protocolaire
		// 6 371 010 m) : altitude dans [16.2, 79.4] m sur 3621 sommets
		// échantillonnés (pas de terrain élevé dans cette capture-là) — [0, 400]
		// ci-dessous est donc un seuil large, pas serré au point de casser sur
		// une fixture future qui inclurait un toit ou la Tour Eiffel, tout en
		// restant très en dessous des ~5100 m que rendrait la régression
		// sphère→ellipsoïde (et bien au-dessus du biais de +10 m que rendrait
		// à lui seul un retour à l'ancienne constante 6 371 000).
		let sampled = 0, outOfRange = 0;
		for (let i = 0; i < d.vertCount; i += 7) {
			const alt = ecefToGeodeticAlt(vx[i], vy[i], vz[i]);
			sampled++;
			if (!(alt >= 0 && alt <= 400)) outOfRange++;
		}
		assert.ok(sampled > 100, `échantillon trop petit (${sampled})`);
		assert.ok(outOfRange / sampled <= 0.01,
			`${outOfRange}/${sampled} sommets hors [0, 400] m — sphère→ellipsoïde probablement absente`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await t('fournisseur : dropFillinAncestors écarte tout chemin retenu préfixe strict d\'un autre', () => {
	// Reproduit la forme du scénario réel qui a cassé le bake Champ de Mars :
	// un ancêtre coarse ("30"), un ancêtre intermédiaire séparé de son
	// descendant par PLUS d'un digit ("3060" -> "306040", pas "30601" — les
	// niveaux NODATA sautés par traverse() dans la vraie boucle), un ancêtre
	// immédiatement adjacent à son descendant ("306040" -> le leaf), et une
	// branche "31" totalement indépendante qui ne doit pas être touchée.
	const synth = new Map([
		['30', {}],
		['3060', {}],
		['306040', {}],
		['30604060716362605075', {}],
		['31', {}],
	]);
	const dropped = ge.dropFillinAncestors(synth);
	assert.equal(dropped, 3, `attendu 3 ancêtres écartés (30, 3060, 306040), eu ${dropped}`);
	assert.deepEqual([...synth.keys()].sort(), ['30604060716362605075', '31']);

	// L'invariant lui-même, avec le même lookahead trié que le code : après
	// filtrage, aucun chemin retenu ne doit être un préfixe strict d'un autre.
	const sorted = [...synth.keys()].sort();
	for (let i = 0; i + 1 < sorted.length; i++) {
		assert.ok(!sorted[i + 1].startsWith(sorted[i]),
			`${sorted[i]} est un préfixe strict de ${sorted[i + 1]} — un ancêtre fill-in a survécu`);
	}
});

await t('fournisseur : traversée sur fixtures — plan/probe/fetch sans réseau', async () => {
	await withNet(fixtureNet(), async () => {
		// Le nœud le plus profond des fixtures (niveau 22) : viser sa propre
		// kml_bounding_box comme zone, à ce même niveau, garantit que la
		// traversée retombe exactement dessus en suivant une chaîne de bulks
		// entièrement présente dans la capture (ruling task-6 #5) — plutôt que
		// de dépendre d'un niveau intermédiaire dont le bulk enfant peut manquer.
		const deepest = FIX.nodes.reduce((a, b) => (a.path.length >= b.path.length ? a : b));
		const kml = doubles(readFields(read(deepest.file)).find((f) => f.num === 5).value);
		// Ordre mesuré empiriquement sur les fixtures (imprimé une fois) :
		// [west, south, altMin, east, north, altMax] — PAS n,s,e,w,altMax,altMin.
		const zone = { bbox: { west: kml[0], south: kml[1], east: kml[3], north: kml[4] } };
		const zoom = deepest.path.length; // 22

		// plan() traverse maintenant pour de vrai (issue #153) : `columns` est le
		// nombre de nœuds RÉELLEMENT retenus, pas une majoration géométrique.
		// La preuve : il doit coïncider avec ce que rend traverse() elle-même.
		const plan = await ge.plan({ ...zone, zoom });
		const { nodes } = await ge.traverse(zone.bbox, ge.zoomToLevel(zoom));
		assert.equal(plan.columns, nodes.length,
			'plan() doit rendre le compte réel de la traversée, pas une estimation');
		assert.ok(plan.columns >= 1, `plan.columns = ${plan.columns}`);

		const probe = await ge.probe({ ...zone, zoom });
		assert.equal(probe.status, 'ok', probe.message);

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-fetch-'));
		ge._cacheRootForTests(tmp);
		try {
			const res = await ge.fetch({ ...zone, zoom });
			assert.ok(fs.existsSync(path.join(res.tileDir, 'rocktree-tile.json')));
			const tile = JSON.parse(fs.readFileSync(path.join(res.tileDir, 'rocktree-tile.json'), 'utf8'));
			assert.ok(tile.nodes.length >= 1);
			assert.ok(Object.keys(tile.copyrights).length >= 1, 'copyrights résolus');
			// Le rayon protocolaire (PlanetoidMetadata) voyage jusque dans le
			// tileDir écrit par fetch() — servi ici par le vrai planetoid.pb de
			// la fixture, donc lu naturellement, pas une valeur du mock.
			assert.equal(tile.radius, 6371010, 'rayon planetoid écrit dans rocktree-tile.json');
			assert.ok(ge.tileIsUsable(res.tileDir));
			// Et le tileDir produit se décode : la boucle est bouclée hors-ligne.
			const d = await rocktree.decode(res.tileDir, {});
			assert.ok(d.vertCount > 0);
		} finally {
			ge._cacheRootForTests(null);
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

await t('fournisseur : au niveau 21, le coût suit les nœuds présents — pas 2^19 par cellule (issue #153)', async () => {
	// LE test de complexité. Un octree synthétique DENSE en lat/lon mais à une
	// seule variante verticale par cellule (la forme d'un vrai rocktree : le
	// bit vertical distingue dessus/dessous du sol, les deux n'existent
	// quasiment jamais ensemble) : chaque nœud a les 4 quadrants lat/lon,
	// digits 0 à 3.
	//
	// L'ancienne énumération ne regardait PAS les données : elle produisait
	// cellules × 2^(niveau-2) chemins quoi qu'il y ait dans l'arbre. Mesuré sur
	// cette machine : 68 157 440 chemins en 42,0 s pour la zone de 240 m
	// ci-dessous, et 1 km sans terminer (>60 s, 82 M de chemins atteints).
	//
	// On compte les APPELS RÉSEAU plutôt que les secondes : c'est déterministe
	// et indépendant de la machine, là où un seuil en millisecondes ne mesure
	// que le CPU du jour. Le chrono est imprimé, pas asserté serré.
	const DIGITS = [0, 1, 2, 3];
	const entries = [];
	(function gen(rel) {
		for (const d of DIGITS) {
			const r = rel + d;
			entries.push({ relPath: r, flags: 0, bulkEpoch: r.length === 4 ? FIX.epoch : undefined });
			if (r.length < 4) gen(r);
		}
	})('');
	// Tous les bulks de cet arbre ont le même contenu relatif : un seul buffer
	// encodé sert pour n'importe quel chemin de bulk.
	const denseBulk = encodeBulk(entries);
	const planetoid = read(FIX.planetoid);

	let httpCalls = 0;
	const denseNet = async (url) => {
		httpCalls++;
		const key = url.replace('https://kh.google.com/rt/earth/', '');
		if (key === 'PlanetoidMetadata') return planetoid;
		if (key.startsWith('BulkMetadata/')) return denseBulk;
		const e = new Error(`404 ${key}`); e.status = 404; throw e;
	};

	const lat = 48.8582, lon = 2.2945, level = 21;
	// Bornes déduites de la géométrie de l'octree, pas d'un run : au niveau 20
	// (dernière frontière de bulk avant 21) une cellule fait ~38 m de côté en
	// latitude, donc une zone de N mètres en recoupe ~(N/38 + 1)^2. Les bornes
	// ci-dessous laissent un facteur ~2 de marge sur ce compte.
	for (const [label, radius, maxCalls] of [['240 m', 120, 400], ['1 km', 500, 3000]]) {
		const dLat = radius / 111320, dLon = dLat / Math.cos(lat * Math.PI / 180);
		const zone = { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };

		httpCalls = 0;
		const t0 = Date.now();
		const { nodes, visitedBulks } = await withNet(denseNet, () => ge.traverse(zone, level));
		const ms = Date.now() - t0;

		// Ce qu'aurait énuméré l'ancien algorithme sur la MÊME zone, calculé
		// analytiquement (le faire tourner prendrait des minutes) : une cellule
		// lat/lon vaut 2^(niveau-2) chemins à cause de la duplication verticale.
		const cellDeg = 90 / 2 ** (level - 2);
		const oldPaths = (Math.ceil((zone.north - zone.south) / cellDeg) + 1)
			* (Math.ceil((zone.east - zone.west) / cellDeg) + 1) * 2 ** (level - 2);

		console.log(`      ${label} niveau ${level} : ${nodes.length} nœuds, ${visitedBulks} bulks, `
			+ `${httpCalls} requêtes, ${ms} ms — l'ancienne énumération : ${oldPaths.toExponential(1)} chemins`);

		assert.ok(nodes.length > 0, `${label} : rien retenu, l'arbre synthétique ne sert à rien`);
		assert.ok(httpCalls <= maxCalls,
			`${label} : ${httpCalls} requêtes (> ${maxCalls}) — le coût ne suit plus les nœuds présents`);
		// Filet large : même sur une machine lente, une marche qui suit les
		// données ne prend pas 30 s là où l'ancienne en prenait 42.
		assert.ok(ms < 30_000, `${label} : ${ms} ms`);
	}
});

await t('fournisseur : une zone démesurée est refusée par un plafond de nœuds, pas par une pendaison', async () => {
	// L'ancien garde-fou comparait des COLONNES lat/lon (~4 400 pour 500 m au
	// niveau 21) à une limite de 200 000 : il ne se déclenchait jamais sur une
	// zone normale, alors que le coût réel était colonnes × 2^19. Le nouveau
	// plafond compte ce qui coûte vraiment — les nœuds retenus — et lève une
	// erreur française explicite.
	const DIGITS = [0, 1, 2, 3];
	const entries = [];
	(function gen(rel) {
		for (const d of DIGITS) {
			const r = rel + d;
			entries.push({ relPath: r, flags: 0, bulkEpoch: r.length === 4 ? FIX.epoch : undefined });
			if (r.length < 4) gen(r);
		}
	})('');
	const denseBulk = encodeBulk(entries);
	const planetoid = read(FIX.planetoid);
	const denseNet = async (url) => {
		const key = url.replace('https://kh.google.com/rt/earth/', '');
		if (key === 'PlanetoidMetadata') return planetoid;
		if (key.startsWith('BulkMetadata/')) return denseBulk;
		const e = new Error(`404 ${key}`); e.status = 404; throw e;
	};

	// Un département entier au niveau 21 : des millions de nœuds.
	const zone = { south: 48.5, north: 49.2, west: 2.0, east: 2.8 };
	await assert.rejects(
		() => withNet(denseNet, () => ge.traverse(zone, 21, { maxNodes: 5000 })),
		/zone trop grande/,
		'la traversée doit refuser explicitement, pas partir pour des heures'
	);
});

console.log(`rocktree-selftest : ${n} tests ok`);

})();
