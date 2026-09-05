// PHASE 07 — l'exemplaire. Logique pure, importée par le selftest (Node) et par
// le client (bundle Vite), comme tools/target-camera.mjs et
// tools/target-model.mjs.
//
// Une famille (src/drone-profiles.js) décrit un TYPE de machine. Elle ne décrit
// pas la machine qu'on va voler : celle-ci a été montée par quelqu'un, avec le
// pack qu'il avait, des moteurs d'un lot donné, une GoPro ou pas, et des rates
// réglés à SON goût. C'est ce fichier.
//
//   terrain persistent, flights ephemeral — l'exemplaire appartient à la session.
//
// Ce qui NE varie jamais, et c'est l'identité de la famille (l'interdit de
// l'issue #44 : « un 5" Race ne devient pas un Cinewhoop parce qu'une valeur a
// bougé ») :
//
//   family · label · rates (nom du preset) · battery.cells · propRadius ·
//   bladeCount · armX/armZ · filterScale · pid
//
// `pid` en particulier reste le bloc mesuré de la famille, jamais re-dérivé.
// C'est un choix, pas un oubli : le drone n'est pas le tien, son tune est celui
// de son propriétaire — réglé pour SA famille, pas pour l'exemplaire exact que
// tu viens de détourner. Un exemplaire lourd est donc un peu mou, un léger un
// peu nerveux, et c'est là que se joue la différence entre deux 5" Race. Le
// selftest prouve que tout tirage reste pilotable sur ce tune (voir plus bas).

