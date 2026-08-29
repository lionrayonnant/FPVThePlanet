// Selftest de la géométrie de polygone partagée (issue #30). Aucune E/S réseau,
// aucun DOM. Lancer : node tools/map-poly-selftest.mjs
//
// Ces cas sont raisonnés à la main, pas relevés depuis l'implémentation : c'est
// ce port JS qui sert ensuite de référence à testdata/poly-cases.json, donc il
// ne peut pas se valider sur sa propre sortie.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	polygonBounds, pointInPolygon, segmentsIntersect, tileIntersectsPolygon,
	polygonGrid, maskKeys, polygonArea, canonicalPoly, polyHash,
	maskOutline, polygonProbePoint,
	tileGrid, tileTMSToLatLon, latLonToTileTMS,
} from './lib/tiles.mjs';
import { tileDirName } from './lib/add-map-core.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Un carré de 0.01° autour de (48.85, 2.30).
const SQUARE = [48.845, 2.295, 48.845, 2.305, 48.855, 2.305, 48.855, 2.295];

t('polygonBounds : l\'emprise du tracé', () => {
	assert.deepEqual(polygonBounds(SQUARE),
		{ south: 48.845, west: 2.295, north: 48.855, east: 2.305 });
});

t('pointInPolygon : dedans, dehors, et le centre d\'un L est dehors', () => {
	assert.equal(pointInPolygon(48.85, 2.30, SQUARE), true);
	assert.equal(pointInPolygon(48.86, 2.30, SQUARE), false);
	// Un L dont le centre de l'emprise tombe dans l'encoche : c'est le cas qui
	// casse une sonde visant le centre de la bbox.
	const L_SHAPE = [0, 0, 0, 10, 4, 10, 4, 4, 10, 4, 10, 0];
	assert.equal(pointInPolygon(5, 5, L_SHAPE), false, 'centre de l\'emprise, hors du L');
	assert.equal(pointInPolygon(2, 2, L_SHAPE), true);
	assert.equal(pointInPolygon(8, 2, L_SHAPE), true);
});

t('segmentsIntersect : croisement, disjoint, colinéaire, touche par un bout', () => {
	assert.equal(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0), true, 'croix');
	assert.equal(segmentsIntersect(0, 0, 1, 1, 5, 5, 6, 6), false, 'disjoints');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0), true, 'colinéaires chevauchants');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 10, 0, 10, 10), true, 'bout à bout');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 11, 0, 20, 0), false, 'colinéaires disjoints');
});

t('tileIntersectsPolygon : les quatre façons de se toucher', () => {
	const box = { south: 0, west: 0, north: 1, east: 1 };
	// Tuile entièrement dans le tracé : aucun sommet dans la tuile, aucune arête
	// qui la croise — seul un coin de tuile testé contre le tracé le voit.
	assert.equal(tileIntersectsPolygon([-5, -5, -5, 5, 5, 5, 5, -5], box), true, 'tuile incluse');
	// Tracé entièrement dans la tuile : symétrique.
	assert.equal(tileIntersectsPolygon([.2, .2, .2, .8, .8, .8, .8, .2], box), true, 'tracé inclus');
	// Le tracé traverse la tuile de part en part.
	assert.equal(tileIntersectsPolygon([.4, -5, .6, -5, .6, 5, .4, 5], box), true, 'traversée');
	// Le tracé ne mord que le coin nord-est.
	assert.equal(tileIntersectsPolygon([.9, .9, .9, 5, 5, 5, 5, .9], box), true, 'un coin');
	assert.equal(tileIntersectsPolygon([2, 2, 2, 3, 3, 3, 3, 2], box), false, 'à côté');
});

t('polygonGrid : la grille est celle de l\'emprise, le masque en retire des colonnes', () => {
	// Un triangle rectangle : environ la moitié de son emprise, mais la règle est
	// l'intersection, donc strictement plus que la moitié.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const box = tileGrid(polygonBounds(TRI), 20);
	assert.equal(g.cols, box.cols, 'même emprise que la bbox');
	assert.equal(g.rows, box.rows);
	assert.equal(g.keep.length, box.cols * box.rows);
	assert.ok(g.columns < box.columns, 'le masque retire des colonnes');
	assert.ok(g.columns > box.columns / 2, 'mais plus que la moitié : on arrondit vers l\'extérieur');
	assert.equal(g.columns + g.masked, box.columns, 'gardées + masquées = toute l\'emprise');
});

