// Selftest de build-node.mjs (#187) : la géométrie que le Worker enverra à
// Three/Rapier doit être CELLE que le décodeur de référence (bake, vérifié
// en prod) calcule — même transformation sphère→WGS84→ENU, mêmes UV, mêmes
// gardes de strip. Oracle : loadMeshes() de tools/lib/decoders/rocktree.mjs
// sur les fixtures réelles (capture Paris epoch 1014). On compare les
// POSITIONS et les invariants, pas les listes de triangles : la référence
// tronque à layerBounds[3] et l'écart est pré-existant (suivi séparé).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeGeometries } from './lib/rocktree/build-node.mjs';
import { parseNode, parsePlanetoid } from './lib/rocktree/proto.mjs';
import { unpackIndices, unpackLayerBoundsAndOctants, unpackVertices } from './lib/rocktree/unpack.mjs';
import { geodeticToEcef, enuBasis, localEnuToEcef } from './lib/rocktree/geodesy.mjs';
import { loadMeshes } from './lib/decoders/rocktree.mjs';

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
