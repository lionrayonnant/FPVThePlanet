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
// Le boîtier de la GoPro : noir d'origine, en TPU coloré, ou blanc.
export const GOPRO = [['black', 0x1a1917], ['tpu', null], ['white', 0xd8d3c9]];
export const LEDS = [
	['white', 0xece7dd], ['red', 0xff4a3c], ['green', 0x5cff6a], ['blue', 0x4a7cff],
	['cyan', 0x4de6ff], ['purple', 0xb56cff], ['orange', 0xffa03c],
];

// La probabilité qu'une pièce soit VIVE plutôt que discrète, par famille. Un
// pilote de course met des hélices néon pour retrouver sa machine dans une
// bousculade ; un long range fumé se fait oublier ; un heavy porte du noir.
// `tip` : la probabilité d'hélices bicolores (bout d'une autre couleur).
export const LOUD = {
	race5:      { prop: 0.85, bell: 0.55, tpu: 0.70, pack: 0.45, tip: 0.25 },
	freestyle5: { prop: 0.65, bell: 0.40, tpu: 0.60, pack: 0.40, tip: 0.22 },
	toothpick:  { prop: 0.70, bell: 0.30, tpu: 0.65, pack: 0.30, tip: 0.20 },
	cinewhoop:  { prop: 0.45, bell: 0.25, tpu: 0.55, pack: 0.35, tip: 0.10 },
	heavy5:     { prop: 0.30, bell: 0.20, tpu: 0.35, pack: 0.30, tip: 0.08 },
	longrange:  { prop: 0.25, bell: 0.15, tpu: 0.30, pack: 0.30, tip: 0.05 },
};

// Un build n'est pas un tirage de confettis (issue #284, deuxième passe,
// regardé sur 24 générations) : quelqu'un l'a monté, et quand il a acheté du
// TPU orange c'est parce que ses hélices l'étaient. Une part des livrées est
// donc ASSORTIE — le TPU, la cloche, la LED reprennent la teinte des hélices
// quand la table d'en face la connaît. Le reste reste libre : les machines
// dépareillées existent aussi.
export const MATCH = { tpu: 0.55, bell: 0.35, led: 0.45, strap: 0.60 };
export const OWNER = { number: 0.55, tape: 0.45 };
const BELL_OF = { red: 'red', purple: 'purple', blue: 'blue', yellow: 'gold', cyan: 'teal', pink: 'purple' };
const LED_OF = { red: 'red', 'neon green': 'green', blue: 'blue', cyan: 'cyan', purple: 'purple', orange: 'orange', pink: 'purple', yellow: 'orange' };
const byName = (table, name) => { const e = table.find(([n]) => n === name); return e ? { name: e[0], hex: e[1] } : null; };
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
const isVivid = (prop) => PROPS.findIndex(([n]) => n === prop.name) >= QUIET.prop;

// `rand` est un flux de graine déjà ouvert (targetBuild lui en réserve un).
// L'ORDRE des tirages est le contrat : le changer change toutes les livrées
// déjà vues. Chaque décision consomme ses tirages même quand elle ne s'en
// sert pas, pour que les suivantes ne bougent pas avec elle.
export function liveryOf(rand, family) {
	const loud = LOUD[family] ?? DEFAULT_LOUD;
	const prop = pick(rand, PROPS, QUIET.prop, loud.prop);
	const vivid = isVivid(prop);

	// Le TPU, la cloche : assortis aux hélices, ou tirés à part.
	const matchTpu = rand() < MATCH.tpu, freeTpu = pick(rand, TPU, QUIET.tpu, loud.tpu);
	const tpu = (vivid && matchTpu && byName(TPU, prop.name)) || freeTpu;
	const matchBell = rand() < MATCH.bell, freeBell = pick(rand, BELLS, QUIET.bell, loud.bell);
	const bell = (vivid && matchBell && BELL_OF[prop.name] && byName(BELLS, BELL_OF[prop.name])) || freeBell;

	const pack = pick(rand, PACKS, QUIET.pack, loud.pack);
	// La sangle du pack : celle du TPU le plus souvent (c'est la même
	// commande), sinon noire.
	const strap = rand() < MATCH.strap ? tpu : { name: 'black', hex: TPU[0][1] };

	const matchLed = rand() < MATCH.led, freeLed = LEDS[Math.floor(rand() * LEDS.length)];
	const led = (vivid && matchLed && LED_OF[prop.name] && byName(LEDS, LED_OF[prop.name])) || { name: freeLed[0], hex: freeLed[1] };

	// Hélices bicolores : le bout d'une autre couleur vive que le corps.
	const wantTip = rand() < loud.tip, tipDraw = rand();
	let tip = null;
	if (wantTip) {
		const vivids = PROPS.slice(QUIET.prop).filter(([n]) => n !== prop.name);
		const [n, h] = vivids[Math.floor(tipDraw * vivids.length)];
		tip = { name: n, hex: h };
	}

	const weave = WEAVE_M[0] + rand() * (WEAVE_M[1] - WEAVE_M[0]);

	// La GoPro : noire deux fois sur trois, sinon dans un boîtier TPU de la
	// couleur du montage, rarement blanche.
	const g = rand();
	const gopro = g < 0.62 ? { name: 'black', hex: GOPRO[0][1] } : g < 0.88 ? { name: 'tpu', hex: tpu.hex } : { name: 'white', hex: GOPRO[2][1] };

	// Ce que le PROPRIÉTAIRE a ajouté (issue #285) : un numéro de course sur le
	// pack, du ruban de couleur au bout des bras. Pas tout le monde — un
	// numéro se mérite en course, le ruban est une manie de pilote de freestyle.
	const number = rand() < OWNER.number ? 1 + Math.floor(rand() * 999) : (rand(), null);
	const tape = rand() < OWNER.tape;
	return { prop, tip, bell, tpu, pack, strap, led, weave, gopro, owner: { number, tape } };
}

// Ce que src/drone-mesh.js consomme : des hex par RÔLE de couleur, et le pas
// du tissage. Une livrée absente (profil nominal, chemins dev) rend un objet
// vide, et le maillage garde ses gris.
export function liveryColors(livery) {
	if (!livery) return {};
	return {
		prop: livery.prop.hex, tip: livery.tip?.hex ?? null, bell: livery.bell.hex, tpu: livery.tpu.hex,
		battery: livery.pack.hex, strap: livery.strap?.hex ?? livery.tpu.hex, led: livery.led.hex,
		gopro: livery.gopro?.hex ?? null, tape: livery.tpu.hex,
		number: livery.owner?.number ?? null,
		weave: livery.weave,
		// L'usure vient du BUILD (targetBuild la pose sur la livrée), pas d'un
		// tirage de plus : un pack vieux et une machine qui traîne se voient.
		wear: livery.wear ?? 0,
	};
}

// Une ligne de fiche : « PROPS NEON GREEN · BELLS GOLD · TPU ORANGE ».
export function liveryLabel(livery) {
	if (!livery) return '';
	const props = livery.tip ? `${livery.prop.name}/${livery.tip.name}` : livery.prop.name;
	const num = livery.owner?.number ? `#${String(livery.owner.number).padStart(3, '0')} · ` : '';
	return `${num}PROPS ${props} · BELLS ${livery.bell.name} · TPU ${livery.tpu.name}`.toUpperCase();
}
