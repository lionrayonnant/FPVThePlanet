// Selftest de la couverture de carte (issue #245). Aucun DOM, aucun Leaflet :
// des lat/lon posées à la main et les formules slippy qu'on peut vérifier au
// calcul. Lancer : node tools/coverage-selftest.mjs
import assert from 'node:assert/strict';
import {
	Z, R_M, W_MAX, MAX_CELLS,
	cellOf, cellCenter, cellSizeM, distanceM, stampCells,
	Coverage,
	BLOB_RADIUS_CELLS, ALPHA_MIN, ALPHA_MAX, planDraw,
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

// ---------------------------------------------------------------------------
// Le magasin

t('Coverage vierge : rien dedans, et toStored() a la forme de la spec', () => {
	const c = new Coverage();
	assert.equal(c.size, 0);
	assert.deepEqual(c.toStored(), { v: 1, z: Z, cells: [] });
});

t('mark : une empreinte, puis les poids montent et saturent à W_MAX', () => {
	const c = new Coverage();
	c.mark(EIFFEL.lat, EIFFEL.lon);
	const first = c.size;
	assert.ok(first >= 4 && first <= 5, `${first} cellules`);
	const { x, y } = cellOf(EIFFEL.lat, EIFFEL.lon);
	assert.equal(c.weightAt(x, y), 1);
	for (let i = 0; i < 50; i++) c.mark(EIFFEL.lat, EIFFEL.lon);
	assert.equal(c.size, first, 'repasser au même endroit n\'ajoute pas de cellule');
	assert.equal(c.weightAt(x, y), W_MAX, 'le poids sature');
	for (const cell of c.cells()) assert.ok(cell.w <= W_MAX);
});

t('toStored / fromStored : aller-retour exact, ordre d\'insertion conservé', () => {
	const c = new Coverage();
	c.mark(EIFFEL.lat, EIFFEL.lon);
	c.mark(EIFFEL.lat + 0.01, EIFFEL.lon);
	const stored = c.toStored();
	assert.equal(stored.v, 1);
	assert.equal(stored.z, Z);
	for (const triple of stored.cells) {
		assert.equal(triple.length, 3);
		for (const v of triple) assert.ok(Number.isInteger(v));
	}
	const back = Coverage.fromStored(JSON.parse(JSON.stringify(stored)));
	assert.deepEqual(back.toStored(), stored);
});

t('fromStored : n\'importe quoi d\'invalide se relit comme une couverture vierge', () => {
	// Pas de migration, pas de bump de schéma : un opérateur d'avant #245 marche
	// tel quel — la même promesse que dialogueMemory.
	for (const bad of [undefined, null, 42, 'x', {}, { v: 2, z: Z, cells: [] },
		{ v: 1, z: 19, cells: [] }, { v: 1, z: Z, cells: 'nope' },
		{ v: 1, z: Z, cells: [[1, 2]] }, { v: 1, z: Z, cells: [[1.5, 2, 3]] },
		{ v: 1, z: Z, cells: [[1, 2, 0]] }, { v: 1, z: Z, cells: [[1, 2, W_MAX + 1]] }]) {
		const c = Coverage.fromStored(bad);
		assert.equal(c.size, 0, `devrait être vierge pour ${JSON.stringify(bad)}`);
	}
});

t('merge : commutative sur le contenu, élément neutre, poids additionnés puis saturés', () => {
	const a = new Coverage(); a.mark(EIFFEL.lat, EIFFEL.lon);
	const b = new Coverage(); b.mark(EIFFEL.lat, EIFFEL.lon); b.mark(EIFFEL.lat + 0.01, EIFFEL.lon);
	const ab = a.merge(b), ba = b.merge(a);
	// Même contenu (l'ordre peut différer, c'est celui du receveur d'abord).
	const key = (c) => c.cells().map((k) => `${k.x},${k.y}:${k.w}`).sort().join('|');
	assert.equal(key(ab), key(ba));
	const { x, y } = cellOf(EIFFEL.lat, EIFFEL.lon);
	assert.equal(ab.weightAt(x, y), 2, 'les poids s\'additionnent');
	// Élément neutre : fusionner la couverture vide ne change rien. (Pas
	// « idempotente » : les poids s'additionnent par construction — repasser
	// densifie — donc merge(b) deux fois compte b deux fois, et c'est voulu.)
	assert.equal(key(ab.merge(new Coverage())), key(ab));
	assert.equal(key(new Coverage().merge(ab)), key(ab));
	// Saturation à la fusion.
	const full = new Coverage(); for (let i = 0; i < 20; i++) full.mark(EIFFEL.lat, EIFFEL.lon);
	assert.equal(full.merge(full).weightAt(x, y), W_MAX);
	// Les entrées ne sont pas modifiées : merge rend une NOUVELLE couverture.
	assert.equal(a.weightAt(x, y), 1);
});

t('cap : au-delà du plafond, les poids faibles partent d\'abord, puis les plus anciens', () => {
	const c = new Coverage();
	// 12 cellules posées à la main via fromStored, pour tester les deux critères.
	const cells = [];
	// Deux « 1 » en tête (le critère poids), deux « 2 » aux index 2 et 7 (le
	// critère ancienneté à poids égal), tout le reste à 3.
	for (let i = 0; i < 12; i++) cells.push([1000 + i, 2000, i < 2 ? 1 : (i === 2 || i === 7) ? 2 : 3]);
	const cov = Coverage.fromStored({ v: 1, z: Z, cells });
	cov.cap(9);
	assert.equal(cov.size, 9);
	// Les deux « 1 » (les plus faibles) sont partis…
	assert.equal(cov.weightAt(1000, 2000), 0);
	assert.equal(cov.weightAt(1001, 2000), 0);
	// …puis, à poids égal (2), le plus ANCIEN : index 2 (w=2) avant index 7 (w=2).
	assert.equal(cov.weightAt(1002, 2000), 0);
	assert.equal(cov.weightAt(1007, 2000), 2);
	// Sous le plafond : no-op.
	const before = cov.toStored();
	cov.cap(9);
	assert.deepEqual(cov.toStored(), before);
	// Le plafond par défaut est MAX_CELLS.
	const big = new Coverage();
	const many = [];
	for (let i = 0; i < MAX_CELLS + 100; i++) many.push([i, 0, 1]);
	assert.equal(Coverage.fromStored({ v: 1, z: Z, cells: many }).cap().size, MAX_CELLS);
});

// ---------------------------------------------------------------------------
// Planifier le dessin — sans Leaflet, avec une projection linéaire jouée

t('planDraw : une cellule visible devient un disque au bon endroit, au bon rayon', () => {
	const cov = Coverage.fromStored({ v: 1, z: Z, cells: [[530971, 360731, 1]] });
	// Projection jouée : 10 px par cellule, origine au centre de la cellule.
	const c0 = cellCenter(530971, 360731), c1 = cellCenter(530972, 360731);
	const pxPerDegLon = 10 / (c1.lon - c0.lon);
	const pxPerDegLat = -10 / (cellCenter(530971, 360730).lat - c0.lat); // y vers le bas
	const project = (lat, lon) => ({ x: 100 + (lon - c0.lon) * pxPerDegLon, y: 100 - (lat - c0.lat) * pxPerDegLat });
	const plan = planDraw(cov, project, { w: 200, h: 200 });
	assert.equal(plan.length, 1);
	assert.ok(Math.abs(plan[0].cx - 100) < 1e-6 && Math.abs(plan[0].cy - 100) < 1e-6);
	assert.ok(Math.abs(plan[0].r - 10 * BLOB_RADIUS_CELLS) < 1e-6, `r=${plan[0].r}`);
	assert.ok(Math.abs(plan[0].alpha - ALPHA_MIN) < 1e-9, 'w=1 → ALPHA_MIN');
});

t('planDraw : l\'alpha monte linéairement avec le poids jusqu\'à ALPHA_MAX', () => {
	const cells = [];
	for (let w = 1; w <= W_MAX; w++) cells.push([530971 + w, 360731, w]);
	const cov = Coverage.fromStored({ v: 1, z: Z, cells });
	const project = (lat, lon) => ({ x: 100, y: 100 });
	const plan = planDraw(cov, project, { w: 200, h: 200 });
	assert.equal(plan.length, W_MAX);
	assert.ok(Math.abs(plan[0].alpha - ALPHA_MIN) < 1e-9);
	assert.ok(Math.abs(plan[W_MAX - 1].alpha - ALPHA_MAX) < 1e-9);
	for (let i = 1; i < plan.length; i++) assert.ok(plan[i].alpha > plan[i - 1].alpha);
});

t('planDraw : hors du cadre (au-delà du rayon), on ne dessine pas', () => {
	const cov = Coverage.fromStored({ v: 1, z: Z, cells: [[530971, 360731, 1], [530971, 360732, 1]] });
	// Première cellule loin dehors, seconde juste au bord (dans la marge r).
	let call = 0;
	// Chaque cellule projette deux fois (centre + voisine) : on rend la même
	// réponse pour les deux appels d'une cellule.
	const plan = planDraw(cov, (lat, lon) => {
		const i = Math.floor(call++ / 2);
		return i === 0 ? { x: -500, y: -500 } : { x: 205, y: 100 };
	}, { w: 200, h: 200 });
	// La première est hors cadre. La seconde est à 5 px du bord : gardée si
	// r >= 5 — or r vaut 0 quand centre et voisine projettent au même point, et
	// alors elle est hors cadre aussi. Ce qu'on vérifie : rien n'est dessiné
	// franchement dehors, et rien ne plante.
	assert.ok(plan.length <= 1);
	for (const p of plan) assert.ok(p.cx > -p.r && p.cx < 200 + p.r);
});

t('planDraw : une couverture vide rend un plan vide, quelle que soit la projection', () => {
	assert.deepEqual(planDraw(new Coverage(), () => ({ x: 0, y: 0 }), { w: 10, h: 10 }), []);
});

console.log(`\n${n} tests coverage OK`);
