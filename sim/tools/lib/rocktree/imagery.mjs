// Repli d'imagerie rocktree (issue #158).
//
// La photogrammétrie de Google s'arrête à une profondeur variable, souvent
// bien avant le niveau demandé. En dessous, l'octree contient encore des
// nœuds, mais leur atlas est noir sur tout ou partie de sa surface : mesuré
// sur un bake Champ de Mars (rayon 150, niveau 21), 19,7 % de l'aire tournée
// vers le ciel échantillonne un texel noir.
//
// Ce noir n'est PAS réparable au grain du nœud : les deux tiers vivent à
// l'intérieur de nœuds par ailleurs corrects, l'empreinte de l'imagerie
// s'arrêtant au milieu d'un nœud et non à sa frontière (mesuré : les nœuds
// noirs à plus de 80 % ne portent que 34 % du noir total). La réparation se
// fait donc au TEXEL.
//
// Le principe : construire une trame au sol — une image lat/lon unique pour
// toute la tuile — remplie par toute l'imagerie valable disponible, puis
// remplacer chaque texel noir par l'échantillon de cette trame au même point
// du sol. Là où Google n'a pas de détail fin, on retombe sur du détail
// grossier ; c'est la vérité de la donnée, pas un maquillage.

// Un texel est « noir » sous ce seuil de moyenne RGB. Choisi en mesurant la
// distribution réelle : les atlas de remplissage sont à 0-4 de moyenne, la
// vraie imagerie aérienne la plus sombre observée (ombres portées d'immeubles)
// reste au-dessus de 10. 8 tombe dans ce creux.
export const BLACK_THRESHOLD = 8;

const M_PER_DEG_LAT = 111320;

// Trame au sol : cellules CARRÉES EN MÈTRES. Une trame régulière en degrés
// serait étirée d'un facteur 1/cos(lat) — 1,5 à Paris — et le repli
// hériterait de cet étirement.
export function createGroundRaster(bounds, metresPerCell) {
	const { south, west, north, east } = bounds;
	const midLat = (south + north) / 2;
	const mPerDegLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
	const h = Math.max(1, Math.ceil(((north - south) * M_PER_DEG_LAT) / metresPerCell));
	const w = Math.max(1, Math.ceil(((east - west) * mPerDegLon) / metresPerCell));
	return {
		south, west, north, east, w, h, metresPerCell,
		rgb: new Uint8Array(w * h * 3),
		alt: new Float32Array(w * h),
		filled: new Uint8Array(w * h),
	};
}

// lat/lon -> coordonnées continues dans la trame (origine en bas à gauche pour
// la latitude : la ligne 0 est au sud).
function toCell(r, lat, lon) {
	return [
		((lon - r.west) / (r.east - r.west)) * r.w,
		((lat - r.south) / (r.north - r.south)) * r.h,
	];
}

const isBlack = (c) => (c[0] + c[1] + c[2]) / 3 < BLACK_THRESHOLD;

// Peint un triangle dans la trame.
//
// On interpole les UV puis on échantillonne la texture POUR CHAQUE CELLULE.
// Échantillonner la texture aux trois sommets et interpoler la COULEUR (un
// ombrage de Gouraud) semble équivalent et ne l'est pas du tout : sur les
// grands triangles — précisément ceux des nœuds grossiers dont on a besoin
// ici — cela étale trois couleurs en éventail et rend une mosaïque de facettes
// au lieu d'une photo aérienne. C'est le défaut qu'a repéré la relecture
// visuelle de la trame.
//
// Deux règles de plus :
//   - un échantillon noir n'est jamais écrit — c'est ce qu'on cherche à
//     remplacer, l'y stocker propagerait le défaut ;
//   - à cellule égale, la surface la PLUS HAUTE gagne : vue du ciel, un toit
//     couvre le sol qu'il surplombe.
//
// `onlyEmpty` : n'écrit que dans les cellules encore vides. C'est ainsi qu'on
// superpose les sources — l'imagerie FINE des nœuds retenus d'abord, puis les
// ancêtres GROSSIERS seulement là où il manque quelque chose. Sans cette
// garde, le z-buffer d'altitude laisserait un ancêtre grossier écraser du
// détail fin dès que sa surface est un cheveu plus haute.
//
// `sample(u, v) -> [r,g,b]` : l'échantillonneur de la texture du maillage, en
// UV normalisés [0,1] (l'appelant possède la convention de V).
export function paintTriangleGround(r, p0, p1, p2, uv0, uv1, uv2, sample, { onlyEmpty = false } = {}) {
	const [x0, y0] = toCell(r, p0.lat, p0.lon);
	const [x1, y1] = toCell(r, p1.lat, p1.lon);
	const [x2, y2] = toCell(r, p2.lat, p2.lon);
	const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
	if (Math.abs(det) < 1e-12) return; // dégénéré

	const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
	const maxX = Math.min(r.w - 1, Math.ceil(Math.max(x0, x1, x2)));
	const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
	const maxY = Math.min(r.h - 1, Math.ceil(Math.max(y0, y1, y2)));

	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const cx = px + 0.5, cy = py + 0.5;
			const b1 = ((cx - x0) * (y2 - y0) - (x2 - x0) * (cy - y0)) / det;
			const b2 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) / det;
			const b0 = 1 - b1 - b2;
			if (b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9) continue;

			const u = b0 * uv0[0] + b1 * uv1[0] + b2 * uv2[0];
			const v = b0 * uv0[1] + b1 * uv1[1] + b2 * uv2[1];
			const col = sample(u, v);
			if (!col || isBlack(col)) continue;

			const alt = b0 * p0.alt + b1 * p1.alt + b2 * p2.alt;
			const i = py * r.w + px;
			if (r.filled[i] && (onlyEmpty || r.alt[i] >= alt)) continue;
			// Uint8Array TRONQUE : sans arrondi, 98,999 devient 98 et la couleur
			// dérive d'un cran à chaque passage.
			r.rgb[i * 3] = Math.round(col[0]); r.rgb[i * 3 + 1] = Math.round(col[1]); r.rgb[i * 3 + 2] = Math.round(col[2]);
			r.alt[i] = alt; r.filled[i] = 1;
		}
	}
}

