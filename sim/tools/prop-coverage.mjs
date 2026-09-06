// Ce que les hélices occupent dans le champ (issue #264). Module PUR, importé
// par le selftest de borne et par tools/tune-mount.mjs — jamais par le client.
//
// La méthode est une rasterisation, pas une estimation d'angles : on tire un
// rayon par pixel d'une grille, on l'intersecte avec le PLAN du disque, et on
// regarde s'il tombe dedans. Une approximation angulaire compterait des points
// du disque qui sortent du champ latéralement — c'est l'erreur qui avait
// surestimé la couverture d'un facteur trois pendant la conception.
//
// On mesure l'ENVELOPPE BALAYÉE (le disque entier), pas les pales à un instant :
// c'est l'arc flou que l'œil voit, et c'est sur lui que porte la borne DA.
//
// Repère : celui de la recette (src/drone-shape.js), corps nez −Z, haut +Y,
// mètres. La caméra regarde −Z, inclinée de `uptiltDeg` autour de +X.

const ASPECT = { '4:3': 4 / 3, '16:9': 16 / 9 };

// targetCamera() rend les deux : `aspect` déjà en nombre (4/3 ou 16/9) et
// `aspectName` en chaîne. On accepte l'un ou l'autre pour que la sonde marche
// aussi sur une caméra écrite à la main dans un test.
function aspectOf(camera) {
	if (Number.isFinite(camera?.aspect)) return camera.aspect;
	return ASPECT[camera?.aspect] ?? ASPECT[camera?.aspectName] ?? 16 / 9;
}

export function propCoverage({ shape, camera, mountY, mountZ, grid = 200 } = {}) {
	const cam = shape.parts.find((p) => p.role === 'camera');
	const props = shape.parts.filter((p) => p.role === 'prop');
	if (!cam || props.length === 0) return { area: 0, top: 0 };

	// L'oeil. Par défaut la part 'camera' de la recette ; sinon un montage
	// donné en hauteur AU-DESSUS DU PLAN D'HÉLICE et en avancée.
	const planeY = props[0].at[1];
	const eyeY = Number.isFinite(mountY) ? planeY + mountY : cam.at[1];
	const eyeZ = Number.isFinite(mountZ) ? mountZ : cam.at[2];
	const eyeX = cam.at[0];

	const up = (camera.uptiltDeg ?? 0) * Math.PI / 180;
	// fovDeg est le champ VERTICAL, comme sur la caméra du client
	// (src/main.js : `camera.fov = spec.fovDeg`). L'horizontal en découle par
	// le format d'image.
	const tv = Math.tan((camera.fovDeg ?? 120) * Math.PI / 360);
	const th = tv * aspectOf(camera);

	// Grille de rayons 4:3 en NOMBRE DE PIXELS : `area` est une fraction de
	// l'image, donc indépendante de la forme de l'échantillonnage — seule
	// compte la couverture angulaire, portée par th/tv.
	const W = grid, H = Math.round(grid * 3 / 4);
	let hit = 0, topRow = -1;
	for (let j = 0; j < H; j++) {
		let rowHit = 0;
		for (let i = 0; i < W; i++) {
			const sx = (2 * (i + 0.5) / W - 1) * th;
			const sy = (1 - 2 * (j + 0.5) / H) * tv;
			// Le rayon, du repère caméra vers le repère corps : l'uptilt est une
			// rotation autour de +X. Direction non normalisée (sx, ry, rz) — ce
			// qui suffit, on ne se sert de `t` que comme paramètre.
			const ry = sy * Math.cos(up) + Math.sin(up);
			const rz = sy * Math.sin(up) - Math.cos(up);
			for (const p of props) {
				// Intersection avec le plan horizontal du disque, puis test du
				// rayon dans ce plan. `t > 0` élimine ce qui est derrière l'oeil
				// — et rend 0 quand l'oeil est EXACTEMENT dans le plan : un
				// disque d'épaisseur nulle vu par la tranche.
				const t = (p.at[1] - eyeY) / ry;
				if (!(t > 0)) continue;
				const dx = eyeX + sx * t - p.at[0];
				const dz = eyeZ + rz * t - p.at[2];
				if (dx * dx + dz * dz <= p.size[0] * p.size[0]) { rowHit++; break; }
			}
		}
		hit += rowHit;
		// Les lignes sont balayées du haut du cadre vers le bas : la première
		// touchée est donc la hauteur la plus haute atteinte.
		if (rowHit > 0 && topRow < 0) topRow = j;
	}
	return {
		area: hit / (W * H),
		top: topRow < 0 ? 0 : 1 - (topRow + 0.5) / H,
	};
}
