// Selftest de la logique pure de src/input.js. Aucune E/S, aucun DOM : la
// classe Input a besoin de `window`, seuls les helpers exportés sont couverts
// (détection de manette, profil par défaut, conversion de l'axe de gaz).
// Lancer : node tools/input-selftest.mjs
import assert from 'node:assert/strict';
import {
	padKind,
	defaultMapForKind,
	throttleModeForKind,
	throttleFromAxis,
	THROTTLE_MODE,
	CHANNELS,
} from '../src/input.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- padKind ----------------------------------------------------------------

t('padKind : identifiants Xbox réels (Chrome, Firefox, XInput)', () => {
	assert.equal(padKind('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)'), 'xbox');
	assert.equal(padKind('045e-02fd-Xbox Wireless Controller'), 'xbox');
	assert.equal(padKind('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
});

t('padKind : identifiants PlayStation réels (DS4 et DualSense)', () => {
	assert.equal(padKind('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'playstation');
	assert.equal(padKind('054c-09cc-Wireless Controller'), 'playstation');
	assert.equal(padKind('DualSense Wireless Controller'), 'playstation');
	assert.equal(padKind('Sony DualShock 4'), 'playstation');
});

t('padKind : « Xbox Wireless Controller » ne bascule pas en playstation', () => {
	// PLAYSTATION_RE contient « wireless controller » (nom Firefox de la DS4) :
	// sans le test Xbox en premier, la manette Xbox tombait du mauvais côté.
	assert.equal(padKind('Xbox Wireless Controller'), 'xbox');
});

t('padKind : radios EdgeTX avant tout le reste', () => {
	assert.equal(padKind('RadioMaster TX16S Joystick'), 'radio');
	assert.equal(padKind('OpenTX FrSky Taranis'), 'radio');
});

t('padKind : inconnu / vide -> generic', () => {
	assert.equal(padKind('Some No-Name Pad'), 'generic');
	assert.equal(padKind(''), 'generic');
	assert.equal(padKind(undefined), 'generic');
});

// --- profils ----------------------------------------------------------------

t('defaultMapForKind : Xbox, PlayStation et generic partagent le même profil', () => {
	assert.deepEqual(defaultMapForKind('xbox'), defaultMapForKind('playstation'));
	assert.deepEqual(defaultMapForKind('generic'), defaultMapForKind('playstation'));
});

t('defaultMapForKind : la radio a son propre profil', () => {
	assert.notDeepEqual(defaultMapForKind('radio'), defaultMapForKind('xbox'));
	assert.equal(defaultMapForKind('radio').throttle.axis, 2);
});

t('defaultMapForKind : tous les canaux sont définis, et c\'est une copie', () => {
	for (const kind of ['radio', 'xbox', 'playstation', 'generic']) {
		const m = defaultMapForKind(kind);
		for (const ch of CHANNELS) {
			assert.equal(typeof m[ch].axis, 'number', `${kind}.${ch}.axis`);
			assert.equal(typeof m[ch].invert, 'boolean', `${kind}.${ch}.invert`);
		}
	}
	const a = defaultMapForKind('xbox');
	a.roll.axis = 99;
	assert.equal(defaultMapForKind('xbox').roll.axis, 2);
});

t('profil manette : stick droit poussé en avant fait piquer', () => {
	// Axe 3 = -1 quand le stick est vers l'avant ; sans inversion, sticks.pitch
	// devient négatif, et flightController traite pitch > 0 comme « cabrer ».
	const m = defaultMapForKind('xbox');
	assert.equal(m.pitch.axis, 3);
	const forward = m.pitch.invert ? 1 : -1;
	assert.ok(forward < 0, 'stick en avant doit donner un pitch négatif (piquer)');
});

// --- throttle ---------------------------------------------------------------

t('throttleModeForKind : demi-course sauf pour la radio', () => {
	assert.equal(throttleModeForKind('radio'), THROTTLE_MODE.radio);
	assert.equal(throttleModeForKind('xbox'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('playstation'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('generic'), THROTTLE_MODE.gamepad);
});

t('throttleFromAxis half : stick auto-centré au repos = 0 % de gaz', () => {
	// Le point du choix : au centre la manette ne doit pas commander de gaz,
	// sinon le geste de désarmement (throttle < 0,08) est injoignable.
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.gamepad), 1);
	assert.equal(throttleFromAxis(0.5, THROTTLE_MODE.gamepad), 0.5);
});

t('throttleFromAxis full : la radio garde la pleine course', () => {
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.radio), 0);
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.radio), 0.5);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.radio), 1);
});

t('throttleFromAxis : borné dans 0..1 même sur un axe qui déborde', () => {
	for (const mode of [THROTTLE_MODE.radio, THROTTLE_MODE.gamepad]) {
		assert.equal(throttleFromAxis(-3, mode), 0);
		assert.equal(throttleFromAxis(3, mode), 1);
	}
});

console.log(`input-selftest: ${n} tests ok`);
