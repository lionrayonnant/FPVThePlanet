// PHASE 12 — le layout de l'OSD drone. Logique pure, AUCUNE dépendance.
//
// L'OSD appartient à la cible : il varie énormément d'une machine à l'autre,
// il peut être riche ou quasiment vide, et il est posé sur une grille de
// caractères comme un vrai OSD — pas sur des ancrages propres. C'est cette
// grille qui produit les dispositions franchement bancales du matériel réel.

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

// Le vocabulaire réel d'un OSD Betaflight / Walksnail. La largeur est en
// caractères, y compris l'unité et le pictogramme : c'est ce qui permet de
// garantir qu'aucun élément n'en recouvre un autre.
export const ELEMENT_WIDTH = {
	BAT_V: 6, CELL_V: 6, CURRENT: 6, MAH: 7,
	ALT: 6, ALT_HOME: 7, GS: 6, VS: 6, THR: 5,
	RSSI: 6, LQ: 5, TX_POWER: 6,
	SATS: 4, LATLON: 13, HOME_DIST: 7, HOME_ARROW: 2,
	TIMER_FLIGHT: 7, TIMER_ON: 7,
	HORIZON: 13, CROSSHAIR: 3, HEADING_TAPE: 13,
	WARNINGS: 12, CRAFT_NAME: 12, ESC_TEMP: 5, EFFICIENCY: 8, VTX_CHAN: 5,
	// Jauges graphiques : posées sur la grille comme le reste (une largeur en
	// caractères), mais dessinées comme HORIZON/CROSSHAIR plutôt qu'en texte.
	BATT_BAR: 8, THR_BAR: 8,
};
export const ELEMENTS = Object.keys(ELEMENT_WIDTH);

// Ce qui n'existe pas sans GPS. Une machine sans GPS ne les affiche pas —
// elle ne les affiche pas « à zéro », elle ne les a pas.
export const GPS_ELEMENTS = ['SATS', 'LATLON', 'HOME_DIST', 'HOME_ARROW', 'GS', 'EFFICIENCY'];
export const NO_GPS_FAMILIES = ['toothpick', 'race5'];

// Grilles de caractères réelles. En analogique la grille est petite, donc les
// caractères sont énormes et mangent l'image ; en HD ils sont fins et discrets.
// C'est, visuellement, la différence la plus brutale entre deux drones.
export const GRIDS = {
	ANALOG: [[30, 16], [30, 13]],   // NTSC, PAL
	DIGITAL: [[50, 18], [53, 20]],
};

export const FONTS = ['DEFAULT', 'BOLD', 'LARGE', 'CLARITY'];
export const DENSITY = { ANALOG: [3, 8], DIGITAL: [6, 14] };

// Le rendu de la grille de caractères. OUTLINE : blanc bordé de noir (le seul
// mode qu'un vrai MAX7456 sait faire). BOX : pavé sombre semi-opaque derrière
// chaque élément, sans bordure — Walksnail/HDZero. INVERT : texte sombre sur
// pavé clair, plus rare, plus dur à lire — c'est le but.
export const PANEL_MODES = ['OUTLINE', 'BOX', 'INVERT'];
const PANEL_ODDS = [0.55, 0.32, 0.13]; // cumulatif implicite, voir pickWeighted

// Teintes disponibles en numérique seulement : un MAX7456 analogique ne fait
// que du blanc/gris, un OSD HD sait colorer ses caractères.
export const DIGITAL_TINTS = ['#ffffff', '#ffb000', '#39ff14', '#00e5ff'];

// Dispositions nommées. DEFAULT_BF imite le comportement d'origine (haut/bas,
// un peu de milieu). Les autres sont volontairement reconnaissables : c'est
// ce qui fait qu'un joueur apprend à identifier une machine à son OSD plutôt
// que de voir « du texte en vrac » à chaque vol.
export const ARCHETYPES = ['DEFAULT_BF', 'CORNERS', 'TOP_BAR', 'BOTTOM_HEAVY', 'LEFT_COLUMN', 'MINIMAL'];

