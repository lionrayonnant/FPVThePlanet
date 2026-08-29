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

// Lignes plausibles pour poser un élément : les OSD réels se serrent en haut
// et en bas et laissent le centre à l'image — mais pas toujours, et c'est le
// « pas toujours » qui fait la variété.
function candidateRows(rows, rand) {
	const band = rand();
	if (band < 0.45) return Math.floor(rand() * 3);                       // haut
	if (band < 0.90) return rows - 1 - Math.floor(rand() * 3);            // bas
	return 3 + Math.floor(rand() * Math.max(1, rows - 6));                // milieu
}

export function droneOsdLayout({ seed, family, mode } = {}) {
	const style = mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';
	const rand = rngFrom(`${seed}::osd::${family}::${style}`);

	const gridPair = GRIDS[style][Math.floor(rand() * GRIDS[style].length)];
	const grid = { cols: gridPair[0], rows: gridPair[1] };
	const font = FONTS[Math.floor(rand() * FONTS.length)];
	const units = rand() < IMPERIAL_ODDS ? 'IMPERIAL' : 'METRIC';

	const hasGps = !NO_GPS_FAMILIES.includes(family);
	const craftName = rand() < CRAFT_NAME_ODDS
		? CRAFT_NAMES[Math.floor(rand() * CRAFT_NAMES.length)]
		: null;

	// Le tirage des éléments : les indispensables d'abord, puis on pioche dans
	// ce qui reste jusqu'à la densité voulue.
	const [lo, hi] = DENSITY[style];
	const wanted = lo + Math.floor(rand() * (hi - lo + 1));

	const picked = ['BAT_V', TIMERS[Math.floor(rand() * TIMERS.length)]];
	if (craftName) picked.push('CRAFT_NAME');

	const pool = ELEMENTS.filter((k) => {
		if (picked.includes(k)) return false;
		if (k === 'CRAFT_NAME') return false;        // décidé au-dessus
		if (TIMERS.includes(k)) return false;        // un seul chronomètre
		if (!hasGps && GPS_ELEMENTS.includes(k)) return false;
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
	const occupied = new Map();
	const elements = [];
	for (const key of picked) {
		const w = ELEMENT_WIDTH[key];
		if (w > grid.cols) continue;
		for (let attempt = 0; attempt < 12; attempt++) {
			const row = candidateRows(grid.rows, rand);
			const col = Math.floor(rand() * (grid.cols - w + 1));
			const spans = occupied.get(row) ?? [];
			if (spans.some(([c0, c1]) => col < c1 && c0 < col + w)) continue;
			spans.push([col, col + w]);
			occupied.set(row, spans);
			elements.push({ key, col, row });
			break;
		}
	}

	return { style, grid, font, units, craftName, elements };
}