import { PROFILES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { RATE_PRESETS } from '../src/flightController.js';

// Bornes du tirage, exportées pour que le selftest les vérifie au lieu de les
// répéter. Chaque plage est un multiplicateur sur la valeur de la famille.
export const BUILD_BOUNDS = {
	// Masse tout-up : un pack plus gros, une GoPro montée ou pas, de la boue.
	mass: [0.88, 1.12],
	// Répartition de masse, EN PLUS du facteur de masse : pack reculé, caméra
	// sur le dessus. L'inertie suit la masse — une inertie qui ne suivrait pas
	// serait un objet physiquement impossible.
	inertiaSpread: [0.96, 1.04],
	// Dispersion de lot moteur / KV. La poussée n'est PAS tirée séparément : à
	// hélice constante elle va en ω², donc thrust *= kv². C'est ce couplage qui
	// garde le coefficient de poussée de l'hélice (quad.js) intact.
	kv: [0.925, 1.072],
	// Le pack. capacity : sa taille et son usure confondues. internalOhm : son
	// âge, et c'est de loin la variation la plus ressentie — un vieux pack sag.
	capacity: [0.85, 1.15],
	internalOhm: [1.00, 1.60],
	// Qualité de montage : hélices plus ou moins usées, câblage qui dépasse.
	torqueRatio: [0.92, 1.08],
	bodyDrag: [0.92, 1.08],
	// Les rates du propriétaire. Le haut est plus serré que le bas (1.12 contre
	// 0.85) : le tune de la famille a été mesuré au preset nominal, et lui
	// demander beaucoup plus de taux que ça, c'est sortir de ce qui a été mesuré.
	rate: [0.85, 1.12],
	// Jitter par axe autour de ce réglage global — personne n'a exactement les
	// mêmes rates en roll et en pitch.
	rateAxis: [0.96, 1.04],
	// Décalage d'expo, additif et borné à [0, 0.9] après coup.
	expo: [-0.08, 0.08],
};

// Amplitude de variation par famille, 0..1, appliquée à TOUTES les bornes
// ci-dessus (0 = l'exemplaire est exactement le profil nominal).
//
// Vide aujourd'hui : plus aucune famille n'est gelée. MICRO y était à 0, et
// c'était une mesure — le toothpick nominal overshootait de 24 % sur un flick
// plein manche pour un plafond de 25 %, un balayage masse × rates le poussant à
// 131 % à rate ×0.97 quelle que soit la masse, et jusqu'à 139 % sur une masse
// haute. Pas du bruit : une résonance du bouclage.
//
// La cause n'était pas le tune, c'était #144. La secousse de propwash valait
// 0,05 N·m en dur, soit 596 % de l'autorité d'un toothpick, et elle suit
// maintenant poussée × bras. Re-mesuré depuis (issue #234) : 1200 exemplaires
// MICRO tirés à variation PLEINE, contrôle de roulis du selftest, masses de
// 79,2 à 100,8 g —
//
//   pic  : pire 106 % du commandé (plafond 125 %), 0/1200 au-dessus
//   tenu : pire  99 % du commandé (plancher  90 %), 0/1200 en dessous
//
// le nominal lui-même étant redescendu de 124 % à 102 % de pic. Le gel n'avait
// plus d'objet ; il est levé.
//
// Ce qui RESTE de #71 est distinct et n'est pas traité ici : un profil ~34 g
// TIENT 492 °/s pour 420 commandés — un tune trop nerveux pour cette masse, pas
// une divergence. Celui-là demande bien un re-mesurage (`npm run tune`), et
// c'est pourquoi le 1S whoop reste hors de PHASE 07.
//
// La mécanique de gel, elle, reste en place : y remettre une famille suffit à
// figer ses exemplaires sur le nominal, et les deux garde-fous de
// tools/target-build-selftest.mjs qui la vérifient rebasculent tout seuls — ils
// se mettent simplement en sommeil tant que l'objet est vide.
export const FAMILY_VARIATION = {};
export const DEFAULT_VARIATION = 1;

// Champs qui définissent la famille et ne bougent jamais. Le selftest les
// compare un à un au profil de référence.
export const INVARIANTS = [
	'family', 'label', 'rates', 'propRadius', 'bladeCount',
	'armX', 'armZ', 'filterScale', 'rpmCurve', 'radius',
];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même géné que
// tools/target-camera.mjs, tools/target-model.mjs et src/link.js).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

// Tire dans [lo, hi] ramené vers 1 par `amount` : à 0 la fonction rend 1 et
// l'exemplaire est le profil nominal, à 1 elle rend la borne entière. Le tirage
// est consommé dans tous les cas, pour qu'une famille à variation nulle n'ait
// pas un flux RNG décalé par rapport aux autres.
const lerp = (rand, [lo, hi], amount = 1) => {
	const v = lo + rand() * (hi - lo);
	return 1 + (v - 1) * amount;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const GRAVITY = 9.81;

// Le rapport poussée/poids de l'exemplaire. Sert au selftest et à l'affichage :
// c'est le seul scalaire qui résume « ce que cette machine a dans le ventre ».
export function thrustToWeight(profile) {
	return (4 * profile.maxThrustPerMotor) / (profile.mass * GRAVITY);
}

// Les rates de l'exemplaire : la forme exacte d'une entrée de RATE_PRESETS,
// pour que flightController.js n'ait rien de spécial à savoir.
function buildRates(rand, presetName, amount) {
	const preset = RATE_PRESETS[presetName] ?? RATE_PRESETS.freestyle;
	// Un seul facteur global d'abord : un pilote règle ses rates comme un tout,
	// il est « rapide » ou « posé », pas rapide en roll et posé en pitch.
	const global = lerp(rand, BUILD_BOUNDS.rate, amount);
	const out = { label: preset.label };
	for (const axis of ['roll', 'pitch', 'yaw']) {
		const a = preset[axis];
		const k = global * lerp(rand, BUILD_BOUNDS.rateAxis, amount);
		// `expo` est un décalage additif, pas un facteur : il se ramène vers 0.
		const dExpo = (lerp(rand, BUILD_BOUNDS.expo.map((e) => 1 + e), amount) - 1);
		out[axis] = {
			centre: a.centre * k,
			max: a.max * k,
			expo: clamp(a.expo + dExpo, 0, 0.9),
		};
	}
	return out;
}

// seed : le `buildSeed` porté par la cible résolue (tools/target-model.mjs), de
// sorte que le serveur, le client et un resume produisent le même exemplaire.
export function targetBuild({ seed, family } = {}) {
	if (!seed) throw new Error('seed requis');
	const base = PROFILES[family] ?? PROFILES[DEFAULT_FAMILY];
	const rand = rngFrom(`${seed}::build::${base.family}`);
	const amount = FAMILY_VARIATION[base.family] ?? DEFAULT_VARIATION;

	const massK = lerp(rand, BUILD_BOUNDS.mass, amount);
	const kv = lerp(rand, BUILD_BOUNDS.kv, amount);
	const dragK = lerp(rand, BUILD_BOUNDS.bodyDrag, amount);

	const profile = {
		...base,
		mass: base.mass * massK,
		// L'inertie suit la masse, plus la répartition. Un tirage par axe : une
		// GoPro sur le dessus n'ajoute pas la même chose en roll qu'en yaw.
		inertia: {
			x: base.inertia.x * massK * lerp(rand, BUILD_BOUNDS.inertiaSpread, amount),
			y: base.inertia.y * massK * lerp(rand, BUILD_BOUNDS.inertiaSpread, amount),
			z: base.inertia.z * massK * lerp(rand, BUILD_BOUNDS.inertiaSpread, amount),
		},
		maxOmega: base.maxOmega * kv,
		maxThrustPerMotor: base.maxThrustPerMotor * kv * kv,
		torqueRatio: base.torqueRatio * lerp(rand, BUILD_BOUNDS.torqueRatio, amount),
		bodyDrag: {
			x: base.bodyDrag.x * dragK,
			y: base.bodyDrag.y * dragK,
			z: base.bodyDrag.z * dragK,
		},
		battery: {
			...base.battery,
			capacityMah: base.battery.capacityMah * lerp(rand, BUILD_BOUNDS.capacity, amount),
			internalOhm: base.battery.internalOhm * lerp(rand, BUILD_BOUNDS.internalOhm, amount),
		},
		// Le bloc mesuré de la famille, par référence et intact. Voir l'en-tête.
		pid: base.pid,
	};

	const rates = buildRates(rand, base.rates, amount);

	return {
		family: base.family,
		variation: amount,
		profile,
		rates,
		// Ce qu'on peut en dire une fois en vol, et rien avant (PHASE 08 : la
		// fiche pré-hack ne connaît ni la masse ni la batterie).
		spec: {
			massG: Math.round(profile.mass * 1000),
			cells: profile.battery.cells,
			capacityMah: Math.round(profile.battery.capacityMah),
			twr: thrustToWeight(profile),
			rateMaxDeg: Math.round(rates.roll.max),
		},
	};
}
