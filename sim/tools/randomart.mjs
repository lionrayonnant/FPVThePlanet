// Drunken-bishop randomart, déterministe sur une graine.
//
// Même algorithme que `ssh-keygen -lv` (RFC-rien, mais folklore stable) : un
// fou ivre part du centre d'un plateau 17×9, chaque paire de bits de la graine
// le pousse en diagonale, on compte les passages, on rend la carte de densité.
//
// Utilisé avec `seed = session.id` : une session garde le même art à chaque
// reconnexion.
import { createHash } from 'node:crypto';

const WIDTH = 17;
const HEIGHT = 9;
// ' ' vide, puis densité croissante ; 'S' départ, 'E' arrivée (posés en dernier).
const SYMBOLS = [' ', '.', 'o', '+', '=', '*', 'B', 'O', 'X', '@', '%', '&', '#', '/', '^'];

export function randomart(seed, { title = 'FPV 06', tag = '' } = {}) {
	const digest = createHash('sha256').update(String(seed)).digest();

	const counts = new Int16Array(WIDTH * HEIGHT);
	let x = (WIDTH - 1) >> 1;
	let y = (HEIGHT - 1) >> 1;
	const start = y * WIDTH + x;

	for (const byte of digest) {
		// 4 pas par octet, bit de poids faible d'abord.
		for (let s = 0; s < 8; s += 2) {
			const move = (byte >> s) & 3;
			x += (move & 1) ? 1 : -1;
			y += (move & 2) ? 1 : -1;
			if (x < 0) x = 0; else if (x >= WIDTH) x = WIDTH - 1;
			if (y < 0) y = 0; else if (y >= HEIGHT) y = HEIGHT - 1;
			const i = y * WIDTH + x;
			if (counts[i] < SYMBOLS.length - 1) counts[i]++;
		}
	}
	const end = y * WIDTH + x;

	const rows = [];
	for (let row = 0; row < HEIGHT; row++) {
		let line = '';
		for (let col = 0; col < WIDTH; col++) {
			const i = row * WIDTH + col;
			line += i === start ? 'S' : i === end ? 'E' : SYMBOLS[counts[i]];
		}
		rows.push(`|${line}|`);
	}

	const t4 = String(tag).slice(-4);
	return [border(title), ...rows, border(t4)].join('\n');
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
