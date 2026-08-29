// Motifs visuels par famille de hacking (PHASE 09, Bible §17). Chaque motif
// identifie sa famille SANS que le joueur ait à lire son nom (critère
// d'acceptation). Purement décoratif : la seule donnée qui entre est un `seed`
// cosmétique et un temps `t` en secondes.
//
// Contrat d'un motif : draw(el: HTMLPreElement, { t: number, seed: number }).
// Écrit dans el.textContent. Pas d'état module — tout dérive de (t, seed).

const W = 44; // largeur du champ ASCII
const H = 12; // hauteur

const frame = (rows) => rows.map((r) => r.padEnd(W).slice(0, W)).join('\n');

// --- petits utilitaires de canevas ------------------------------------------

// Bruit déterministe : aucune source d'aléa réelle, tout dérive de (x, y, u, seed).
function noise(x, y, u, seed) {
	const v = Math.sin(x * 12.9898 + y * 78.233 + u * 0.7213 + seed * 137.51) * 43758.5453;
	return v - Math.floor(v);
}

const blank = () => Array.from({ length: H }, () => new Array(W).fill(' '));
const lines = (g) => g.map((r) => r.join(''));

function put(g, x, y, ch) {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi >= 0 && xi < W && yi >= 0 && yi < H) g[yi][xi] = ch;
}