// Micrologiciels. Le contenu affiché ne change pas de sens, mais le
// vocabulaire et surtout ce qui est seulement disponible en changent
// vraiment — comme sur du matériel réel.
export const FIRMWARES = ['BETAFLIGHT', 'INAV', 'DJI_NATIVE', 'GENERIC_CN'];

// Le natif DJI est le plus austère du lot : un sous-ensemble curaté, jamais
// le vocabulaire complet d'un Betaflight. C'est une caractéristique du
// firmware, pas un tirage malchanceux — mais il reste assez large pour
// atteindre le plancher de densité du style (voir `sparse` plus bas).
const DJI_NATIVE_POOL = [
	'BAT_V', 'TIMER_FLIGHT', 'TIMER_ON', 'RSSI', 'CRAFT_NAME', 'THR_BAR',
	'MAH', 'VTX_CHAN', 'ALT',
];

// Toujours présents : un OSD sans tension ni temps n'existe pas sur du vrai
// matériel. Le chronomètre est l'un des deux, jamais les deux.
const TIMERS = ['TIMER_FLIGHT', 'TIMER_ON'];

// Noms de machine. Volontairement quelconques : ce sont des drones de gens,
// pas des vaisseaux.
const CRAFT_NAMES = [
	'HUMMEL', 'FOXEER', 'APEX5', 'NAZGUL', 'KREMOWKA', 'SPARROW',
	'TBS-ETX', 'MOJITO', 'BABYTOOTH', 'VANOVER', 'GEP-MK5', 'CADX',
];

const IMPERIAL_ODDS = 0.25;
const CRAFT_NAME_ODDS = 0.40;

// Pannes plausibles d'un vrai OSD, une par vol au plus. `NONE` domine très
// largement : ce sont des accidents de matériel, pas la norme.
//   NONE       — rien, l'écrasante majorité des vols.
//   NO_OSD     — la cible n'a pas d'OSD, ou le sien est éteint/HS.
//   FROZEN     — un capteur mort : un élément reste bloqué sur sa première
//                valeur pour tout le vol (si c'est le chronomètre, il ne
//                repart jamais à zéro — même symptôme, même cause).
//   GLITCH     — une ROM de police morte : un élément s'affiche en blocs.
//   OFFSET     — l'incrustation vidéo est mal calée et déborde du cadre.
export const PATHOLOGIES = ['NONE', 'NO_OSD', 'FROZEN', 'GLITCH', 'OFFSET'];
const PATHOLOGY_ODDS = [0.75, 0.05, 0.06, 0.06, 0.08];

function pickWeighted(list, odds, rand) {
	const r = rand();
	let acc = 0;
	for (let i = 0; i < list.length; i++) {
		acc += odds[i];
		if (r < acc) return list[i];
	}
	return list[list.length - 1];
}

// Lignes plausibles pour poser un élément : les OSD réels se serrent en haut
// et en bas et laissent le centre à l'image — mais pas toujours, et c'est le
// « pas toujours » qui fait la variété.
function candidateRows(rows, rand) {
	const band = rand();
	if (band < 0.45) return Math.floor(rand() * 3);                       // haut
	if (band < 0.90) return rows - 1 - Math.floor(rand() * 3);            // bas
	return 3 + Math.floor(rand() * Math.max(1, rows - 6));                // milieu
}

// Un placeur par archétype : où une ligne a le droit de tomber, et si la
// colonne est elle-même contrainte (les dispositions "en colonne" ou "en
// coins" ne laissent pas la colonne libre comme DEFAULT_BF le fait).
const ROW_PICKERS = {
	DEFAULT_BF: (rows, rand) => candidateRows(rows, rand),
	CORNERS: (rows, rand) => (rand() < 0.5
		? Math.floor(rand() * Math.max(1, Math.min(3, rows)))
		: rows - 1 - Math.floor(rand() * Math.max(1, Math.min(3, rows)))),
	TOP_BAR: (rows, rand) => Math.floor(rand() * Math.max(1, Math.min(2, rows))),
	BOTTOM_HEAVY: (rows, rand) => (rand() < 0.8
		? rows - 1 - Math.floor(rand() * Math.max(1, Math.ceil(rows / 3)))
		: Math.floor(rand() * rows)),
	LEFT_COLUMN: (rows, rand) => Math.floor(rand() * rows),
	MINIMAL: (rows, rand) => candidateRows(rows, rand),
};

