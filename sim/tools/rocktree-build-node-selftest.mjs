// Selftest de build-node.mjs (#187) : la géométrie que le Worker enverra à
// Three/Rapier doit être CELLE que le décodeur de référence (bake, vérifié
// en prod) calcule — même transformation sphère→WGS84→ENU, mêmes UV, mêmes
// gardes de strip. Oracle : loadMeshes() de tools/lib/decoders/rocktree.mjs
// sur les fixtures réelles (capture Paris epoch 1014). Positions, invariants
// ET listes de triangles : depuis #178 les deux tronquent à layerBounds[3],
// donc la parité est exigible sur le triangle près, pas seulement sur les
// sommets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeGeometries } from './lib/rocktree/build-node.mjs';
import { parseNode, parsePlanetoid } from './lib/rocktree/proto.mjs';
import { unpackIndices, unpackLayerBoundsAndOctants, unpackVertices } from './lib/rocktree/unpack.mjs';
import { geodeticToEcef, enuBasis, localEnuToEcef } from './lib/rocktree/geodesy.mjs';
import { loadMeshes, forEachDrawnTriangle } from './lib/decoders/rocktree.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');
const FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

const RADIUS = parsePlanetoid(read(FIX.planetoid)).radius;
// Origine ENU arbitraire mais RÉALISTE (près de la capture Paris) : la parité
// doit tenir pour une origine quelconque, pas seulement (0,0).
const ORIGIN = { lat: 48.8584, lon: 2.2945 };
const ORIGIN_ECEF = geodeticToEcef(ORIGIN.lat, ORIGIN.lon, 0);
const BASIS = enuBasis(ORIGIN.lat, ORIGIN.lon);

const buildFixture = (nf, exclude = []) => buildNodeGeometries({
	...parseNode(read(nf.file)),
	sphereRadius: RADIUS,
	originEcef: ORIGIN_ECEF,
	originBasis: BASIS,
	exclude,
});

await t('parité positions : ENU recomposé en ECEF = le décodeur de référence, sur chaque fixture', () => {
	for (const nf of FIX.nodes) {
		const ref = loadMeshes(DIR, [{ file: nf.file }], RADIUS, null);
		const built = buildFixture(nf);
		assert.equal(built.length, ref.length, `${nf.path} : nombre de meshes`);
		for (let mi = 0; mi < built.length; mi++) {
			const b = built[mi], r = ref[mi];
			assert.equal(b.positions.length, r.pos.length, `${nf.path}#${mi} : nombre de sommets`);
			// Tolérance : les positions locales sont en Float32 (mètres, |valeur|
			// < ~10 km ici) — l'aller-retour ENU→ECEF réintroduit ce bruit sur
			// des coordonnées de ~6,4e6 m. 1e-1 m est large pour du Float32
			// local, et mille fois trop serré pour laisser passer une erreur de
			// transformation (l'oubli de sphereToWgs84Ecef = ~5 km, #18 Task 9).
			for (let v = 0; v < b.positions.length; v += 3) {
				const ecef = localEnuToEcef(
					{ x: b.positions[v], y: b.positions[v + 1], z: b.positions[v + 2] },
					ORIGIN_ECEF, BASIS,
				);
				for (let k = 0; k < 3; k++) {
					assert.ok(Math.abs(ecef[k] - r.pos[v + k]) < 1e-1,
						`${nf.path}#${mi} sommet ${v / 3} axe ${k} : ${ecef[k]} vs ${r.pos[v + k]}`);
				}
			}
		}
	}
});

// forEachDrawnTriangle() émet (a,b,c) puis (a,c,b) un pas sur deux, alors que
// build-node écrit (a,b,c) puis (b,a,c) — deux rotations du MÊME triangle
// orienté. La comparaison porte donc sur la rotation canonique (plus petit
// index en tête, ordre cyclique conservé) : identique ⇔ même triangle, même
// sens. Comparer les triplets bruts confondrait un vrai écart de winding avec
// ce choix d'écriture.
const canon = (a, b, c) => {
	if (a <= b && a <= c) return `${a},${b},${c}`;
	if (b <= a && b <= c) return `${b},${c},${a}`;
	return `${c},${a},${b}`;
};

await t('parité triangles : mêmes triangles dessinés que le décodeur de référence (#178)', () => {
	let hidden = 0;
	for (const nf of FIX.nodes) {
		const ref = loadMeshes(DIR, [{ file: nf.file }], RADIUS, null);
		const built = buildFixture(nf);
		for (let mi = 0; mi < built.length; mi++) {
			const b = built[mi], r = ref[mi];
			const expected = [];
			forEachDrawnTriangle(r, new Set(), (a, bb, c) => expected.push(canon(a, bb, c)));
			assert.equal(b.indices.length / 3, expected.length,
				`${nf.path}#${mi} : ${b.indices.length / 3} triangles construits vs ${expected.length} dessinés`);
			for (let i = 0; i < expected.length; i++) {
				assert.equal(canon(b.indices[i * 3], b.indices[i * 3 + 1], b.indices[i * 3 + 2]), expected[i],
					`${nf.path}#${mi} triangle ${i}`);
			}
			hidden += Math.max(0, r.strip.length - r.end);
		}
	}
	// Mesuré : layerBounds[3] === strip.length sur les six maillages des
	// fixtures — aucun n'a de couche TERRAIN_HIDDEN, donc la troncature ne
	// mord pas ici et ce test seul passerait aussi sans elle. Il garde le
	// déroulé de strip, le winding et le filtre dégénéré ; c'est le test
	// suivant, sur un layer_and_octant_counts fabriqué, qui prouve la
	// troncature elle-même.
	assert.equal(hidden, 0, 'une fixture a gagné une couche cachée : ce commentaire est à refaire');
});