function text(g, x, y, str) {
	for (let i = 0; i < str.length; i++) put(g, x + i, y, str[i]);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Relie deux échantillons voisins d'une courbe : sans ça une pente forte se lit
// comme une pluie de points isolés au lieu d'un tracé.
function stroke(g, x, ya, yb, head, link) {
	const a = Math.round(ya);
	const b = Math.round(yb);
	put(g, x, a, head);
	if (b === a) return;
	const s = b > a ? 1 : -1;
	for (let y = a + s; y !== b; y += s) put(g, x, y, link);
}

export function drawNeutral(el, { t }) {
	const rows = [];
	for (let y = 0; y < H; y++) {
		let row = '';
		for (let x = 0; x < W; x++) {
			row += ((x + y + Math.floor(t * 8)) % 7 === 0) ? '·' : ' ';
		}
		rows.push(row);
	}
	el.textContent = frame(rows);
}

// --- COMMAND INJECTION : paquets qui défilent de droite à gauche -------------

const PKT = '[####]';
const TRACK_SLOTS = 11; // piste périodique de 11 × 8 colonnes

// Piste périodique d'une ligne : des bursts de blocs séparés d'interstices.
function packetTrack(y, seed) {
	let s = '';
	for (let slot = 0; slot < TRACK_SLOTS; slot++) {
		const burst = noise(slot >> 2, y, 0, seed) > 0.35;
		const on = burst && noise(slot, y, 1, seed) > 0.25;
		s += on ? `${PKT}  ` : '        ';
	}
	return s;
}

function drawPackets(el, { t, seed }) {
	const g = blank();
	for (let y = 0; y < H; y += 2) { // une ligne sur deux : respiration
		const track = packetTrack(y, seed);
		const P = track.length;
		const speed = 9 + Math.floor(noise(0, y, 2, seed) * 16); // colonnes/s
		const off = Math.floor(t * speed);
		for (let x = 0; x < W; x++) {
			const c = track[(((x + off) % P) + P) % P];
			if (c !== ' ') g[y][x] = c;
		}
	}
	el.textContent = frame(lines(g));
}

// --- LINK HIJACK : porteuse sinusoïdale + marqueur qui se cale sur une crête -

function drawCarrier(el, { t, seed }) {
	const g = blank();
	const k = 0.30;      // rad/colonne
	const w = 1.6;       // rad/s
	const amp = 4.0;
	const mid = (H - 1) / 2;
	const carrier = (x) => mid - amp * Math.sin(x * k - t * w);

	for (let x = 0; x < W; x++) stroke(g, x, carrier(x), carrier(x + 1), '~', ':');

	// Marqueur : glisse 3 s de gauche à droite, puis se verrouille sur la crête
	// la plus proche du 2/3 de l'écran et la suit (« sync »).
	const ph = (t + seed * 4.5) % 4.5;
	let mx;
	if (ph < 3) {
		mx = Math.round((ph / 3) * (W - 1));
	} else {
		const target = W * 0.66;
		const n = Math.round((target * k - t * w - Math.PI / 2) / (2 * Math.PI));
		mx = Math.round((Math.PI / 2 + 2 * n * Math.PI + t * w) / k);
	}
	mx = clamp(mx, 0, W - 1);
	for (let y = 0; y < H; y++) g[y][mx] = (Math.round(carrier(mx)) === y) ? '#' : '|';
	el.textContent = frame(lines(g));
}

// --- TELEMETRY SPOOF : oscilloscope, avec un segment « injecté » -------------

const INJ_X0 = 15;
const INJ_X1 = 26;

function scopeBox(g) {
	for (let x = 1; x < W - 1; x++) { g[0][x] = '-'; g[H - 1][x] = '-'; }
	for (let y = 1; y < H - 1; y++) { g[y][0] = '|'; g[y][W - 1] = '|'; }
	for (const y of [0, H - 1]) { g[y][0] = '+'; g[y][W - 1] = '+'; }
	for (let y = 2; y < H - 1; y += 3) for (let x = 3; x < W - 1; x += 6) g[y][x] = '.';
}

function drawScope(el, { t, seed }) {
	const g = blank();
	scopeBox(g);
	const x0 = 1;
	const x1 = W - 2;
	const span = x1 - x0 + 1;
	const speed = 24; // colonnes/s
	const head = x0 + Math.floor((t * speed) % span);
	const sweep = Math.floor((t * speed) / span);
	const mid = (1 + (H - 2)) / 2;

	const sample = (x, n) => {
		const inj = x >= INJ_X0 && x <= INJ_X1;
		const ph = n * 1.7 + seed * 6.3;
		const a = inj ? 4.3 : 1.6;
		const base = inj
			? Math.sin(x * 0.34 + ph)
			: Math.sin(x * 0.55 + ph) * (0.7 + 0.5 * Math.sin(x * 0.17 + ph));
		return clamp(mid - a * base, 1, H - 2);
	};

	for (let x = x0; x <= x1; x++) {
		const n = x <= head ? sweep : sweep - 1;
		const inj = x >= INJ_X0 && x <= INJ_X1;
		const nx = x + 1 <= x1 ? x + 1 : x;
		stroke(g, x, sample(x, n), sample(nx, n), inj ? '#' : '*', inj ? '#' : '|');
	}
	for (let y = 1; y < H - 1; y++) g[y][head] = ':';
	el.textContent = frame(lines(g));
}

// --- GNSS SPOOF : réticule qui dérive, traînée pointillée, vecteurs ----------

const ARROWS = ['>', '\\', 'v', '/', '<', '/', '^', '\\'];

// Dérive quasi-périodique bornée autour de l'origine.
function driftAt(u, seed) {
	const s = seed * 6.28;
	return [
		22 + 12 * Math.sin(u * 0.19 + s) + 4 * Math.sin(u * 0.07 + s * 2),
		5.5 + 3.4 * Math.sin(u * 0.29 + s * 1.7) + 1.4 * Math.sin(u * 0.11 + s),
	];
}

function drawVectors(el, { t, seed }) {
	const g = blank();
	for (let y = 1; y < H; y += 4) for (let x = 3; x < W; x += 7) g[y][x] = '.';

	for (let k = 14; k >= 1; k--) { // traînée : positions passées
		const [x, y] = driftAt(t - k * 0.6, seed);
		put(g, x, y, k > 7 ? ',' : '.');
	}

	const [px, py] = driftAt(t, seed);
	const [qx, qy] = driftAt(t - 0.6, seed);
	const ang = Math.atan2(py - qy, px - qx);
	const arrow = ARROWS[((Math.round((ang / Math.PI) * 4) % 8) + 8) % 8];

	text(g, 21, 5, '[o]'); // position d'origine, fixe
	put(g, px, py, '+');
	put(g, px - 1, py, '-'); put(g, px + 1, py, '-');
	put(g, px, py - 1, '|'); put(g, px, py + 1, '|');
	for (let i = 1; i <= 3; i++) put(g, px + Math.cos(ang) * i * 2.4, py + Math.sin(ang) * i * 1.2, arrow);
	el.textContent = frame(lines(g));
}

// --- NETWORK TAKEOVER : nœuds reliés, front d'illumination ------------------

const NODES = [[6, 2], [20, 1], [35, 3], [10, 8], [25, 9], [38, 7]];
const EDGES = [[0, 1], [1, 2], [2, 5], [5, 4], [4, 3], [3, 0], [1, 4]];

function edge(g, a, b) {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const n = Math.max(Math.abs(dx), Math.abs(dy));
	const ch = Math.abs(dy) * 2 < Math.abs(dx) ? '-' : (dx * dy > 0 ? '\\' : '/');
	for (let i = 1; i < n; i++) put(g, a[0] + (dx * i) / n, a[1] + (dy * i) / n, ch);
}

function drawNodes(el, { t, seed }) {
	const g = blank();
	for (const [a, b] of EDGES) edge(g, NODES[a], NODES[b]);

	// Front d'illumination : se propage de nœud en nœud puis se réamorce.
	const cycle = NODES.length + 2;
	const front = (t * 1.1 + seed * cycle) % cycle;
	for (let i = 0; i < NODES.length; i++) {
		const [x, y] = NODES[i];
		const lit = front > i;
		const edgeOfFront = lit && front < i + 0.55;
		text(g, x - 1, y, lit ? (edgeOfFront ? '(#)' : '(*)') : '(o)');
	}
	el.textContent = frame(lines(g));
}

// --- FIRMWARE OVERRIDE : dump hexa, ligne de bascule qui balaie -------------

const BYTES_PER_ROW = 12;

function hexRow(y, page, seed) {
	let s = '';
	for (let i = 0; i < BYTES_PER_ROW; i++) {
		const b = Math.floor(noise(i, y, page, seed) * 256) & 0xff;
		s += (i ? ' ' : '') + b.toString(16).padStart(2, '0');
	}
	return s;
}

function drawMemory(el, { t, seed }) {
	const g = blank();
	const span = H + 3;
	const page = Math.floor((t * 4) / span);
	const flip = Math.floor((t * 4) % span);
	for (let y = 0; y < H; y++) {
		const addr = ((page * H + y) * BYTES_PER_ROW) & 0xffff;
		let body;
		if (y < flip) body = '·· '.repeat(BYTES_PER_ROW).trim();
		else if (y === flip) body = '## '.repeat(BYTES_PER_ROW).trim();
		else body = hexRow(y, page, seed);
		text(g, 0, y, `0x${addr.toString(16).padStart(4, '0')}: ${body}`);
	}
	el.textContent = frame(lines(g));
}

// Toute clé absente retombe sur drawNeutral (voir hack.js).
export const GRAMMARS = {
	'COMMAND INJECTION': drawPackets,
	'LINK HIJACK': drawCarrier,
	'TELEMETRY SPOOF': drawScope,
	'GNSS SPOOF': drawVectors,
	'NETWORK TAKEOVER': drawNodes,
	'FIRMWARE OVERRIDE': drawMemory,
};
