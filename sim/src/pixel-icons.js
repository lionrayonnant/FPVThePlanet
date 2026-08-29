// Bibliothèque pixel art (PHASE 20, Bible §41). 9 icônes 12x12, monochromes :
// la couleur vient du contexte (currentColor), jamais de l'icône. Pas d'emoji,
// pas de Material Design. Module pur, Node-safe — sert aussi à générer le
// favicon (voir faviconDataURI, collé en dur dans index.html).
import { token } from './palette.js';

export const PIXEL_ICONS = {
	drone: [
		'##........##',
		'#.#......#.#',
		'.#.#....#.#.',
		'...#.##.#...',
		'....####....',
		'...######...',
		'...######...',
		'....####....',
		'...#.##.#...',
		'.#.#....#.#.',
		'#.#......#.#',
		'##........##',
	],
	radio: [
		'.#..........',
		'.#..........',
		'.#..........',
		'.########...',
		'.#......#...',
		'.#.####.#...',
		'.#.#..#.#...',
		'.#.####.#...',
		'.#......#...',
		'.#.#.#.##...',
		'.#......#...',
		'.########...',
	],
	antenna: [
		'..#..#..#...',
		'.#...#...#..',
		'.#..###..#..',
		'.#.#.#.#.#..',
		'....###.....',
		'.....#......',
		'.....#......',
		'.....#......',
		'.....#......',
		'....###.....',
		'...#.#.#....',
		'..#######...',
	],
	battery: [
		'....####....',
		'..########..',
		'..#......#..',
		'..#...#..#..',
		'..#..##..#..',
		'..#.####.#..',
		'..#..##..#..',
		'..#..#...#..',
		'..#.#....#..',
		'..#......#..',
		'..########..',
		'............',
	],
	camera: [
		'............',
		'..###.......',
		'..###.......',
		'.##########.',
		'.#........#.',
		'.#..####..#.',
		'.#.#....#.#.',
		'.#.#....#.#.',
		'.#..####..#.',
		'.#........#.',
		'.##########.',
		'............',
	],
	gps: [
		'....####....',
		'..##....##..',
		'.#........#.',
		'.#...##...#.',
		'.#..####..#.',
		'.#...##...#.',
		'..#......#..',
		'..##....##..',
		'...#....#...',
		'....#..#....',
		'.....##.....',
		'.....##.....',
	],
	map: [
		'............',
		'.##########.',
		'.#..#....##.',
		'.#..#...#.#.',
		'.#...#..#.#.',
		'.#...#.#..#.',
		'.#..#..#..#.',
		'.#..#...#.#.',
		'.#.#....#.#.',
		'.#.#...#..#.',
		'.##########.',
		'............',
	],
	link: [
		'............',
		'.#........#.',
		'.##......##.',
		'.#.#....#.#.',
		'.#..#..#..#.',
		'.#...##...#.',
		'.#........#.',
		'.#........#.',
		'.#........#.',
		'###......###',
		'............',
		'............',
	],
	terrain: [
		'............',
		'.....#......',
		'....###.....',
		'...##.##....',
		'..##...##...',
		'.##..#..##..',
		'.#..###...#.',
		'.#.##.##..#.',
		'.#.#...#..#.',
		'.##.....###.',
		'############',
		'............',
	],
};

export const ICON_NAMES = Object.keys(PIXEL_ICONS);

// SVG inline : un rect par pixel, crispEdges pour rester net à toute taille.
export function iconSVG(name, { color = 'currentColor', size = 12, background = null } = {}) {
	const rows = PIXEL_ICONS[name];
	if (!rows) throw new Error(`icône pixel inconnue : ${name}`);
	const n = rows.length;
	let rects = background ? `<rect width="${n}" height="${n}" fill="${background}"/>` : '';
	rows.forEach((row, y) => {
		for (let x = 0; x < n; x++) {
			if (row[x] === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
		}
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" fill="${color}">${rects}</svg>`;
}

// Favicon : drone blanc cassé sur fond sombre (palette de base, Bible §38).
// Un data URI est un document isolé : il ne voit pas les `var(--…)` de la page,
// il faut donc lui passer des couleurs résolues. Elles viennent quand même des
// tokens plutôt que d'être recopiées — avant la PHASE 19 c'était deux gris de
// plus, hors palette.
export function faviconDataURI() {
	return `data:image/svg+xml,${encodeURIComponent(iconSVG('drone', {
		color: token('--warm-white'), size: 16, background: token('--dark-grey'),
	}))}`;
}
