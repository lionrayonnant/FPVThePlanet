// Décodeur rocktree — le format du fournisseur google-earth (issue #18).
// Chaque nœud d'octree porte sa matrice mesh->globe : les sommets uint8
// locaux deviennent des ECEF Float64 ici même, prep.mjs rebasera en ENU.
import fs from 'node:fs';
import path from 'node:path';
import { Growable } from '../growable.mjs';
import { parseNode } from '../rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from '../rocktree/unpack.mjs';
import sharp from 'sharp';
import {
	createGroundRaster, paintTriangleGround, dilateRaster, repairTexels, BLACK_THRESHOLD,
} from '../rocktree/imagery.mjs';

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


// ECEF WGS84 -> géodésique (Bowring). Le décodeur en a besoin pour situer ses
// texels au sol ; prep.mjs a la sienne mais ne l'exporte pas, et CLAUDE.md
// demande de ne pas retoucher sa géodésie — on ne la modifie donc pas, on
// écrit ici la conversion dont le repli d'imagerie a besoin.
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
function ecefToGeodetic(x, y, z) {
	const p = Math.hypot(x, y);
	const th = Math.atan2(z * WGS84_A, p * WGS84_B);
	const lat = Math.atan2(z + WGS84_EP2 * WGS84_B * Math.sin(th) ** 3, p - WGS84_E2 * WGS84_A * Math.cos(th) ** 3);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
	return { lat: (lat * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI, alt: p / Math.cos(lat) - n };
}

// Résolution de la trame au sol. Assez fine pour ne pas gâcher l'imagerie des
// nœuds valables qui l'alimentent (~0,10 m/texel au niveau 21), assez grossière
// pour qu'une grande tuile tienne en mémoire — d'où le plafond de 4096 cellules
// de côté, qui borne la trame à 48 Mo quelle que soit l'emprise.
const RASTER_METRES = 0.25;
const RASTER_MAX_SIDE = 4096;

// Charge les maillages d'une liste d'entrées : géométrie en ECEF WGS84 ET en
// géodésique (le repli travaille au sol), UV, bande dessinée du strip.
export function loadMeshes(tileDir, entries, radius, onCopyright) {
	const out = [];
	for (const entry of entries) {
		const node = parseNode(fs.readFileSync(path.join(tileDir, entry.file)));
		for (const cid of node.copyrightIds) onCopyright?.(cid);
		const ma = node.matrix;
		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			const strip = unpackIndices(mesh.indices);
			const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);
			const pos = new Float64Array(count * 3);   // ECEF WGS84
			const geo = new Float64Array(count * 3);   // lat, lon, alt
			for (let i = 0; i < count; i++) {
				const x = xyz[i*3], y = xyz[i*3+1], z = xyz[i*3+2];
				const [ex, ey, ez] = sphereToWgs84Ecef(
					x*ma[0]+y*ma[4]+z*ma[8]+ma[12], x*ma[1]+y*ma[5]+z*ma[9]+ma[13], x*ma[2]+y*ma[6]+z*ma[10]+ma[14], radius);
				pos[i*3] = ex; pos[i*3+1] = ey; pos[i*3+2] = ez;
				const g = ecefToGeodetic(ex, ey, ez);
				geo[i*3] = g.lat; geo[i*3+1] = g.lon; geo[i*3+2] = g.alt;
			}
			let uv = null, uMod = 1, vMod = 1;
			if (mesh.texCoords) ({ uv, uMod, vMod } = unpackTexCoords(mesh.texCoords, count));
			out.push({
				entry, mesh, count, strip, layerBounds, octantOf, pos, geo, uv, uMod, vMod,
				end: Math.min(layerBounds[3], strip.length),
			});
		}
	}
	return out;
}

// Parcourt les triangles réellement dessinés d'un maillage (même déroulé de
// strip et même exclusion d'octants que la boucle de sortie plus bas — les
// deux doivent voir EXACTEMENT la même géométrie, sinon on réparerait des
// texels que personne ne regarde et on en laisserait de visibles).
function forEachDrawnTriangle(m, exclude, cb) {
	for (let i = 0; i + 2 < m.end; i++) {
		let a = m.strip[i], b = m.strip[i+1], c = m.strip[i+2];
		if (a === b || a === c || b === c) continue;
		if (i & 1) { const t = b; b = c; c = t; }
		if (exclude.size && exclude.has(m.octantOf[m.strip[i]])) continue;
		cb(a, b, c);
	}
}

