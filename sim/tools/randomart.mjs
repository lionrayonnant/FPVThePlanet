// Randomart du fou ivre, déterministe sur une graine.
//
// Même algorithme que `ssh-keygen -lv` (RFC-rien, mais folklore stable) : un
// fou ivre part du centre d'un plateau 17×9, chaque paire de bits de la graine
// le pousse en diagonale, on compte les passages, on rend la carte de densité.
//
// Depuis l'issue #57 : la graine est le `buildSeed` d'un EXEMPLAIRE, pas un id
// de session. Une cible = une empreinte, la même à chaque fois qu'on la
// retrouve.
//
// Le module est une FEUILLE, sans aucune importation : c'est ce qui lui permet
// d'être appelé par le serveur (tools/session-model.mjs) comme par le client
// bundlé par Vite (src/hack.js, src/fpvtp-osd.js, tools/session-log-model.mjs,
// qui s'interdit tout `node:`). C'est aussi pourquoi `node:crypto` a disparu.

const WIDTH = 17;
const HEIGHT = 9;
const DIGEST_BYTES = 32;   // autant que le SHA-256 qu'on remplace : 128 pas
const STEPS_PER_BYTE = 4;  // 4 pas par octet, 2 bits chacun
// ' ' vide, puis densité croissante ; 'S' départ, 'E' arrivée (posés en dernier).
const SYMBOLS = [' ', '.', 'o', '+', '=', '*', 'B', 'O', 'X', '@', '%', '&', '#', '/', '^'];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift. Recopié plutôt
// qu'importé, exactement comme tools/target-camera.mjs, tools/target-model.mjs
// et src/link.js le font déjà de tools/target-build.mjs : l'importer traînerait
// PROFILES et drone-profiles.js dans le chemin du serveur pour six lignes, et
// coûterait à ce module la seule propriété qui compte ici — n'avoir aucune
// dépendance.
function rngFrom(seed) {
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

// 32 octets tirés du flux, un par appel. Remplace le digest SHA-256 : la sortie
// n'a aucune propriété cryptographique et n'en a jamais eu besoin — ce qu'on
// demande à ces octets, c'est d'être stables et bien répartis.
function digest(seed) {
	const rand = rngFrom(`${seed}::randomart`);
	const out = new Uint8Array(DIGEST_BYTES);
	for (let i = 0; i < DIGEST_BYTES; i++) out[i] = (rand() * 256) & 0xff;
	return out;
}

// La marche, séparée du rendu (issue #57) : c'est ce qui permet d'ANIMER le
// tracé sans écrire une seconde implémentation. `steps[i]` est l'index de case
// visité au pas `i`.
export function randomartWalk(seed) {
	const bytes = digest(seed);
	const steps = new Int16Array(bytes.length * STEPS_PER_BYTE);
	let x = (WIDTH - 1) >> 1;
	let y = (HEIGHT - 1) >> 1;
	const start = y * WIDTH + x;
	let k = 0;
	for (const byte of bytes) {
		// 4 pas par octet, bit de poids faible d'abord.
		for (let s = 0; s < 8; s += 2) {
			const move = (byte >> s) & 3;
			x += (move & 1) ? 1 : -1;
			y += (move & 2) ? 1 : -1;
			if (x < 0) x = 0; else if (x >= WIDTH) x = WIDTH - 1;
			if (y < 0) y = 0; else if (y >= HEIGHT) y = HEIGHT - 1;
			steps[k++] = y * WIDTH + x;
		}
	}
	return { steps, start, end: steps[steps.length - 1], width: WIDTH, height: HEIGHT };
}

// L'image après `n` pas. `E` est posé sur la case du DERNIER pas joué, pas sur
// l'arrivée : pendant la marche, le fou est donc son propre curseur, sans une
// ligne de plus. À n = steps.length, les deux coïncident et l'image est celle
// que rend randomart().
export function randomartFrame(walk, n, { title = 'FPV 06', tag = '' } = {}) {
	const played = Math.max(0, Math.min(Math.round(n), walk.steps.length));
	const counts = new Int16Array(WIDTH * HEIGHT);
	for (let i = 0; i < played; i++) {
		const j = walk.steps[i];
		if (counts[j] < SYMBOLS.length - 1) counts[j]++;
	}
	const end = played === 0 ? walk.start : walk.steps[played - 1];

	const rows = [];
	for (let row = 0; row < HEIGHT; row++) {
		let line = '';
		for (let col = 0; col < WIDTH; col++) {
			const i = row * WIDTH + col;
			line += i === walk.start ? 'S' : i === end ? 'E' : SYMBOLS[counts[i]];
		}
		rows.push(`|${line}|`);
	}

	const t4 = String(tag).slice(-4);
	return [border(title), ...rows, border(t4)].join('\n');
}

export function randomart(seed, opts = {}) {
	const walk = randomartWalk(seed);
	return randomartFrame(walk, walk.steps.length, opts);
}

// `+--[ FPV 06 ]---+` centré sur WIDTH colonnes intérieures.
function border(label) {
	const inner = WIDTH;
	if (!label) return `+${'-'.repeat(inner)}+`;
	const text = `[${label}]`;
	if (text.length >= inner) return `+${text.slice(0, inner)}+`;
	const left = (inner - text.length) >> 1;
	const right = inner - text.length - left;
	return `+${'-'.repeat(left)}${text}${'-'.repeat(right)}+`;
}

export const RANDOMART_DIMS = { WIDTH, HEIGHT, LINES: HEIGHT + 2 };
