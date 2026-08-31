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
import { rootOctant, childBoxes, octantsCovering, ROOTS } from './lib/rocktree/octant.mjs';
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
	fs.writeFileSync(path.join(dir, 'rocktree-tile.json'), JSON.stringify({
		provider: 'google-earth', epoch: FIX.epoch, level: 16,
		fetchedAt: '2026-08-31T00:00:00.000Z', copyrights,
		nodes: FIX.nodes.map((nf) => ({ path: nf.path, file: `nodes/${nf.path}.pb`, exclude: [] })),
	}, null, '\t'));
	return dir;
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

await t('planetoid : epoch racine 1014 (constaté live le 2026-08-31)', () => {
	assert.equal(parsePlanetoid(read(FIX.planetoid)).rootEpoch, FIX.epoch);
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

await t('octant : octantsCovering rend, au niveau des fixtures, un surensemble de leurs chemins', () => {
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
	// ses sommets sur une SPHÈRE de rayon terrestre moyen (6 371 000 m), pas
	// sur l'ellipsoïde WGS84 que prep.mjs (Bowring) attend. Sans la
	// reconversion sphereToWgs84Ecef(), la même conversion ci-dessous rend
	// une latitude fausse de 0,19° et une altitude ~5100 m au lieu de
	// quelques dizaines de mètres — c'est ce que ce test aurait détecté.
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
		// Mesuré sur cette fixture (capture Paris réelle) : altitude dans
		// [26.2, 89.4] m sur 3621 sommets échantillonnés (pas de terrain élevé
		// dans cette capture-là) — [0, 400] ci-dessous est donc un seuil large,
		// pas serré au point de casser sur une fixture future qui inclurait
		// un toit ou la Tour Eiffel, tout en restant très en dessous des
		// ~5100 m que rendrait la régression sphère→ellipsoïde.
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
	// Sert les fixtures à la place de kh.google.com. Toute URL hors fixture
	// répond 404 (nœud/bulk absent) : la traversée doit s'en accommoder.
	const served = new Map();
	served.set('PlanetoidMetadata', read(FIX.planetoid));
	served.set(`Copyrights/pb=!1u${FIX.epoch}`, read(FIX.copyrights));
	for (const b of FIX.bulks) served.set(`BulkMetadata/pb=!1m2!1s${b.path}!2u${b.epoch}`, read(b.file));
	for (const nf of FIX.nodes) served.set(nf.url.replace('https://kh.google.com/rt/earth/', ''), read(nf.file));

	const realHttp = ge._net.http;
	ge._net.http = async (url) => {
		const key = url.replace('https://kh.google.com/rt/earth/', '');
		if (!served.has(key)) { const e = new Error(`404 ${key}`); e.status = 404; throw e; }
		return served.get(key);
	};
	try {
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

		const plan = await ge.plan({ ...zone, zoom });
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
			assert.ok(ge.tileIsUsable(res.tileDir));
			// Et le tileDir produit se décode : la boucle est bouclée hors-ligne.
			const d = await rocktree.decode(res.tileDir, {});
			assert.ok(d.vertCount > 0);
		} finally {
			ge._cacheRootForTests(null);
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	} finally {
		ge._net.http = realHttp;
	}
});

console.log(`rocktree-selftest : ${n} tests ok`);

})();