// Un triangle tourné vers le ciel ? Seuls ceux-là alimentent la trame : une
// façade verticale se projette en une ligne au sol et polluerait la cellule
// qu'elle traverse avec la couleur d'un mur.
function facesUp(m, a, b, c) {
	const A = [m.pos[a*3], m.pos[a*3+1], m.pos[a*3+2]];
	const e1 = [m.pos[b*3]-A[0], m.pos[b*3+1]-A[1], m.pos[b*3+2]-A[2]];
	const e2 = [m.pos[c*3]-A[0], m.pos[c*3+1]-A[1], m.pos[c*3+2]-A[2]];
	const nx = e1[1]*e2[2]-e1[2]*e2[1], ny = e1[2]*e2[0]-e1[0]*e2[2], nz = e1[0]*e2[1]-e1[1]*e2[0];
	const nl = Math.hypot(nx, ny, nz);
	if (!nl) return false;
	const rl = Math.hypot(A[0], A[1], A[2]);
	return (nx*A[0] + ny*A[1] + nz*A[2]) / (nl * rl) > 0.5;
}

async function textureRgb(mesh) {
	const img = sharp(mesh.texture.data);
	const { width, height } = await img.metadata();
	const { data } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { rgb: data, W: width, H: height };
}

// Construit la trame au sol qui servira de repli. Rend null si le repli est
// désactivé (pas d'entrée `fallback` dans le manifeste : tuile d'avant l'issue
// #158, ou fournisseur qui n'en produit pas) — le décodage se comporte alors
// exactement comme avant.
export async function buildGroundRaster(tileDir, tile, meshes, radius, addCopyright, log) {
	if (!Array.isArray(tile.fallback) || tile.fallback.length === 0) return null;

	// Emprise : celle de la géométrie réellement retenue, pas celle demandée —
	// les nœuds débordent la zone et leurs texels doivent tomber dans la trame.
	let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
	for (const m of meshes) {
		for (let i = 0; i < m.count; i++) {
			const lat = m.geo[i*3], lon = m.geo[i*3+1];
			if (lat < south) south = lat; if (lat > north) north = lat;
			if (lon < west) west = lon; if (lon > east) east = lon;
		}
	}
	if (!(south < north && west < east)) return null;

	const bounds = { south, north, west, east };
	const spanM = Math.max((north - south) * 111320, (east - west) * 111320 * Math.cos(((south + north) / 2 * Math.PI) / 180));
	const metres = Math.max(RASTER_METRES, spanM / RASTER_MAX_SIDE);
	const raster = createGroundRaster(bounds, metres);

	const paint = async (list, onlyEmpty) => {
		for (const m of list) {
			if (!m.mesh.texture || !m.uv) continue;
			const { rgb, W, H } = await textureRgb(m.mesh);
			const exclude = new Set(m.entry.exclude ?? []);
			// Échantillonneur en UV normalisés : v = 0 est la ligne du HAUT
			// (cf. le commentaire sur tv plus bas), donc py = v * (H-1) — on lit
			// exactement le texel que le moteur lira.
			const sample = (u, v) => {
				const px = Math.min(W - 1, Math.max(0, Math.round(u * (W - 1))));
				const py = Math.min(H - 1, Math.max(0, Math.round(v * (H - 1))));
				const o = (py * W + px) * 3;
				return [rgb[o], rgb[o+1], rgb[o+2]];
			};
			const UV = (i) => [(m.uv[i*2] + 0.5) / m.uMod, (m.uv[i*2+1] + 0.5) / m.vMod];
			const P = (i) => ({ lat: m.geo[i*3], lon: m.geo[i*3+1], alt: m.geo[i*3+2] });
			forEachDrawnTriangle(m, exclude, (a, b, c) => {
				if (!facesUp(m, a, b, c)) return;
				paintTriangleGround(raster, P(a), P(b), P(c), UV(a), UV(b), UV(c), sample, { onlyEmpty });
			});
		}
	};

	// Ordre voulu : l'imagerie FINE des nœuds retenus d'abord (elle gagne),
	// puis les ancêtres GROSSIERS uniquement là où il reste un vide.
	await paint(meshes, false);
	const fallbackMeshes = loadMeshes(tileDir, tile.fallback, radius, addCopyright);
	await paint(fallbackMeshes, true);

	const before = raster.filled.reduce((a, x) => a + x, 0);
	dilateRaster(raster);
	const after = raster.filled.reduce((a, x) => a + x, 0);
	log(`  repli d'imagerie : trame ${raster.w}x${raster.h} à ${raster.metresPerCell.toFixed(2)} m — `
		+ `${before.toLocaleString()} cellules peintes, ${(after - before).toLocaleString()} comblées par dilatation`);
	return after > 0 ? raster : null;
}