t('polygonGrid : un tracé plus fin qu\'une tuile rend quand même des colonnes', () => {
	// ~2 m de large au zoom 20, où la tuile fait ~25 m. Une règle « centre dans
	// le tracé » rendrait zéro ; la règle d'intersection couvre le corridor.
	const THIN = [48.8500, 2.2950, 48.8500, 2.3050, 48.85002, 2.3050, 48.85002, 2.2950];
	const g = polygonGrid(THIN, 20);
	assert.ok(g.columns >= 1, 'au moins une colonne');
	assert.equal(g.rows <= 2, true, 'une ou deux rangées, pas plus');
});

t('polygonGrid : un carré aligné sur le treillis ne garde que ses tuiles', () => {
	// On construit le tracé SUR les bords de tuiles : toutes les tuiles de
	// l'emprise sont alors touchées, aucune n'est masquée. (L'emprise elle-même
	// gagne une colonne et une rangée de plus que les tuiles nommées : un bord
	// pile sur une limite de tuile appartient à la tuile suivante. C'est
	// l'arrondi vers l'extérieur de tileGrid, déjà vrai pour un rectangle.)
	const z = 20;
	const a = tileTMSToLatLon(z, 500000, 400000);
	const b = tileTMSToLatLon(z, 500003, 400002);
	const ring = [a.lat, a.lon, a.lat, b.lon, b.lat, b.lon, b.lat, a.lon];
	const g = polygonGrid(ring, z);
	assert.equal(g.columns, g.cols * g.rows, 'aucune tuile masquée');
	assert.equal(g.masked, 0);
});

t('maskKeys : trié, une clé par tuile gardée', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const keys = maskKeys(g);
	assert.equal(keys.length, g.columns);
	assert.deepEqual(keys, [...keys].sort(), 'ordre stable');
	assert.match(keys[0], /^\d+\/\d+$/);
});

t('polygonArea : l\'aire du tracé, pas celle de l\'emprise', () => {
	// Le carré : son aire vaut celle de son emprise, à 0.5 % près.
	const R = 6371000, rad = Math.PI / 180;
	const expected = (0.01 * rad * R) * (0.01 * rad * R * Math.cos(48.85 * rad));
	assert.ok(Math.abs(polygonArea(SQUARE) - expected) / expected < 0.005, 'carré ≈ son emprise');
	// Le triangle rectangle : la moitié, à 1 % près.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	assert.ok(Math.abs(polygonArea(TRI) - expected / 2) / (expected / 2) < 0.01, 'triangle ≈ la moitié');
	assert.ok(polygonArea(SQUARE) > 0, 'toujours positive');
	// Le sens de parcours ne change pas l'aire.
	const REVERSED = [];
	for (let i = SQUARE.length - 2; i >= 0; i -= 2) REVERSED.push(SQUARE[i], SQUARE[i + 1]);
	assert.ok(Math.abs(polygonArea(REVERSED) - polygonArea(SQUARE)) < 1e-6, 'horaire = antihoraire');
});

t('canonicalPoly : 6 décimales, comme les %f du Go', () => {
	assert.equal(canonicalPoly([1, 2, 3, 4, 5, 6]),
		'1.000000,2.000000,3.000000,4.000000,5.000000,6.000000');
	assert.equal(canonicalPoly([48.8582001234, 2.2969876543, 1, 2, 3, 4]).split(',')[0], '48.858200');
});

await at('polyHash : 12 hex, stable, sensible au moindre sommet', async () => {
	const h = await polyHash(SQUARE);
	assert.match(h, /^[0-9a-f]{12}$/);
	assert.equal(h, await polyHash(SQUARE), 'stable');
	const moved = [...SQUARE]; moved[0] += 0.000001;
	assert.notEqual(h, await polyHash(moved), 'un micro-degré change le hash');
});

t('maskOutline : le contour d\'un bloc plein est son périmètre, pas ses lignes internes', () => {
	const z = 20;
	const a = tileTMSToLatLon(z, 500000, 400000);
	const b = tileTMSToLatLon(z, 500003, 400002);
	const ring = [a.lat, a.lon, a.lat, b.lon, b.lat, b.lon, b.lat, a.lon];
	const g = polygonGrid(ring, z);
	// Un bloc plein n'a que son périmètre : une arête par tuile de bordure, et
	// aucune des arêtes internes que les tuiles se partagent deux à deux.
	assert.equal(g.masked, 0, 'le bloc est bien plein');
	assert.equal(maskOutline(g, z).length, 2 * (g.cols + g.rows));
});

