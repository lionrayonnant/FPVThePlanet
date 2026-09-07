// La LIVRÉE d'un exemplaire (issue #284) — logique pure, importée par le
// selftest (Node) et par le client, comme tools/target-camera.mjs.
//
// Un build n'est pas qu'une masse et un pack : quelqu'un l'a monté, avec les
// hélices qu'il avait, des cloches d'un lot, du TPU d'une couleur, un pack
// d'une marque. Sans livrée, deux race5 sont indiscernables en free cam, et le
// procédural de PHASE 07 reste invisible à l'image.
//
// Ce qui est tiré ici n'a AUCUN effet sur le vol : la livrée sort d'un flux de
// graine à part (`seed::livery`, voir targetBuild), donc aucun tirage physique
// ne bouge d'un octet en l'ajoutant. C'est un contrat que le selftest tient.
//
// Les couleurs sont celles du VRAI matériel — hélices néon, cloches anodisées,
// TPU vif — et pas les jetons de la palette du terminal : le monde est
// photographique (Bible §19 ne parle que des écrans). Elles sont un peu
// désaturées : l'objectif de vol et la lumière du soleil font le reste.
//
// Chaque entrée : [nom, hex]. Le nom est fait pour une fiche (« PROPS NEON
// GREEN »), le hex pour le maillage.

// Sombre / clair / vif, dans cet ordre : les pondérations par famille
// choisissent entre « discret » (les trois premières) et « vif » (le reste).
export const PROPS = [
	['smoke', 0x2b2926], ['clear', 0xa8a39b], ['white', 0xe6e1d7],
	['neon green', 0x86d84c], ['orange', 0xf08034], ['red', 0xd4463c],
	['cyan', 0x48c4d6], ['purple', 0x8f5ff0], ['yellow', 0xe9c93f],
	['pink', 0xe66aa6], ['blue', 0x3f74e6],
];
export const BELLS = [
	['black', 0x1c1a17], ['silver', 0xa39f98],
	['red', 0xb83a33], ['purple', 0x6c44b8], ['blue', 0x3160c2], ['gold', 0xc7a24e], ['teal', 0x2f9a96],
];
export const TPU = [
	['black', 0x171513],
	['orange', 0xe8752f], ['neon green', 0x7ccf44], ['red', 0xcc3f38], ['yellow', 0xe2c23a],
	['white', 0xd9d4ca], ['blue', 0x3a6ad8], ['purple', 0x8455d8],
];
export const PACKS = [
	['black', 0x171513],
	['blue', 0x27438e], ['red', 0x8d2c27], ['grey', 0x7d7873], ['green', 0x33703a], ['yellow', 0xa08a2a],
];
export const LEDS = [
	['white', 0xece7dd], ['red', 0xff4a3c], ['green', 0x5cff6a], ['blue', 0x4a7cff],
	['cyan', 0x4de6ff], ['purple', 0xb56cff], ['orange', 0xffa03c],
];

// La probabilité qu'une pièce soit VIVE plutôt que discrète, par famille. Un
// pilote de course met des hélices néon pour retrouver sa machine dans une
// bousculade ; un long range fumé se fait oublier ; un heavy porte du noir.
export const LOUD = {
	race5:      { prop: 0.85, bell: 0.55, tpu: 0.70, pack: 0.45 },
	freestyle5: { prop: 0.65, bell: 0.40, tpu: 0.60, pack: 0.40 },
	toothpick:  { prop: 0.70, bell: 0.30, tpu: 0.65, pack: 0.30 },
	cinewhoop:  { prop: 0.45, bell: 0.25, tpu: 0.55, pack: 0.35 },
	heavy5:     { prop: 0.30, bell: 0.20, tpu: 0.35, pack: 0.30 },
	longrange:  { prop: 0.25, bell: 0.15, tpu: 0.30, pack: 0.30 },
};
const DEFAULT_LOUD = LOUD.freestyle5;

// Les entrées discrètes sont en tête de chaque table : `quiet` dit combien.
const QUIET = { prop: 3, bell: 2, tpu: 1, pack: 1 };

// Le pas du tissage carbone, en mètres : un sergé de 2 mm en général, plus
// serré ou plus lâche selon le tissu.
export const WEAVE_M = [0.0016, 0.0026];

function pick(rand, table, quiet, loud) {
	const vivid = rand() < loud;
	const from = vivid ? quiet : 0;
	const to = vivid ? table.length : quiet;
	const [name, hex] = table[from + Math.floor(rand() * (to - from))];
	return { name, hex };
}

// `rand` est un flux de graine déjà ouvert (targetBuild lui en réserve un).
// L'ORDRE des tirages est le contrat : le changer change toutes les livrées
// déjà vues.
export function liveryOf(rand, family) {
	const loud = LOUD[family] ?? DEFAULT_LOUD;
	const prop = pick(rand, PROPS, QUIET.prop, loud.prop);
	const bell = pick(rand, BELLS, QUIET.bell, loud.bell);
	const tpu = pick(rand, TPU, QUIET.tpu, loud.tpu);
	const pack = pick(rand, PACKS, QUIET.pack, loud.pack);
	const led = LEDS[Math.floor(rand() * LEDS.length)];
	const weave = WEAVE_M[0] + rand() * (WEAVE_M[1] - WEAVE_M[0]);
	return { prop, bell, tpu, pack, led: { name: led[0], hex: led[1] }, weave };
}

// Ce que src/drone-mesh.js consomme : des hex par RÔLE de couleur, et le pas
// du tissage. Une livrée absente (profil nominal, chemins dev) rend un objet
// vide, et le maillage garde ses gris.
export function liveryColors(livery) {
	if (!livery) return {};
	return {
		prop: livery.prop.hex, bell: livery.bell.hex, tpu: livery.tpu.hex,
		battery: livery.pack.hex, led: livery.led.hex, weave: livery.weave,
	};
}

// Une ligne de fiche : « PROPS NEON GREEN · BELLS GOLD · TPU ORANGE ».
export function liveryLabel(livery) {
	if (!livery) return '';
	return `PROPS ${livery.prop.name} · BELLS ${livery.bell.name} · TPU ${livery.tpu.name}`.toUpperCase();
}
