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
	padListEntries,
	PAD_LIST_EMPTY,
	calStoreGet,
	calStoreSet,
	sticksFromCalibration,
	remapChannel,
} from '../src/input.js';
import { padSignals } from '../src/calibration.js';

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

t('padKind : une radio est reconnue par son IDENTIFIANT USB, pas seulement par sa marque', () => {
	// 1209:4f54 — pid.codes / « OT » — est l'identifiant partagé des radios
	// OpenTX/EdgeTX. Constaté sur le matériel du projet : la Radiomaster Pocket
	// s'énumère ainsi. Les deux navigateurs formatent l'identifiant
	// différemment, les deux doivent passer.
	assert.equal(padKind('EdgeTX Radiomaster Pocket Joystick (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('1209-4f54-EdgeTX Radiomaster Pocket Joystick'), 'radio');
	// Le cas qui a motivé le correctif : aucun mot de marque de la liste
	// d'origine n'attrapait un TBS Tango 2, qui tombait donc en 'generic' —
	// c'est-à-dire sur GAMEPAD_MAP, dont l'ordre des axes est différent.
	assert.equal(padKind('TBS Tango 2 (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('TBS TANGO 2 Joystick'), 'radio');
});

t('padKind : classer une radio en generic donne des axes FAUX, pas juste un défaut cosmétique', () => {
	// La raison pour laquelle une mauvaise classification se vit comme « ça ne
	// marche pas » : les deux cartes n'assignent pas les mêmes axes.
	const radio = defaultMapForKind('radio'), generic = defaultMapForKind('generic');
	const differing = ['throttle', 'yaw', 'roll', 'pitch'].filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(differing.length, 4, `les 4 canaux doivent différer, ${differing.length} diffèrent`);
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'));
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

// --- l'écran de périphériques (issue #162) ----------------------------------

// La détection par nom de marque laissait un TBS Tango 2 en `generic` — et ce
// n'est pas cosmétique : les QUATRE canaux diffèrent entre EDGETX_MAP et
// GAMEPAD_MAP, et le mode de gaz passe de pleine course à demi-course. Le
// pilote ne perçoit pas « mal mappé », il perçoit « ça ne marche pas ».
// La détection passe donc par l'identifiant USB, et un ÉCRAN rend la
// reconnaissance par nom accessoire — c'est lui qui est testé plus bas.

t('#162 : une radio OpenTX/EdgeTX est reconnue par son identifiant USB', () => {
	// 1209:4f54 — « OT » en ASCII chez pid.codes. Les firmwares dérivés
	// d'OpenTX (dont FreedomTX, celui du Tango 2) le partagent.
	assert.equal(padKind('1209-4f54-RadioMaster Pocket Joystick'), 'radio');
	assert.equal(padKind('Unknown Gamepad (Vendor: 1209 Product: 4f54)'), 'radio');
	// Et par le nom, en second rideau, pour ce qui ne s'énumère pas ainsi.
	assert.equal(padKind('TBS TANGO 2'), 'radio');
	assert.equal(padKind('FreedomTX Joystick'), 'radio');
});

t('#162 : une radio ne se fait pas passer pour une manette de jeu', () => {
	// Le cœur du signalement : classée `generic`, elle recevait GAMEPAD_MAP.
	const radio = defaultMapForKind('radio');
	const generic = defaultMapForKind('generic');
	const diff = CHANNELS.filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(diff.length, CHANNELS.length, 'les quatre canaux diffèrent bien entre les deux profils');
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'),
		'le mode de gaz aussi : pleine course contre demi-course');
});

t('#162 : la liste montre CE QUE LE NAVIGATEUR VOIT, pas une supposition', () => {
	// listGamepads() et selectGamepad() existaient et n'étaient appelés NULLE
	// PART : il n'y avait aucun écran pour voir ce qui est détecté, ni pour
	// choisir quand deux périphériques sont branchés. C'est ce que padListEntries
	// décide désormais, et que le panneau Settings se contente de peindre.
	const pads = [
		{ index: 0, id: 'Xbox Wireless Controller (045e:02fd)', axes: 4, buttons: 16 },
		{ index: 1, id: 'TBS TANGO 2 (1209:4f54)', axes: 8, buttons: 0 },
	];
	const rows = padListEntries(pads, 1);
	assert.equal(rows.length, 2, 'une ligne par périphérique énuméré');

	// La classe déduite, qui est ce qui DÉCIDE du mappage : sans elle, « ça ne
	// marche pas » reste indiagnosticable.
	assert.equal(rows[0].kind, 'xbox');
	assert.equal(rows[1].kind, 'radio');

	// Les chiffres qu'on demande à un utilisateur dont la radio ne répond pas.
	assert.match(rows[1].label, /8 axes/);
	assert.match(rows[1].label, /0 buttons/);
	assert.match(rows[1].label, /TBS TANGO 2/);

	// Et lequel est actif, marqué comme le curseur des menus.
	assert.equal(rows[1].active, true);
	assert.equal(rows[0].active, false);
	assert.match(rows[1].label, /^▌/);
});

t('#162 : une énumération vide se DIT, au lieu de laisser conclure', () => {
	// L'API Gamepad n'expose un périphérique qu'après une action DESSUS :
	// « rien listé » n'est pas « non reconnu ». Une radio sans aucun bouton ne
	// peut pas satisfaire cette condition en bougeant seulement ses manches.
	assert.deepEqual(padListEntries([], 0), []);
	assert.deepEqual(padListEntries(null, 0), [], 'pas d\'énumération du tout : pas de plantage');
	assert.match(PAD_LIST_EMPTY, /only reveals it after an input/);
});

// --- calibrage stocké PAR PÉRIPHÉRIQUE (issue #277) -------------------------
//
// Le défaut que ça corrige : `_savedMap` était un booléen global, et le mappage
// une seule entrée de localStorage. Un remap fait pour une radio restait donc
// collé quand on branchait une DualShock 4 — dont les axes sont dans un ordre
// différent ET dont le gaz est en demi-course.

const RADIO_CAL = {
	channels: {
		throttle: { axis: 2, lo: -1, hi: 1 },
		yaw: { axis: 3, center: 0, span: 1, invert: false },
		pitch: { axis: 1, center: 0, span: 1, invert: true },
		roll: { axis: 0, center: 0, span: 1, invert: false },
	},
	deadband: 0.02,
	throttleMode: 'full',
};

const DS4_CAL = {
	channels: {
		throttle: { axis: 1, lo: 0, hi: -1 },
		yaw: { axis: 0, center: 0, span: 1, invert: false },
		pitch: { axis: 3, center: 0, span: 1, invert: false },
		roll: { axis: 2, center: 0, span: 1, invert: false },
	},
	deadband: 0.03,
	throttleMode: 'half',
};

t('#277 : calibrer une manette ne touche pas au calibrage de la radio', () => {
	let store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	store = calStoreSet(store, 'Wireless Controller (054c)', DS4_CAL);

	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').throttleMode, 'full');
	assert.equal(calStoreGet(store, 'Wireless Controller (054c)').throttleMode, 'half');
	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').channels.throttle.axis, 2);
});

t('#277 : un périphérique jamais calibré ne récupère pas celui d\'un autre', () => {
	const store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	assert.equal(calStoreGet(store, 'Xbox Wireless Controller'), null);
});

t('#277 : un stockage corrompu ne fait pas tomber le démarrage', () => {
	// Même règle que loadMap() : une clé illisible retombe sur le comportement
	// par défaut, elle n'empêche pas le sim de booter.
	assert.equal(calStoreGet(null, 'x'), null);
	assert.equal(calStoreGet({ x: 'pas un objet' }, 'x'), null);
	assert.equal(calStoreGet({ x: { channels: {} } }, 'x'), null, 'quatre canaux ou rien');
	assert.equal(calStoreGet({ x: { ...DS4_CAL, channels: { ...DS4_CAL.channels, roll: null } } }, 'x'), null);
});

t('#277 : les sticks sortent du calibrage, pas de suppositions', () => {
	// Radio : gaz à friction parqué en bas -> 0 % de gaz, pas 50 %.
	assert.deepEqual(sticksFromCalibration([0, 0, -1, 0], RADIO_CAL), {
		throttle: 0, yaw: 0, pitch: 0, roll: 0,
	});

	const plein = sticksFromCalibration([0, 0, 1, 0], RADIO_CAL);
	assert.equal(plein.throttle, 1);

	// DS4 : manche lâché -> 0 % de gaz. C'est ce qui garde le geste de
	// désarmement (throttle < 0,08) joignable au repos.
	assert.equal(sticksFromCalibration([0, 0, 0, 0], DS4_CAL).throttle, 0);
	assert.equal(sticksFromCalibration([0, -1, 0, 0], DS4_CAL).throttle, 1);
});

t('#277 : le tangage calibré respecte la convention « tiré vers soi = cabrer »', () => {
	// flightController : pitch > 0 = cabrer. Sur la radio l'axe vaut -1 quand
	// le manche est tiré vers soi, d'où invert:true.
	assert.ok(sticksFromCalibration([0, -1, -1, 0], RADIO_CAL).pitch > 0.9);
	// Sur la DS4 le même geste met l'axe Y droit à +1, sans inversion.
	assert.ok(sticksFromCalibration([0, 0, 0, 1], DS4_CAL).pitch > 0.9);
});

t('#277 : un remap manuel sur le MÊME axe garde la course mesurée', () => {
	// Le pilote inverse le tangage à la main : il conteste un SENS, pas une
	// mesure. Jeter la course mesurée à cette occasion lui reprendrait ce que
	// le calibrage venait de lui donner.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 3, true);
	assert.equal(out.channels.pitch.span, 0.8);
	assert.equal(out.channels.pitch.center, 0.05);
	assert.equal(out.channels.pitch.invert, true);
});

t('#277 : un remap manuel vers un AUTRE axe n\'invente pas de mesure', () => {
	// Rien n'a jamais été mesuré sur l'axe 2 pour ce canal : on retombe sur les
	// suppositions (neutre 0, course ±1), pas sur les chiffres de l'axe 3.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 2, false);
	assert.deepEqual(out.channels.pitch, { axis: 2, center: 0, span: 1, invert: false });
});

t('#277 : inverser un gaz demi-course NE MET PAS de gaz au repos', () => {
	// Le cas dangereux. Le plancher d'un gaz auto-centré est le neutre : c'est
	// LUI qui doit rester en place quand on inverse, sinon manette lâchée =
	// plein gaz, et le geste de désarmement devient injoignable.
	const out = remapChannel(DS4_CAL, 'throttle', 1, false);
	assert.equal(sticksFromCalibration([0, 0, 0, 0], out).throttle, 0);
	assert.equal(sticksFromCalibration([0, 1, 0, 0], out).throttle, 1);
});

t('#279 : une Pocket dont le gaz est sur la gâchette vole correctement', () => {
	// Le chemin complet, tel que readStandardGamepad() l'emprunte : l'objet
	// Gamepad du navigateur -> padSignals() -> sticksFromCalibration(). Sur une
	// Radiomaster Pocket que Firefox mappe en « standard », le gaz sort sur
	// buttons[6].value et le quatrième axe est mort — mesuré, voir #279.
	const pocket = (roll, pitch, yaw, btn6) => ({
		axes: [roll, pitch, yaw, 0, 0, 0, 0, 0],
		buttons: Array.from({ length: 28 }, (_, i) => ({ value: i === 6 ? btn6 : 0 })),
	});
	// Le bouton 6 devient le signal 8 + 6 = 14, de course -1..1 comme un axe.
	const cal = {
		channels: {
			throttle: { axis: 14, lo: -1, hi: 0.994 },
			yaw: { axis: 2, center: 0, span: 1, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: true },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
		deadband: 0.02,
		throttleMode: 'full',
		axisCount: 8,
	};

	const repos = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0)), cal);
	assert.equal(repos.throttle, 0, 'gaz en bas = 0, sinon le désarmement est injoignable');
	assert.equal(repos.yaw, 0);

	const plein = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0.997)), cal);
	assert.ok(plein.throttle > 0.99, `gaz à fond = ${plein.throttle}`);

	// Et le gaz sur un bouton ne parasite aucun des trois autres canaux.
	assert.equal(plein.roll, 0);
	assert.equal(plein.pitch, 0);
	assert.equal(plein.yaw, 0);

	const droite = sticksFromCalibration(padSignals(pocket(1, 0, 0, 0)), cal);
	assert.ok(droite.roll > 0.97, `roulis à droite = ${droite.roll}`);
	assert.equal(droite.throttle, 0, 'bouger un manche ne met pas de gaz');
});

console.log(`input-selftest: ${n} tests ok`);
