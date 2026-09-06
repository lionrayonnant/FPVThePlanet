// Ce que la vue embarquée occupe RÉELLEMENT du cadre (issue #264).
//
// tools/prop-coverage.mjs ne mesure que les disques d'hélice. C'est le bon
// instrument pour régler la HAUTEUR de l'objectif — le disque est la seule
// pièce dont la place à l'image dépend de cette hauteur. Mais ce n'est pas ce
// que le joueur voit : les conduits, les bras et les moteurs occupent le cadre
// eux aussi, et sur une famille carénée ils pèsent trois fois plus lourd que
// les hélices (cinewhoop : 33 % de l'image, dont 19 points de conduit).
//
// Cette sonde-ci mesure le maillage TEL QU'IL EST AFFICHÉ : un rayon par pixel
// d'une grille, intersecté avec les vrais triangles fusionnés. C'est elle qui
// fait foi pour ce que la machine occupe, et c'est elle qui règle l'AVANCÉE.
//
// Elle vit dans tools/ et non dans src/ : elle a besoin de Three, elle n'a donc
// rien à faire dans le chemin de vol.
import * as THREE from 'three';

// Les triangles du maillage, à plat, dans le repère du CORPS. Le niveau
// `onboard` ne dépend pas du montage (il ne porte que les rotors), donc cette
// liste se calcule UNE fois par famille et sert à tous les montages essayés.
export function trianglesOf(mesh, matrix = null) {
	const geo = mesh.body.geometry;
	const pos = geo.getAttribute('position');
	const idx = geo.getIndex().array;
	const out = new Float64Array(idx.length * 3);
	const v = new THREE.Vector3();
	for (let i = 0; i < idx.length; i++) {
		v.fromBufferAttribute(pos, idx[i]);
		if (matrix) v.applyMatrix4(matrix);
		out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z;
	}
	return out;
}

// Möller–Trumbore, origine quelconque. Rend vrai dès le premier triangle
// touché : on ne cherche pas le plus proche, seulement s'il y a quelque chose.
function anyHit(tri, ox, oy, oz, dx, dy, dz) {
	for (let t = 0; t < tri.length; t += 9) {
		const ax = tri[t], ay = tri[t + 1], az = tri[t + 2];
		const e1x = tri[t + 3] - ax, e1y = tri[t + 4] - ay, e1z = tri[t + 5] - az;
		const e2x = tri[t + 6] - ax, e2y = tri[t + 7] - ay, e2z = tri[t + 8] - az;
		const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
		const det = e1x * px + e1y * py + e1z * pz;
		if (det > -1e-12 && det < 1e-12) continue;
		const inv = 1 / det;
		const sx = ox - ax, sy = oy - ay, sz = oz - az;
		const u = (sx * px + sy * py + sz * pz) * inv;
		if (u < 0 || u > 1) continue;
		const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
		const v = (dx * qx + dy * qy + dz * qz) * inv;
		if (v < 0 || u + v > 1) continue;
		if ((e2x * qx + e2y * qy + e2z * qz) * inv > 1e-5) return true;
	}
	return false;
}

// Rend { area, top } comme propCoverage : fraction du cadre occupée, et hauteur
// la plus haute atteinte (0 = bas du cadre, 1 = haut). `eye` est la position de
// l'objectif dans le repère des triangles, `uptiltDeg` son inclinaison.
export function lensCoverage({ triangles, eye = [0, 0, 0], uptiltDeg = 0, fovDeg, aspect, grid = 48 }) {
	const tv = Math.tan(fovDeg * Math.PI / 360), th = tv * aspect;
	const up = uptiltDeg * Math.PI / 180;
	const cu = Math.cos(up), su = Math.sin(up);
	const [ox, oy, oz] = eye;
	let hit = 0, top = 0;
	for (let j = 0; j < grid; j++) {
		const ny = 2 * (j + 0.5) / grid - 1;
		const sy = ny * tv;
		// Le rayon caméra (sx, sy, −1), tourné de l'uptilt autour de +X.
		const ry = sy * cu + su, rz = sy * su - cu;
		let row = 0;
		for (let i = 0; i < grid; i++) {
			const sx = (2 * (i + 0.5) / grid - 1) * th;
			if (anyHit(triangles, ox, oy, oz, sx, ry, rz)) row++;
		}
		hit += row;
		if (row > 0) top = Math.max(top, (ny + 1) / 2);
	}
	return { area: hit / (grid * grid), top };
}
