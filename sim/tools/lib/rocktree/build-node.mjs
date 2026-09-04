// Géométrie d'un nœud rocktree prête pour Three/Rapier, SANS Three (#187).
// Extrait de buildNodeMesh() (src/main.js) pour tourner dans
// src/rocktree-worker.js : chaque nœud coûtait ~0,3-2,6 ms de conversion sur
// le fil principal, et pendant une vague ce travail participait à faire
// déborder la frame de 16,7 ms (spirale de rattrapage de l'accumulateur
// physique). Aucune dépendance : portable Worker ET Node (selftest de parité
// contre le décodeur de référence tools/lib/decoders/rocktree.mjs).
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './unpack.mjs';
import { sphereToWgs84Ecef, ecefToLocalEnu } from './geodesy.mjs';

// matrix (node.matrix) place les sommets sur une SPHÈRE, pas l'ellipsoïde
// WGS84 — sphereToWgs84Ecef() est la correction, PAS une formalité :
// l'omettre a mesuré 5 km d'erreur sur #18 Task 9.
export function buildNodeGeometries({ matrix, meshes, sphereRadius, originEcef, originBasis, exclude = [] }) {
	const ma = matrix;
	const excludeSet = new Set(exclude);
	const built = [];
	for (const m of meshes) {
		const { xyz, count } = unpackVertices(m.vertices);
		const positions = new Float32Array(count * 3);
		// bounding box locale au fil du remplissage : la sphère englobante est
		// dérivée EXACTEMENT comme Three.computeBoundingSphere() (centre =
		// milieu de la bbox, rayon = distance max au centre) pour que le
		// frustum culling soit identique à ce qu'il aurait calculé lui-même —
		// le calcul paresseux de Three tournait à la première frame visible de
		// chaque mesh, en pleine vague.
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		for (let v = 0; v < count; v++) {
			const x = xyz[v * 3], y = xyz[v * 3 + 1], z = xyz[v * 3 + 2];
			const ecef = sphereToWgs84Ecef(
				x * ma[0] + y * ma[4] + z * ma[8] + ma[12],
				x * ma[1] + y * ma[5] + z * ma[9] + ma[13],
				x * ma[2] + y * ma[6] + z * ma[10] + ma[14],
				sphereRadius,
			);
			const local = ecefToLocalEnu(ecef, originEcef, originBasis);
			positions[v * 3] = local.x; positions[v * 3 + 1] = local.y; positions[v * 3 + 2] = local.z;
			if (local.x < minX) minX = local.x; if (local.x > maxX) maxX = local.x;
			if (local.y < minY) minY = local.y; if (local.y > maxY) maxY = local.y;
			if (local.z < minZ) minZ = local.z; if (local.z > maxZ) maxZ = local.z;
		}
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
		let r2 = 0;
		for (let v = 0; v < count; v++) {
			const dx = positions[v * 3] - cx, dy = positions[v * 3 + 1] - cy, dz = positions[v * 3 + 2] - cz;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > r2) r2 = d2;
		}

		// Triangle strip -> triangles indépendants. Écrit directement dans un
		// Uint32Array surdimensionné (3 index par pas de strip au plus) puis
		// tronqué : pas de tableau JS intermédiaire à faire collecter pendant
		// une vague.
		const strip = unpackIndices(m.indices);
		// Deux gardes, pas une, toutes deux reprises de forEachDrawnTriangle()
		// du décodeur de référence :
		//  - layerBounds[3] = début de TERRAIN_HIDDEN. Au-delà, le strip décrit
		//    du relief que le protocole ne fait PAS dessiner ; le parcourir
		//    quand même superposait cette couche au terrain visible ET la
		//    rendait solide côté Rapier (#178).
		//  - exclude : octants dont un enfant retenu dessine déjà la géométrie
		//    (z-fight sinon), normalement vide après dropFillinAncestors().
		// layerBounds impose de lire layer_and_octant_counts pour CHAQUE mesh,
		// donc le calcul paresseux d'octantOf n'a plus de raison d'être : c'est
		// la même passe. Surcoût payé dans le Worker, pas sur le fil principal
		// (#187).
		const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(m.layerAndOctantCounts, strip, count);
		const end = Math.min(layerBounds[3], strip.length);
		// Triangles dégénérés (aire nulle, courants aux jonctions d'un strip)
		// écartés au passage : une géométrie de collision qui en contient
		// déstabilise la résolution de contact Rapier (#176).
		const idxAll = new Uint32Array(Math.max(0, end - 2) * 3);
		let w = 0;
		for (let s = 0; s + 2 < end; s++) {
			const a = strip[s], b = strip[s + 1], c = strip[s + 2];
			if (a === b || a === c || b === c) continue;
			if (excludeSet.size && excludeSet.has(octantOf[a])) continue;
			if (s % 2 === 0) { idxAll[w++] = a; idxAll[w++] = b; idxAll[w++] = c; }
			else { idxAll[w++] = b; idxAll[w++] = a; idxAll[w++] = c; }
		}
		const indices = idxAll.slice(0, w);

		// Même normalisation UV que le décodeur de référence : offset+scale du
		// proto quand il est là, sinon le repli (0.5, 1/mod) du protocole. PAS
		// d'inversion de V (origine haut-gauche du protocole, mesuré #158/#180).
		let uvs = null;
		if (m.texCoords) {
			const { uv: rawUv, uMod, vMod } = unpackTexCoords(m.texCoords, count);
			const [ou, ov, su, sv] = m.uvOffsetAndScale ?? [0.5, 0.5, 1 / uMod, 1 / vMod];
			uvs = new Float32Array(count * 2);
			for (let v = 0; v < count; v++) {
				uvs[v * 2] = (rawUv[v * 2] + ou) * su;
				uvs[v * 2 + 1] = (rawUv[v * 2 + 1] + ov) * sv;
			}
		}

		built.push({
			positions,
			uvs,
			indices,
			boundingSphere: { center: [cx, cy, cz], radius: Math.sqrt(r2) },
		});
	}
	return built;
}
