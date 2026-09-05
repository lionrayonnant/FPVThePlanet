// Selftest de la couverture de carte (issue #245). Aucun DOM, aucun Leaflet :
// des lat/lon posées à la main et les formules slippy qu'on peut vérifier au
// calcul. Lancer : node tools/coverage-selftest.mjs
import assert from 'node:assert/strict';
import {
	Z, R_M, W_MAX, MAX_CELLS,
	cellOf, cellCenter, cellSizeM, distanceM, stampCells,
} from '../src/coverage.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// La Tour Eiffel, le point de référence du dépôt (public/scenes/tour-eiffel).
const EIFFEL = { lat: 48.8584, lon: 2.2945 };

t('constantes de la spec, verbatim', () => {
	assert.equal(Z, 20);
	assert.equal(R_M, 30);
	assert.equal(W_MAX, 8);
	assert.equal(MAX_CELLS, 8000);
});

t('cellOf : la tuile slippy z=20 de la Tour Eiffel, valeurs calculées à part', () => {
	// Calculées hors du module avec les formules OSM standard, pour que le test
	// ne soit pas la définition qu'il vérifie.
	assert.deepEqual(cellOf(EIFFEL.lat, EIFFEL.lon), { x: 530971, y: 360731 });
});

t('cellCenter : le centre de cette tuile retombe dans la tuile', () => {
	const c = cellCenter(530971, 360731);
	assert.ok(Math.abs(c.lat - 48.858503) < 1e-5, `lat ${c.lat}`);
	assert.ok(Math.abs(c.lon - 2.294598) < 1e-5, `lon ${c.lon}`);
	assert.deepEqual(cellOf(c.lat, c.lon), { x: 530971, y: 360731 });
});

t('cellSizeM : 25,1 m à Paris, 38,2 m à l\'équateur — la spec le dit', () => {
	assert.ok(Math.abs(cellSizeM(EIFFEL.lat) - 25.145) < 0.05, `${cellSizeM(EIFFEL.lat)}`);
	assert.ok(Math.abs(cellSizeM(0) - 38.22) < 0.05, `${cellSizeM(0)}`);
});

// Référence INDÉPENDANTE : une haversine sur le rayon moyen terrestre, qui ne
// partage rien avec la formule plate du module. La spec dit que l'approximation
// plate suffit à l'échelle de l'empreinte — on le vérifie au lieu de le supposer.
const haversineM = (a, b) => {
	const R = 6371008.8, d = Math.PI / 180;
	const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};

t('distanceM : à 0,2 % près d\'une haversine indépendante, à 30 m comme à 1 km', () => {
	// Décalages posés en DEGRÉS, pas dérivés de la formule testée.
	const east30 = { lat: EIFFEL.lat, lon: EIFFEL.lon + 0.00041 };   // ~30 m à cette latitude
	const north30 = { lat: EIFFEL.lat + 0.00027, lon: EIFFEL.lon };  // ~30 m
	const diag1km = { lat: EIFFEL.lat + 0.0064, lon: EIFFEL.lon + 0.0097 };
	// L'écart attendu est CONSTANT en relatif, ~0,113 % : 111320 m/° (la
	// convention du module, la même que latLonOf() dans main.js — les deux
	// doivent tomber dans les mêmes cellules) contre 111194,9 m/° pour le rayon
	// moyen de la haversine. Deux conventions, pas une erreur ; on borne à 0,2 %.
	for (const [p, about] of [[east30, 30], [north30, 30], [diag1km, 1000]]) {
		const ref = haversineM(EIFFEL, p);
		assert.ok(ref > about * 0.85 && ref < about * 1.15, `le point de test est bien à ~${about} m (${ref.toFixed(2)})`);
		const rel = Math.abs(distanceM(EIFFEL, p) - ref) / ref;
		assert.ok(rel < 0.002, `écart relatif ${(rel * 100).toFixed(3)} % à ${about} m`);
	}
	assert.equal(distanceM(EIFFEL, EIFFEL), 0);
});

t('stampCells : 4 à 5 cellules à Paris, jamais un 3×3 — les diagonales sont à 35,6 m', () => {
	// Au centre exact d'une cellule : elle-même + ses 4 voisines orthogonales.
	const c = cellCenter(530971, 360731);
	const atCentre = stampCells(c.lat, c.lon);
	assert.equal(atCentre.length, 5, `au centre : ${atCentre.length}`);
	// Toutes les cellules retenues ont leur centre à moins de R_M ; aucune
	// cellule à moins de R_M n'a été oubliée (on balaie un carré large autour).
	for (const cell of atCentre) {
		assert.ok(distanceM(c, cellCenter(cell.x, cell.y)) < R_M);
	}
	for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
		const x = 530971 + dx, y = 360731 + dy;
		const inside = distanceM(c, cellCenter(x, y)) < R_M;
		const kept = atCentre.some((k) => k.x === x && k.y === y);
		assert.equal(kept, inside, `cellule (${dx},${dy})`);
	}
	// Sur un coin de cellule : les 4 cellules qui se partagent le coin (à 17,8 m),
	// et rien d'autre (la couronne suivante est à ~40 m).
	const corner = stampCells(EIFFEL.lat, EIFFEL.lon).length;
	assert.ok(corner >= 4 && corner <= 5, `au point réel : ${corner}`);
});

t('stampCells : aucun trou le long d\'une trajectoire à 42,72 m/s échantillonnée à 5 Hz', () => {
	// La pire vitesse mesurée du dépôt (geofence.js WORST_MEASURED_SPEED_MS), un
	// pas de 0,2 s : 8,54 m entre deux échantillons, très en deçà des 30 m.
	// Chaque cellule que la ligne TRAVERSE doit être marquée par au moins un
	// échantillon.
	const speed = 42.72, dt = 0.2, steps = 40;
	const mPerDegLon = 111320 * Math.cos(EIFFEL.lat * Math.PI / 180);
	const marked = new Set();
	for (let i = 0; i <= steps; i++) {
		const lon = EIFFEL.lon + (i * speed * dt) / mPerDegLon;
		for (const c of stampCells(EIFFEL.lat, lon)) marked.add(`${c.x},${c.y}`);
	}
	// Les cellules traversées par la ligne elle-même : on échantillonne la ligne
	// tous les 2 m, bien plus fin que la cellule.
	const total = steps * speed * dt;
	for (let m = 0; m <= total; m += 2) {
		const lon = EIFFEL.lon + m / mPerDegLon;
		const c = cellOf(EIFFEL.lat, lon);
		assert.ok(marked.has(`${c.x},${c.y}`), `trou à ${m} m`);
	}
});

console.log(`\n${n} tests coverage OK`);
