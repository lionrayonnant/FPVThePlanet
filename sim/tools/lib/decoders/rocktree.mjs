// Décodeur rocktree — le format du fournisseur google-earth (issue #18).
// Chaque nœud d'octree porte sa matrice mesh->globe : les sommets uint8
// locaux deviennent des ECEF Float64 ici même, prep.mjs rebasera en ENU.
import fs from 'node:fs';
import path from 'node:path';
import { Growable } from '../growable.mjs';
import { parseNode } from '../rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from '../rocktree/unpack.mjs';

export const id = 'rocktree';

export function sniff(tileDir) {
	return fs.existsSync(path.join(tileDir, 'rocktree-tile.json'));
}

// Google's rocktree node matrices place vertices on a SPHERE, not the WGS84
// ellipsoid prep.mjs's ecefToGeodetic (Bowring) expects — a decoder contract
// mismatch found baking Champ de Mars real (issue #18 Task 9): the raw
// matrix-transformed points satisfied asin(z/r) ≈ the true geodetic latitude
// and r - radius ≈ the true altitude (19..363 m across a tile whose tallest
// point is the Eiffel Tower) to within tens of metres, while running the
// SAME points through a proper WGS84 ellipsoidal inverse landed 0.19° / ~5 km
// off — a geocentric-sphere feed "read" as if it were oblate-ellipsoid ECEF,
// which it structurally isn't (verified against three independent vertices
// and the tile's whole vertex cloud, not asserted from one sample).
// Re-expressed here as true WGS84 ellipsoidal ECEF, so prep.mjs's shared
// geodesy — origin, ENU basis, every downstream ground query — sees the same
// contract Flyover's OBJ decoder already gives it, without prep.mjs needing
// to know which decoder produced its input.
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
// The sphere's own radius travels with the tile (PlanetoidMetadata field 2,
// read by providers/google-earth.mjs and written into rocktree-tile.json as
// `radius`) — this is only the fallback for a tileDir cut before that field
// existed. Value: PlanetoidMetadata field 2, constaté 6 371 010.0 exactement
// sur la capture Paris du 2026-08-31 (tools/testdata/rocktree/planetoid.pb) —
// not IUGG's rounded 6 371 000, which biased every converted altitude +10 m.
const PLANETOID_RADIUS_FALLBACK = 6371010;

function sphereToWgs84Ecef(x, y, z, radius) {
	const r = Math.hypot(x, y, z);
	const lat = Math.asin(z / r), lon = Math.atan2(y, x);
	const alt = r - radius;
	const sl = Math.sin(lat), cl = Math.cos(lat);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
	return [
		(n + alt) * cl * Math.cos(lon),
		(n + alt) * cl * Math.sin(lon),
		(n * (1 - WGS84_E2) + alt) * sl,
	];
}

export async function decode(tileDir, { onLog } = {}) {
	const log = (line) => onLog?.(line);
	const tile = JSON.parse(fs.readFileSync(path.join(tileDir, 'rocktree-tile.json'), 'utf8'));
	if (!tile.nodes?.length) throw new Error(`${tileDir} : rocktree-tile.json ne liste aucun nœud.`);
	const radius = tile.radius ?? PLANETOID_RADIUS_FALLBACK;

	const materials = [];
	const vx = new Growable(Float64Array, 1 << 20), vy = new Growable(Float64Array, 1 << 20), vz = new Growable(Float64Array, 1 << 20);
	const tu = new Growable(Float32Array, 1 << 20), tv = new Growable(Float32Array, 1 << 20);
	const triByMat = [];
	const seenCopyrights = new Set();
	let faceCount = 0, noTexture = 0;

	for (const entry of tile.nodes) {
		const node = parseNode(fs.readFileSync(path.join(tileDir, entry.file)));
		for (const cid of node.copyrightIds) {
			const text = tile.copyrights?.[cid];
			if (text) seenCopyrights.add(text);
		}
		const ma = node.matrix;
		const exclude = new Set(entry.exclude ?? []);

		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			const strip = unpackIndices(mesh.indices);
			const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);

			// UV : delta-décodés puis normalisés par uv_offset_and_scale quand le
			// proto le fournit, sinon par le repli (0.5, 1/mod) du protocole.
			let uvNorm = null;
			if (mesh.texCoords) {
				const { uv, uMod, vMod } = unpackTexCoords(mesh.texCoords, count);
				const [ou, ov, su, sv] = mesh.uvOffsetAndScale ?? [0.5, 0.5, 1 / uMod, 1 / vMod];
				uvNorm = { uv, ou, ov, su, sv };
			}

			const base = vx.length;
			for (let i = 0; i < count; i++) {
				const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
				const gx = x * ma[0] + y * ma[4] + z * ma[8] + ma[12];
				const gy = x * ma[1] + y * ma[5] + z * ma[9] + ma[13];
				const gz = x * ma[2] + y * ma[6] + z * ma[10] + ma[14];
				const [ex, ey, ez] = sphereToWgs84Ecef(gx, gy, gz, radius);
				vx.push(ex); vy.push(ey); vz.push(ez);
				if (uvNorm) {
					const u = (uvNorm.uv[i * 2] + uvNorm.ou) * uvNorm.su;
					const v = (uvNorm.uv[i * 2 + 1] + uvNorm.ov) * uvNorm.sv;
					// Convention moteur : origine haut-gauche. Le protocole a
					// l'origine en bas-gauche (constaté sur les exports OBJ de
					// référence) : on inverse V ici, comme obj.mjs pour l'OBJ.
					// C'EST LA DÉCISION À VÉRIFIER EN NAVIGATEUR (Task 9) — le
					// piège « textures grises » du projet.
					tu.push(u); tv.push(1 - v);
				} else { tu.push(0); tv.push(0); }
			}

			const mat = new Growable(Uint32Array, 1 << 10);
			materials.push({
				name: `${entry.path}_${mesh.meshId}`,
				texture: mesh.texture ? mesh.texture.data : (noTexture++, null),
			});
			triByMat.push(mat);

			const end = Math.min(layerBounds[3], strip.length);
			for (let i = 0; i + 2 < end; i++) {
				let a = strip[i], b = strip[i + 1], c = strip[i + 2];
				if (a === b || a === c || b === c) continue;
				if (i & 1) { const t = b; b = c; c = t; }
				// Un nœud parent n'émet pas les octants déjà servis par un enfant
				// sélectionné : sans ça, deux géométries se superposent en z-fight.
				if (exclude.size && exclude.has(octantOf[strip[i]])) continue;
				mat.push(base + a, base + a, base + b, base + b, base + c, base + c);
				faceCount++;
			}
		}
	}

	log(`  ${materials.length} materials, ${noTexture} without a texture`);
	const vertCount = vx.length;
	log(`  ${vertCount.toLocaleString()} vertices, ${tu.length.toLocaleString()} uvs, ${faceCount.toLocaleString()} triangles`);
	if (vertCount === 0 || faceCount === 0) {
		throw new Error(`${tileDir} ne contient aucune géométrie — rien à convertir.`);
	}

	return {
		materials, vx, vy, vz, tu, tv, triByMat, vertCount, faceCount,
		attribution: ['© Google', ...[...seenCopyrights].sort()],
	};
}
