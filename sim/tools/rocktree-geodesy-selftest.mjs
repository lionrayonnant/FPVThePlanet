// Selftest de la géodésie rocktree live (#168) : sphère -> ECEF WGS84 ->
// géodésique, et son inverse pour l'origine du spawn.
import assert from 'node:assert/strict';
import { sphereToWgs84Ecef, ecefToGeodetic, geodeticToEcef, enuBasis, ecefToLocalEnu, localEnuToEcef } from './lib/rocktree/geodesy.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('geodeticToEcef -> ecefToGeodetic fait un aller-retour (Tour Eiffel, alt 0)', () => {
	const lat = 48.8584, lon = 2.2945;
	const [x, y, z] = geodeticToEcef(lat, lon, 0);
	const back = ecefToGeodetic(x, y, z);
	assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${back.lat} vs ${lat}`);
	assert.ok(Math.abs(back.lon - lon) < 1e-6, `lon ${back.lon} vs ${lon}`);
	assert.ok(Math.abs(back.alt) < 1e-3, `alt ${back.alt}`);
});

t('geodeticToEcef -> ecefToGeodetic fait un aller-retour (altitude non nulle)', () => {
	const lat = 40.0, lon = -3.0, alt = 650;
	const [x, y, z] = geodeticToEcef(lat, lon, alt);
	const back = ecefToGeodetic(x, y, z);
	assert.ok(Math.abs(back.alt - alt) < 1e-3, `alt ${back.alt} vs ${alt}`);
});

t('sphereToWgs84Ecef : un point sur la sphère de rayon connu se corrige vers l\'ellipsoïde', () => {
	// Rayon mesuré (radius de PlanetoidMetadata, capture Paris) : 6 371 010 m.
	// Un point exactement SUR cette sphère à l'équateur, longitude 0 (h=0
	// relatif à la sphère de référence — "sea level" dans le modèle sphérique).
	//
	// Lire ces coordonnées brutes DIRECTEMENT comme de l'ECEF WGS84 (le bug
	// mesuré sur #18 Task 9) confond le rayon de la sphère de référence
	// (6 371 010 m) avec le rayon équatorial WGS84 (6 378 137 m) — l'écart de
	// 7 127 m se lit comme une fausse altitude très négative.
	const radius = 6371010;
	const naive = ecefToGeodetic(radius, 0, 0);
	assert.ok(naive.alt < -7000, `naive alt ${naive.alt} — attendue ~-7127 m (biais sphère/ellipsoïde non corrigé)`);

	// sphereToWgs84Ecef corrige ce biais : elle réinterprète la latitude/
	// longitude géocentriques du point et son altitude relative à la sphère
	// comme une latitude/longitude/hauteur géodésique WGS84, puis reconstruit
	// l'ECEF depuis l'ellipsoïde. Pour un point à hauteur 0 sur la sphère,
	// l'ECEF reconstruite tombe exactement sur la surface de l'ellipsoïde :
	// altitude corrigée ≈ 0, pas -7127 m.
	const [x, y, z] = sphereToWgs84Ecef(radius, 0, 0, radius);
	const g = ecefToGeodetic(x, y, z);
	assert.ok(Math.abs(g.alt) < 1e-6, `corrected alt ${g.alt} — attendue ≈ 0`);
	assert.ok(Math.abs(g.lat) < 1e-6);
});

t('ecefToLocalEnu : le point origine se projette sur (0,0,0)', () => {
	const origin = geodeticToEcef(48.8584, 2.2945, 0);
	const basis = enuBasis(48.8584, 2.2945);
	const local = ecefToLocalEnu(origin, origin, basis);
	assert.ok(Math.hypot(local.x, local.y, local.z) < 1e-6);
});

t('ecefToLocalEnu : un point 100 m plein est se projette sur x≈100, y≈0, z≈0', () => {
	const lat = 48.8584, lon = 2.2945;
	const origin = geodeticToEcef(lat, lon, 0);
	const basis = enuBasis(lat, lon);
	// Déplacement approximatif de 100 m est, en degrés de longitude, à cette latitude.
	const dLon = (100 / (111320 * Math.cos((lat * Math.PI) / 180)));
	const east100 = geodeticToEcef(lat, lon + dLon, 0);
	const local = ecefToLocalEnu(east100, origin, basis);
	assert.ok(Math.abs(local.x - 100) < 1, `x=${local.x}`);
	assert.ok(Math.abs(local.y) < 1, `y=${local.y}`);
	assert.ok(Math.abs(local.z) < 1, `z=${local.z}`);
});

t('localEnuToEcef -> ecefToLocalEnu fait un aller-retour', () => {
	const lat = 48.8584, lon = 2.2945;
	const origin = geodeticToEcef(lat, lon, 0);
	const basis = enuBasis(lat, lon);
	const local = { x: 123.4, y: 56.7, z: -89.0 };
	const ecef = localEnuToEcef(local, origin, basis);
	const back = ecefToLocalEnu(ecef, origin, basis);
	assert.ok(Math.abs(back.x - local.x) < 1e-6, `x ${back.x} vs ${local.x}`);
	assert.ok(Math.abs(back.y - local.y) < 1e-6, `y ${back.y} vs ${local.y}`);
	assert.ok(Math.abs(back.z - local.z) < 1e-6, `z ${back.z} vs ${local.z}`);
});

console.log(`rocktree-geodesy-selftest : ${n} tests ok`);