const COL_PICKERS = {
	DEFAULT_BF: (cols, w, rand) => Math.floor(rand() * (cols - w + 1)),
	CORNERS: (cols, w, rand) => {
		const third = Math.max(w, Math.floor(cols / 3));
		return rand() < 0.5
			? Math.floor(rand() * Math.max(1, third - w + 1))
			: cols - w - Math.floor(rand() * Math.max(1, third - w + 1));
	},
	TOP_BAR: (cols, w, rand) => Math.floor(rand() * (cols - w + 1)),
	BOTTOM_HEAVY: (cols, w, rand) => Math.floor(rand() * (cols - w + 1)),
	// Une colonne serrée à gauche : c'est la disposition "liste empilée" qu'on
	// voit sur certains OSD longue-portée.
	LEFT_COLUMN: (cols, w, rand) => Math.floor(rand() * Math.max(1, Math.min(cols - w + 1, Math.ceil(cols / 2) - w + 1 || 1))),
	MINIMAL: (cols, w, rand) => Math.floor(rand() * (cols - w + 1)),
};

export function droneOsdLayout({ seed, family, mode } = {}) {
	const style = mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';
	const rand = rngFrom(`${seed}::osd::${family}::${style}`);

	// La panne se tire en tout premier : elle décide si le reste du tirage a
	// même un sens (NO_OSD s'arrête là, comme un vrai OSD éteint).
	let pathology = pickWeighted(PATHOLOGIES, PATHOLOGY_ODDS, rand);
	if (pathology === 'NO_OSD') return null;

	const gridPair = GRIDS[style][Math.floor(rand() * GRIDS[style].length)];
	const grid = { cols: gridPair[0], rows: gridPair[1] };
	const font = FONTS[Math.floor(rand() * FONTS.length)];
	const units = rand() < IMPERIAL_ODDS ? 'IMPERIAL' : 'METRIC';
	let panel = pickWeighted(PANEL_MODES, PANEL_ODDS, rand);
	let tint = style === 'DIGITAL' ? DIGITAL_TINTS[Math.floor(rand() * DIGITAL_TINTS.length)] : '#ffffff';
	const archetype = ARCHETYPES[Math.floor(rand() * ARCHETYPES.length)];
	const firmware = FIRMWARES[Math.floor(rand() * FIRMWARES.length)];
	// Le "generic-cn" est la blague du bas de gamme : sa ROM de police est plus
	// souvent morte que celle des autres. Un biais, pas une garantie.
	if (pathology === 'NONE' && firmware === 'GENERIC_CN' && rand() < 0.15) pathology = 'GLITCH';
	// Les goggles DJI natives imposent leur propre habillage : pavé sombre,
	// blanc pur — ce n'est pas configurable sur ce firmware.
	if (firmware === 'DJI_NATIVE') { panel = 'BOX'; tint = '#ffffff'; }

	const hasGps = !NO_GPS_FAMILIES.includes(family);
	const craftName = rand() < CRAFT_NAME_ODDS
		? CRAFT_NAMES[Math.floor(rand() * CRAFT_NAMES.length)]
		: null;

	// Le tirage des éléments : les indispensables d'abord, puis on pioche dans
	// ce qui reste jusqu'à la densité voulue. MINIMAL et DJI_NATIVE visent
	// délibérément le plancher — ce sont des OSD austères par construction, pas
	// par malchance du tirage.
	const [lo, hi] = DENSITY[style];
	const sparse = archetype === 'MINIMAL' || firmware === 'DJI_NATIVE';
	const wanted = sparse ? lo : lo + Math.floor(rand() * (hi - lo + 1));

	// BAT_V et WARNINGS sont les deux indispensables. WARNINGS l'est devenu
	// (issue #151) : R_CAUTION vaut R_HOLD PLUS 1,5 s « pour lire
	// l'avertissement », et c'est toute sa raison d'être. Or l'élément était
	// tiré comme les autres — mesuré sur 2 000 graines de session, il ne
	// sortait que dans 7,5 % des habillages. Le seuil était donc calibré sur le
	// temps de lecture d'un texte absent de plus de neuf vols sur dix, et le
	// trou valait déjà pour LOW VOLTAGE et RXLOSS, qui passent par le même
	// élément.
	//
	// Ce n'est pas une entorse au réalisme : sur un Betaflight réel l'élément
	// d'avertissements est actif par défaut, et c'est précisément celui qu'on
	// ne désactive pas. Il reste absent des OSD tirés NO_OSD, exactement comme
	// BAT_V — un OSD éteint n'affiche rien, et c'est lisible comme tel.
	const picked = ['BAT_V', 'WARNINGS', TIMERS[Math.floor(rand() * TIMERS.length)]];
	if (craftName) picked.push('CRAFT_NAME');

	const allowed = firmware === 'DJI_NATIVE' ? new Set(DJI_NATIVE_POOL) : null;
	const pool = ELEMENTS.filter((k) => {
		if (picked.includes(k)) return false;
		if (k === 'CRAFT_NAME') return false;        // décidé au-dessus
		if (TIMERS.includes(k)) return false;        // un seul chronomètre
		if (!hasGps && GPS_ELEMENTS.includes(k)) return false;
		if (allowed && !allowed.has(k)) return false;
		return true;
	});
	// Mélange de Fisher-Yates avec le même rand : déterministe.
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	while (picked.length < wanted && pool.length > 0) picked.push(pool.pop());

	// Placement : on tente, et on renonce si ça ne rentre pas. Un OSD réel n'a
	// pas plus de garantie que ça — ce qui ne rentre pas n'est pas affiché.
	const rowPicker = ROW_PICKERS[archetype] ?? ROW_PICKERS.DEFAULT_BF;
	const colPicker = COL_PICKERS[archetype] ?? COL_PICKERS.DEFAULT_BF;
	const occupied = new Map();
	const elements = [];
	for (const key of picked) {
		const w = ELEMENT_WIDTH[key];
		if (w > grid.cols) continue;
		for (let attempt = 0; attempt < 12; attempt++) {
			const row = rowPicker(grid.rows, rand);
			const col = colPicker(grid.cols, w, rand);
			const spans = occupied.get(row) ?? [];
			if (spans.some(([c0, c1]) => col < c1 && c0 < col + w)) continue;
			spans.push([col, col + w]);
			occupied.set(row, spans);
			elements.push({ key, col, row });
			break;
		}
	}

	// Les pannes qui restent portent sur UN élément parmi ceux effectivement
	// posés — un HORIZON/CROSSHAIR/BATT_BAR/THR_BAR graphique n'a pas de
	// "valeur figée" ou de "glyphe manquant" qui ait un sens, donc on ne les
	// tire que parmi le texte.
	const textKeys = elements.map((e) => e.key).filter((k) => !['HORIZON', 'CROSSHAIR', 'BATT_BAR', 'THR_BAR'].includes(k));
	let frozenKey = null, glitchKey = null, offsetCols = 0, offsetRows = 0;
	if (pathology === 'FROZEN' && textKeys.length > 0) {
		frozenKey = textKeys[Math.floor(rand() * textKeys.length)];
	} else if (pathology === 'GLITCH' && textKeys.length > 0) {
		glitchKey = textKeys[Math.floor(rand() * textKeys.length)];
	} else if (pathology === 'OFFSET') {
		// Assez pour qu'une rangée entière sorte du cadre, pas assez pour que
		// tout disparaisse — comme un vrai décalage d'incrustation mal réglé.
		offsetCols = (Math.floor(rand() * 5) - 2);
		offsetRows = (Math.floor(rand() * 5) - 2);
	}

	return {
		style, grid, font, units, craftName, elements,
		panel, tint, archetype, firmware,
		pathology, frozenKey, glitchKey, offsetCols, offsetRows,
	};
}