t('maskOutline : le contour d\'un tracé masqué est fermé', () => {
	// L'invariant qui compte pour du dessin : chaque sommet du contour est
	// touché un nombre PAIR de fois, donc les segments se referment. C'est vrai
	// de n'importe quel masque, y compris troué ou en plusieurs morceaux.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const segs = maskOutline(g, 20);
	assert.ok(g.masked > 0, 'le triangle masque bien des tuiles');

	const degree = new Map();
	for (const seg of segs) {
		assert.equal(seg.length, 2);
		for (const p of seg) {
			assert.equal(p.length, 2, '[lat, lon]');
			const k = `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
			degree.set(k, (degree.get(k) ?? 0) + 1);
		}
	}
	assert.equal([...degree.values()].filter((d) => d % 2 === 1).length, 0, 'aucun sommet de degré impair');

	// Et un fait contre-intuitif, noté pour qui voudrait « optimiser » le tracé
	// du contour : l'escalier d'une diagonale monotone a EXACTEMENT le même
	// périmètre que le bloc plein qui l'englobe — 2×(cols+rows). C'est l'identité
	// du taxi ; les marches somment aux deux côtés qu'elles remplacent. Le
	// contour d'un polygone ne coûte donc pas plus de segments que celui d'un
	// rectangle, quoi qu'en suggère l'aspect dentelé.
	assert.equal(segs.length, 2 * (g.cols + g.rows));
});

t('polygonProbePoint : dans le tracé même quand le centroïde ne l\'est pas', () => {
	// Un L à l'échelle d'une ville : le centre de son emprise tombe dans
	// l'encoche. Viser ce centre ferait juger une zone qu'on n'extrait pas.
	const L_SHAPE = [48.840, 2.280, 48.840, 2.320, 48.850, 2.320, 48.850, 2.290, 48.870, 2.290, 48.870, 2.280];
	assert.equal(pointInPolygon(48.855, 2.300, L_SHAPE), false, 'le centroïde est bien hors du L');

	const p = polygonProbePoint(L_SHAPE, 20);
	const g = polygonGrid(L_SHAPE, 20);
	const { x, y } = latLonToTileTMS(20, p.lat, p.lon);
	assert.equal(g.keep[(y - g.yMin) * g.cols + (x - g.xMin)], 1, 'la sonde vise une tuile retenue');
});

t('polygonProbePoint : déterministe', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	assert.deepEqual(polygonProbePoint(TRI, 20), polygonProbePoint(TRI, 20));
});

// La fixture est le procès-verbal du port JS validé ci-dessus. La relire ici
// fait que toute modification de tiles.mjs qui change un résultat casse ce
// selftest AVANT de casser le Go — et rappelle qu'il faut alors comprendre
// pourquoi, pas régénérer.
await at('fixture partagée : tiles.mjs est resté d\'accord avec elle', async () => {
	const fixture = JSON.parse(
		fs.readFileSync(new URL('../../flyover-reverse-engineering/testdata/poly-cases.json', import.meta.url), 'utf8'));
	assert.ok(fixture.length >= 10, 'la fixture a des cas');
	for (const c of fixture) {
		const g = polygonGrid(c.ring, c.zoom);
		assert.equal(g.columns, c.columns, `${c.name} : colonnes`);
		assert.equal(g.masked, c.masked, `${c.name} : masquées`);
		assert.deepEqual(maskKeys(g), c.keys, `${c.name} : tuiles retenues`);
		assert.deepEqual(polygonBounds(c.ring), c.bounds, `${c.name} : emprise`);
		assert.equal(canonicalPoly(c.ring), c.canonical, `${c.name} : chaîne canonique`);
		assert.equal(await polyHash(c.ring), c.hash, `${c.name} : hash`);
		assert.ok(Math.abs(polygonArea(c.ring) - c.areaM2) < 1e-6, `${c.name} : aire`);
	}
});

await at('tileDirName : le nom du cache, en phase avec le Sprintf du Go', async () => {
	const fixture = JSON.parse(
		fs.readFileSync(new URL('../../flyover-reverse-engineering/testdata/poly-cases.json', import.meta.url), 'utf8'));
	const c = fixture[0];
	assert.equal(await tileDirName({ poly: c.ring, zoom: 20, altitude: 20 }), `poly-${c.hash}-20-20`);
	// Les deux autres formes ne bougent pas.
	assert.equal(await tileDirName({ lat: 48.8582, lon: 2.2945, zoom: 20, radius: 25, altitude: 20 }),
		'48.858200-2.294500-20-25-20');
	assert.equal(await tileDirName({ bbox: { south: 48.845, west: 2.295, north: 48.855, east: 2.305 }, zoom: 20, altitude: 20 }),
		'bbox-48.845000-2.295000-48.855000-2.305000-20-20');
});

t('un tracé et son emprise ne partagent pas de cache', () => {
	// Sinon un polygone reprendrait le téléchargement partiel d'un rectangle,
	// et rendrait une carte trouée sans rien dire.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	assert.notEqual(g.columns, g.cols * g.rows);
});

console.log(`\n${n} vérifications, tout passe.`);
