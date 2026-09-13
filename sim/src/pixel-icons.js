// Pixel-art library (PHASE 20, Bible §41). 12x12 monochrome icons: the colour
// comes from the context (currentColor), never from the icon. No emoji, no
// Material Design. Pure module, Node-safe. The favicon does not come from here
// any more: that is the game's mark, exported as PNG in public/ (#58).

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
	// `< >`. Chevrons rather than a branch or a fork glyph: at twelve pixels a
	// branch is three dots and a diagonal, which reads as noise, while chevrons
	// stay two clean strokes and mean "source" to anyone who has seen a code
	// editor. Deliberately not a vendor's mark — the icon points at the source,
	// wherever that source is hosted.
	source: [
		'............',
		'............',
		'...#....#...',
		'..#......#..',
		'.#........#.',
		'#..........#',
		'#..........#',
		'.#........#.',
		'..#......#..',
		'...#....#...',
		'............',
		'............',
	],
	// The GitHub mark, which is where the source link goes. A vendor's logo is
	// normally the wrong answer at twelve pixels — but this one destination is a
	// platform, and its silhouette survives the grid where "a branch glyph" does
	// not: two ears, a body, one tail. A filled silhouette lights more pixels
	// than a line glyph, which is why the density check allows for it.
	github: [
		'..##....##..',
		'.####..####.',
		'.##########.',
		'############',
		'###..##..###',
		'############',
		'############',
		'.##########.',
		'..########..',
		'..###..###..',
		'..##....##..',
		'...#....#...',
	],
	// Bitcoin: the B with its two stems, and no coin around it. The disc is what
	// turns to mud first at this size — the letterform alone is what people
	// actually recognise, and it stays two clean strokes wide.
	bitcoin: [
		'...#..#.....',
		'...#..#.....',
		'..#######...',
		'..##....##..',
		'..##....##..',
		'..#######...',
		'..##....##..',
		'..##.....##.',
		'..##.....##.',
		'..#######...',
		'...#..#.....',
		'...#..#.....',
	],
	// Monero: the ring and the M inside it, which is the whole mark. The middle
	// vertex drops below the shoulders the way the real glyph does; drawn as an
	// outline rather than a disc so the M has somewhere to live.
	monero: [
		'...######...',
		'.##......##.',
		'.#........#.',
		'#.##....##.#',
		'#.###..###.#',
		'#.#.####.#.#',
		'#.#..##..#.#',
		'#.#......#.#',
		'.#........#.',
		'.##......##.',
		'...######...',
		'............',
	],
	// Cake Wallet: a cake. The brand's own slice does not survive twelve pixels
	// — the tiers and the candle do, and they say "cake" without borrowing a
	// mark that would misrepresent it.
	cake: [
		'.....#......',
		'.....#......',
		'...######...',
		'.##########.',
		'############',
		'#.##.##.##.#',
		'.##########.',
		'.#........#.',
		'.#.######.#.',
		'.#........#.',
		'.##########.',
		'............',
	],
};

export const ICON_NAMES = Object.keys(PIXEL_ICONS);

// Inline SVG: one rect per pixel, crispEdges so it stays sharp at any size.
export function iconSVG(name, { color = 'currentColor', size = 12 } = {}) {
	const rows = PIXEL_ICONS[name];
	if (!rows) throw new Error(`unknown pixel icon: ${name}`);
	const n = rows.length;
	let rects = '';
	rows.forEach((row, y) => {
		for (let x = 0; x < n; x++) {
			if (row[x] === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
		}
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" fill="${color}">${rects}</svg>`;
}

// The same icon as a data: URI, for an <img src>.
//
// Inline SVG needs innerHTML, and the render selftests mount screens on a fake
// DOM that refuses it on purpose — building trees with createElement is what
// keeps a stored injection from ever having a door (see terminal.js). An
// attribute has no such problem, costs one node, and stays crisp.
export function iconDataUri(name, opts = {}) {
	return `data:image/svg+xml,${encodeURIComponent(iconSVG(name, opts))}`;
}
