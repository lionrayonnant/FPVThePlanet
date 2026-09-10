// La marque FPVTP!, en géométrie (#73). PUR : ni DOM, ni fetch, ni `node:` —
// importé tel quel par tools/brand-mark-selftest.mjs et, via le bundle Vite,
// par src/intro.js.
//
// POURQUOI CE FICHIER EXISTE. La source de la marque est
// `public/brand/fpvtp-mark.svg`, et docs/marque.md le dit sans ambiguïté :
// « recopier depuis ici, ne pas ré-exporter ». Le cracktro ne peut pourtant pas
// aller le chercher : c'est le tout premier écran, il se joue avant que quoi
// que ce soit d'autre soit chargé, et un fetch qui traîne ou qui échoue y
// coûterait la marque au moment précis où elle se pose. La géométrie est donc
// recopiée ici, dans le bundle, où rien ne peut échouer.
//
// Une copie dérive. C'est pour ça que brand-mark-selftest.mjs lit le SVG et
// exige qu'il corresponde rectangle pour rectangle : le SVG reste la source,
// ce fichier reste une copie, et la CI est ce qui les empêche de diverger.
// Modifier la marque, c'est modifier le SVG — ce fichier suit, le test le
// prouve.

// La grille de 100 unités porte 16 modules (docs/marque.md, « Géométrie »).
export const MODULE = 100 / 16;

// Le motif, écrit exactement comme docs/marque.md l'écrit : 5 × 5, 14 cellules
// pleines. Le selftest lit le document et compare — les deux ne peuvent pas
// décrire deux marques différentes.
export const PATTERN_ROWS = [
	'.#..#',
	'##.##',
	'.###.',
	'#.#..',
	'##..#',
];

// Pas, décalage et côté d'une cellule. Trois nombres, et le motif ci-dessus
// suffit alors à produire les 14 rectangles.
const CELL = 13;
const PITCH = 15.2;
const OFFSET = 12;

// La grille du SVG (pas de 15,2 sur 100 unités) ne tombe pas juste en binaire :
// 12 + 15,2 + 15,2 ne rend pas 42,4 exactement. On arrondit au dixième, ce qui
// est la précision à laquelle le SVG lui-même est écrit — sans ça la
// comparaison avec le fichier échouerait sur des chiffres invisibles.
const round1 = (v) => Math.round(v * 10) / 10;

// Le cadre interrompu, dans l'ordre où il se trace : le bord supérieur en deux
// morceaux (28 unités d'interruption centrée, où le titre s'inscrit), puis le
// bas, puis les deux côtés.
export const FRAME_RECTS = [
	{ x: 0, y: 0, w: 36, h: 6 },
	{ x: 64, y: 0, w: 36, h: 6 },
	{ x: 0, y: 94, w: 100, h: 6 },
	{ x: 0, y: 6, w: 6, h: 88 },
	{ x: 94, y: 6, w: 6, h: 88 },
];

// Les 14 cellules pleines, en ordre de lecture — c'est aussi l'ordre du tracé.
export const CELL_RECTS = PATTERN_ROWS.flatMap((row, r) =>
	row.split('').flatMap((c, i) => (c === '#'
		? [{ x: round1(OFFSET + i * PITCH), y: round1(OFFSET + r * PITCH), w: CELL, h: CELL }]
		: [])));

// Les 19 rectangles, dans l'ordre du tracé. Le cadre EST le panneau : il se
// pose avant ce qu'il contient, comme un écran qui s'ouvre avant d'écrire
// dedans. Le motif vient ensuite, en ordre de lecture.
export const MARK_RECTS = [...FRAME_RECTS, ...CELL_RECTS];

// Mise en scène, pas mesure : ces instants sont un choix, et ils se relisent
// d'un coup d'œil. Millisecondes depuis le début de la phase `reveal` de
// l'intro (tools/intro-model.mjs), dans laquelle tout doit tenir — une marque
// encore en train de se tracer quand la plasma démarre serait une marque prise
// dans les couleurs demo, ce que docs/marque.md interdit.
export const TRACE = {
	frameDoneMs: 320,   // le cadre est entier
	doneMs: 1100,       // les 14 cellules sont tombées
	nameAtMs: 1200,     // et le nom s'inscrit dessous
};

const FRAME_STEP = TRACE.frameDoneMs / FRAME_RECTS.length;
const CELL_STEP = (TRACE.doneMs - TRACE.frameDoneMs) / CELL_RECTS.length;

// Combien des 19 rectangles sont posés à `tMs`. Clampé aux deux bords : avant
// le départ rien n'est dessiné, après la fin tout l'est et le reste.
export function revealCount(tMs) {
	if (!(tMs > 0)) return 0;
	// Le epsilon rattrape le pas fractionnaire (780 / 14) : sans lui, l'instant
	// exact de la dernière cellule retomberait un cran en dessous.
	const eps = 1e-9;
	if (tMs < TRACE.frameDoneMs) {
		return Math.min(FRAME_RECTS.length, Math.floor(tMs / FRAME_STEP + eps));
	}
	const cells = Math.floor((tMs - TRACE.frameDoneMs) / CELL_STEP + eps);
	return Math.min(MARK_RECTS.length, FRAME_RECTS.length + cells);
}

// Le nom ne partage jamais son instant avec la marque : il s'inscrit une fois
// qu'elle est entière. Le verrouillage empilé se lit alors d'un coup, plutôt
// que de se composer sous les yeux.
export function nameVisibleAt(tMs) {
	return tMs >= TRACE.nameAtMs;
}
