// Selftest du modèle de limites de zone (issue #139). Aucun DOM, aucun
// Rapier : une bbox synthétique et des points qu'on place à la main.
// Lancer : node tools/geofence-selftest.mjs
import assert from 'node:assert/strict';
import {
	Geofence, horizontalMargin, verticalMargin,
	NOMINAL, CAUTION, HOLD, LOST,
	R_CAUTION, R_HOLD, FLOOR_CAUTION, FLOOR_HOLD, FLOOR_EDGE, FLOOR_LOST,
} from '../src/geofence.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une bbox carrée et généreuse : 2000 m de côté, 300 m de haut, centrée sur
// l'origine en X/Z. Assez grande pour que les couloirs (dizaines de mètres)
// ne se touchent jamais au centre.
const BBOX = { min: [-1000, -30, -1000], max: [1000, 270, 1000] };
const at = (x, y, z) => ({ x, y, z });
// Un point franchement au milieu, à mi-hauteur : la référence « tout va bien ».
const MIDDLE = at(0, 100, 0);

t('la marge horizontale est la distance à la face la plus proche', () => {
	assert.equal(horizontalMargin(at(0, 100, 0), BBOX), 1000);
	assert.equal(horizontalMargin(at(900, 100, 0), BBOX), 100);
	assert.equal(horizontalMargin(at(0, 100, -950), BBOX), 50);
	// Dehors : négative, et c'est la vraie distance euclidienne au bord.
	assert.equal(horizontalMargin(at(1030, 100, 0), BBOX), -30);
	// Dehors par un coin : la diagonale, pas le min des deux axes.
	assert.ok(Math.abs(horizontalMargin(at(1030, 100, 1040), BBOX) - -50) < 1e-9);
});

t('la marge verticale se compte depuis le point le plus bas du maillage', () => {
	assert.equal(verticalMargin(at(0, -30, 0), BBOX), 0);
	assert.equal(verticalMargin(at(0, 100, 0), BBOX), 130);
	assert.equal(verticalMargin(at(0, -36, 0), BBOX), -6);
});

t('au milieu : rien du tout', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.zone, NOMINAL);
	assert.equal(f.out.warning, '');
	assert.equal(f.out.lossDb, 0);
	assert.deepEqual(f.out.push, { x: 0, y: 0, z: 0 });
});

t('les quatre zones horizontales, dans l ordre', () => {
	const f = new Geofence(BBOX);
	const zoneAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.zone; };
	assert.equal(zoneAtMargin(R_CAUTION + 10), NOMINAL);
	assert.equal(zoneAtMargin((R_CAUTION + R_HOLD) / 2), CAUTION);
	assert.equal(zoneAtMargin(R_HOLD / 2), HOLD);
	assert.equal(zoneAtMargin(-1), LOST);
});

t('les quatre zones verticales, toutes sous le minimum du maillage', () => {
	const f = new Geofence(BBOX);
	const zoneAtY = (y) => { f.update(at(0, y, 0)); return f.out.zone; };
	const FLOOR = BBOX.min[1];
	assert.equal(zoneAtY(FLOOR + 1), NOMINAL, 'posé sur le point le plus bas : normal');
	assert.equal(zoneAtY(FLOOR - (FLOOR_CAUTION + FLOOR_HOLD) / 2), CAUTION);
	assert.equal(zoneAtY(FLOOR - (FLOOR_HOLD + FLOOR_LOST) / 2), HOLD);
	assert.equal(zoneAtY(FLOOR - FLOOR_LOST - 1), LOST);
});

t('la pire des deux zones gagne', () => {
	const f = new Geofence(BBOX);
	// Horizontalement en CAUTION, verticalement en HOLD : c'est HOLD.
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, BBOX.min[1] - (FLOOR_HOLD + FLOOR_LOST) / 2, 0));
	assert.equal(f.out.zone, HOLD);
});

t('l hystérésis : aucun aller-retour ne double une transition', () => {
	const f = new Geofence(BBOX);
	// On oscille autour de la frontière NOMINAL/CAUTION avec une amplitude
	// plus petite que l'hystérésis : la zone ne doit changer qu'une fois.
	const seen = [];
	let prev = null;
	for (let i = 0; i < 200; i++) {
		const m = R_CAUTION - 0.02 * (i % 2 === 0 ? 1 : -1);
		f.update(at(1000 - m, 100, 0));
		if (f.out.zone !== prev) { seen.push(f.out.zone); prev = f.out.zone; }
	}
	assert.equal(seen.length, 1, `strobe : ${seen.join(' → ')}`);
});

t('l avertissement suit la zone', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.warning, '');
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
	f.update(at(1000 - R_HOLD / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
});

t('over : vrai seulement une fois la session perdue', () => {
	const f = new Geofence(BBOX);
	f.update(at(1000 - 1, 100, 0));
	assert.equal(f.out.over, false);
	f.update(at(1000 + R_HOLD * 0.5, 100, 0));
	assert.equal(f.out.over, false, 'dehors mais pas encore au bout du couloir');
	f.update(at(1000 + R_HOLD + 1, 100, 0));
	assert.equal(f.out.over, true);
});

console.log(`\n${n} vérifications OK`);