export function sampleRaster(r, lat, lon) {
	const [fx, fy] = toCell(r, lat, lon);
	const px = Math.floor(fx), py = Math.floor(fy);
	if (px < 0 || py < 0 || px >= r.w || py >= r.h) return null;
	const i = py * r.w + px;
	if (!r.filled[i]) return null;
	return r.rgb.subarray(i * 3, i * 3 + 3);
}

// Comble les cellules vides depuis leurs voisines remplies, par vagues
// successives. S'arrête dès qu'une passe n'a plus rien rempli : une trame
// entièrement vide (aucune imagerie du tout) sort inchangée au lieu de boucler.
export function dilateRaster(r, maxPasses = 512) {
	const { w, h } = r;
	for (let pass = 0; pass < maxPasses; pass++) {
		const todo = [];
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				if (r.filled[i]) continue;
				let sr = 0, sg = 0, sb = 0, sa = 0, k = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
						const j = ny * w + nx;
						if (r.filled[j] !== 1) continue; // 1 = rempli AVANT cette passe
						sr += r.rgb[j*3]; sg += r.rgb[j*3+1]; sb += r.rgb[j*3+2]; sa += r.alt[j]; k++;
					}
				}
				if (k) todo.push([i, sr / k, sg / k, sb / k, sa / k]);
			}
		}
		if (todo.length === 0) return;
		// Marqués 2 pour ne pas servir de source dans la MÊME passe : sans ça la
		// première cellule remplie se propagerait en travers de la trame d'un
		// coup, avec une traînée directionnelle au lieu d'une vague isotrope.
		for (const [i, cr, cg, cb, ca] of todo) {
			r.rgb[i*3] = Math.round(cr); r.rgb[i*3+1] = Math.round(cg); r.rgb[i*3+2] = Math.round(cb);
			r.alt[i] = ca; r.filled[i] = 2;
		}
		for (const [i] of todo) r.filled[i] = 1;
	}
}

// Parcourt les texels couverts par un triangle donné en UV, en rendant les
// coordonnées barycentriques. Convention rocktree : px = u*(W-1) et
// py = v*(H-1) — v = 0 est la ligne du HAUT, mesuré (cf. rocktree.mjs).
export function forEachTexelOfTriangle(W, H, uv0, uv1, uv2, cb) {
	const X = (uv) => uv[0] * (W - 1);
	const Y = (uv) => uv[1] * (H - 1);
	const x0 = X(uv0), y0 = Y(uv0), x1 = X(uv1), y1 = Y(uv1), x2 = X(uv2), y2 = Y(uv2);
	const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
	if (Math.abs(det) < 1e-9) return; // dégénéré ou colinéaire

	const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
	const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
	const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
	const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));

	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const b1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / det;
			const b2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / det;
			const b0 = 1 - b1 - b2;
			if (b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9) continue;
			cb(px, py, b0, b1, b2);
		}
	}
}

export function blackMask(rgb, W, H, threshold = BLACK_THRESHOLD) {
	const m = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) {
		m[i] = (rgb[i*3] + rgb[i*3+1] + rgb[i*3+2]) / 3 < threshold ? 1 : 0;
	}
	return m;
}

// Remplace, EN PLACE, les texels noirs de `rgb` couverts par la géométrie, par
// l'échantillon de la trame au sol au même point. `tris` : [{ uv: [uv0,uv1,uv2],
// pos: [p0,p1,p2] }] où p = { lat, lon, alt }.
//
// Ne touche jamais un texel non noir : la vraie imagerie prime toujours sur le
// repli, qui est plus grossier par construction.
export function repairTexels(rgb, W, H, tris, raster, threshold = BLACK_THRESHOLD) {
	const mask = blackMask(rgb, W, H, threshold);
	let remaining = 0;
	for (let i = 0; i < mask.length; i++) remaining += mask[i];
	if (remaining === 0) return { repaired: 0, remaining: 0 };

	let repaired = 0;
	for (const { uv, pos } of tris) {
		forEachTexelOfTriangle(W, H, uv[0], uv[1], uv[2], (px, py, b0, b1, b2) => {
			const i = py * W + px;
			if (!mask[i]) return;
			const lat = b0 * pos[0].lat + b1 * pos[1].lat + b2 * pos[2].lat;
			const lon = b0 * pos[0].lon + b1 * pos[1].lon + b2 * pos[2].lon;
			const c = sampleRaster(raster, lat, lon);
			if (!c) return;
			rgb[i*3] = c[0]; rgb[i*3+1] = c[1]; rgb[i*3+2] = c[2];
			mask[i] = 0; repaired++; remaining--;
		});
	}
	return { repaired, remaining };
}