// Répare les texels noirs d'un maillage depuis la trame. Rend un Buffer JPEG
// ré-encodé, ou null si rien n'était à réparer (la texture d'origine est alors
// transmise telle quelle — pas de ré-encodage inutile, ni de perte).
//
// JPEG plutôt que PNG : prep.mjs ré-encode de toute façon la planche finale en
// JPEG, et garder 740 textures PNG en mémoire coûterait cinq fois plus pour une
// fidélité que l'étape suivante détruit.
async function repairMeshTexture(m, exclude, raster, log) {
	const { rgb, W, H } = await textureRgb(m.mesh);
	const tris = [];
	const UV = (i) => [(m.uv[i*2] + 0.5) / m.uMod, (m.uv[i*2+1] + 0.5) / m.vMod];
	const P = (i) => ({ lat: m.geo[i*3], lon: m.geo[i*3+1], alt: m.geo[i*3+2] });
	forEachDrawnTriangle(m, exclude, (a, b, c) => {
		tris.push({ uv: [UV(a), UV(b), UV(c)], pos: [P(a), P(b), P(c)] });
	});
	if (tris.length === 0) return null;

	const { repaired } = repairTexels(rgb, W, H, tris, raster, BLACK_THRESHOLD);
	if (repaired === 0) return null;
	repairStats.textures++; repairStats.texels += repaired;
	return sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
		.jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
		.toBuffer();
}

// Compteurs du repli, remis à zéro à chaque decode() (le décodeur est appelé
// une fois par tuile, mais un test peut en enchaîner plusieurs).
const repairStats = { textures: 0, texels: 0 };

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

	const addCopyright = (cid) => {
		const text = tile.copyrights?.[cid];
		if (text) seenCopyrights.add(text);
	};

	repairStats.textures = 0; repairStats.texels = 0;
	const meshes = loadMeshes(tileDir, tile.nodes, radius, addCopyright);

	// ---------------------------------------------------- repli d'imagerie
	// Issue #158 : là où la photogrammétrie de Google s'arrête, l'octree sert
	// encore des nœuds mais leur atlas est noir. On construit une trame au sol
	// depuis toute l'imagerie valable disponible — d'abord les nœuds retenus
	// (fins), puis les ancêtres de repli seulement dans les vides — et on
	// remplace chaque texel noir par l'échantillon de cette trame au même point
	// du sol. Voir lib/rocktree/imagery.mjs.
	const raster = await buildGroundRaster(tileDir, tile, meshes, radius, addCopyright, log);

	for (const m of meshes) {
		const { entry, mesh } = m;
		const exclude = new Set(entry.exclude ?? []);

		let texture = mesh.texture ? mesh.texture.data : (noTexture++, null);
		if (raster && mesh.texture && m.uv) {
			texture = await repairMeshTexture(m, exclude, raster, log) ?? texture;
		}

		// UV : delta-décodés puis normalisés par uv_offset_and_scale quand le
		// proto le fournit, sinon par le repli (0.5, 1/mod) du protocole.
		let uvNorm = null;
		if (m.uv) {
			const [ou, ov, su, sv] = mesh.uvOffsetAndScale ?? [0.5, 0.5, 1 / m.uMod, 1 / m.vMod];
			uvNorm = { uv: m.uv, ou, ov, su, sv };
		}

		const base = vx.length;
		for (let i = 0; i < m.count; i++) {
			vx.push(m.pos[i*3]); vy.push(m.pos[i*3+1]); vz.push(m.pos[i*3+2]);
			if (uvNorm) {
				const u = (uvNorm.uv[i * 2] + uvNorm.ou) * uvNorm.su;
				const v = (uvNorm.uv[i * 2 + 1] + uvNorm.ov) * uvNorm.sv;
				// PAS d'inversion de V — contrairement à obj.mjs (issue #158).
				//
				// Le moteur attend un tv d'origine HAUT-gauche : c'est ce
				// qu'établit obj.mjs, dont les textures Flyover sont vérifiées
				// en navigateur, et qui inverse justement parce que le format
				// OBJ a son origine en BAS-gauche.
				//
				// Le protocole rocktree, lui, a déjà son origine EN HAUT :
				// mesuré en rasterisant les nœuds de repli au sol dans les deux
				// conventions — `v` direct rend une photo aérienne cohérente du
				// Champ de Mars (Tour Eiffel, Seine, pont d'Iéna reconnaissables),
				// `1 - v` rend une mosaïque brouillée. L'inversion héritée de #18
				// affichait donc toutes les tuiles retournées ; « textures
				// nettes » ne l'avait pas vu, une vue aérienne retournée restant
				// parfaitement nette.
				tu.push(u); tv.push(v);
			} else { tu.push(0); tv.push(0); }
		}

		const mat = new Growable(Uint32Array, 1 << 10);
		materials.push({ name: `${entry.path}_${mesh.meshId}`, texture });
		triByMat.push(mat);

		forEachDrawnTriangle(m, exclude, (a, b, c) => {
			mat.push(base + a, base + a, base + b, base + b, base + c, base + c);
			faceCount++;
		});
	}

	if (raster) {
		log(`  repli d'imagerie : ${repairStats.texels.toLocaleString()} texel(s) noir(s) remplacé(s) `
			+ `sur ${repairStats.textures} texture(s)`);
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