// Encodeur varint (LEB128), miroir de readVarint() de lib/rocktree/pb.mjs.
const varint = (v) => {
	const out = [];
	do { const b = v & 0x7f; v = Math.floor(v / 128); out.push(v ? b | 0x80 : b); } while (v);
	return out;
};

// layer_and_octant_counts fabriqué : `len` varints, une borne de couche tous
// les 8 (cf. unpackLayerBoundsAndOctants). Avec 32 valeurs, layerBounds[3] est
// le cumul atteint à l'indice 24 — on le pose donc à `visible` en mettant tout
// le reste du strip dans le groupe suivant. Tous les octants valent 0 (i & 7
// pour i = 0 et 24), ce qui laisse `exclude` hors du chemin testé.
const craftLayerCounts = (visible, total) => {
	const values = new Array(32).fill(0);
	values[0] = visible;
	values[24] = total - visible;
	return Uint8Array.from([...varint(values.length), ...values.flatMap(varint)]);
};

await t('troncature : layerBounds[3] coupe le strip, et coupe au même endroit que la référence (#178)', () => {
	const nf = FIX.nodes.find((f) => unpackIndices(parseNode(read(f.file)).meshes[0].indices).length > 100);
	const node = parseNode(read(nf.file));
	const m = node.meshes[0];
	const { count } = unpackVertices(m.vertices);
	const strip = unpackIndices(m.indices);
	const visible = Math.floor(strip.length / 2);

	const [full] = buildNodeGeometries({
		...node, sphereRadius: RADIUS, originEcef: ORIGIN_ECEF, originBasis: BASIS,
		meshes: [m],
	});
	const [cut] = buildNodeGeometries({
		...node, sphereRadius: RADIUS, originEcef: ORIGIN_ECEF, originBasis: BASIS,
		meshes: [{ ...m, layerAndOctantCounts: craftLayerCounts(visible, strip.length) }],
	});

	assert.ok(cut.indices.length < full.indices.length,
		`la troncature n'a rien retiré : ${cut.indices.length} vs ${full.indices.length} index`);
	// Ce qui reste est exactement le début de ce qui était produit sans
	// troncature : on a coupé une queue, pas réordonné ni perdu autre chose.
	for (let i = 0; i < cut.indices.length; i++) {
		assert.equal(cut.indices[i], full.indices[i], `index ${i}`);
	}
	// Et la coupe tombe où la référence la met, sur les mêmes octets.
	const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(
		craftLayerCounts(visible, strip.length), strip, count);
	assert.equal(layerBounds[3], visible, 'la fabrication de layerBounds[3] est fausse');
	const expected = [];
	forEachDrawnTriangle({ strip, octantOf, end: Math.min(layerBounds[3], strip.length), pos: null },
		new Set(), (a, b, c) => expected.push(canon(a, b, c)));
	assert.equal(cut.indices.length / 3, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.equal(canon(cut.indices[i * 3], cut.indices[i * 3 + 1], cut.indices[i * 3 + 2]), expected[i],
			`triangle ${i}`);
	}
});

await t('UV : normalisés dans [0,1] sur toutes les fixtures, null sans texCoords', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		const built = buildFixture(nf);
		built.forEach((b, mi) => {
			if (!node.meshes[mi].texCoords) { assert.equal(b.uvs, null); return; }
			for (const u of b.uvs) assert.ok(u >= 0 && u <= 1, `${nf.path}#${mi} : uv ${u} hors [0,1]`);
		});
	}
});

await t('strip : aucun triangle dégénéré dans les indices produits', () => {
	for (const nf of FIX.nodes) {
		for (const b of buildFixture(nf)) {
			assert.equal(b.indices.length % 3, 0);
			for (let i = 0; i < b.indices.length; i += 3) {
				const [a, bb, c] = [b.indices[i], b.indices[i + 1], b.indices[i + 2]];
				assert.ok(a !== bb && a !== c && bb !== c, `triangle dégénéré ${a},${bb},${c}`);
			}
		}
	}
});

await t('boundingSphere : contient tous les sommets (algorithme de Three, culling identique)', () => {
	for (const nf of FIX.nodes) {
		for (const b of buildFixture(nf)) {
			const { center: [cx, cy, cz], radius } = b.boundingSphere;
			for (let v = 0; v < b.positions.length; v += 3) {
				const d = Math.hypot(b.positions[v] - cx, b.positions[v + 1] - cy, b.positions[v + 2] - cz);
				assert.ok(d <= radius + 1e-3, `sommet ${v / 3} à ${d} m du centre, rayon ${radius}`);
			}
		}
	}
});

await t('exclude : retire les triangles de l\'octant exclu, et seulement eux', () => {
	// Prend le premier mesh de la première fixture et un octant réellement
	// présent dans son strip — même sémantique que forEachDrawnTriangle()
	// (octant du PREMIER sommet du triangle dans le strip).
	const nf = FIX.nodes[0];
	const node = parseNode(read(nf.file));
	const m = node.meshes[0];
	const { count } = unpackVertices(m.vertices);
	const strip = unpackIndices(m.indices);
	const { octantOf } = unpackLayerBoundsAndOctants(m.layerAndOctantCounts, strip, count);
	const oct = octantOf[strip[0]];
	const [all] = buildFixture(nf);
	const [pruned] = buildFixture(nf, [oct]);
	assert.ok(pruned.indices.length < all.indices.length, 'exclude n\'a rien retiré');
	for (let i = 0; i < pruned.indices.length; i += 3) {
		assert.notEqual(octantOf[pruned.indices[i]], oct, 'un triangle de l\'octant exclu a survécu');
	}
});

console.log(`rocktree-build-node-selftest : ${n} tests ok`);
