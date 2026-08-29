// Motifs visuels par famille de hacking (PHASE 09, Bible §17) + primitives de
// culmination du rituel (PHASE 10, Bible §18-19). Chaque motif identifie sa
// famille SANS que le joueur ait à lire son nom (critère d'acceptation).
// Purement décoratif : la seule donnée qui entre est un `seed` cosmétique et
// un temps `t` en secondes.
//
// Contrat d'un motif d'analyse : draw(el, { t: number, seed: number, lock?: number }).
// `lock` va de 0 (recherche) à 1 (verrouillé) : la culmination du hack juste
// avant le rituel. Écrit dans el.textContent. Pas d'état module — tout dérive
// de (t, seed, lock).
//
// Contrat d'une primitive de rituel (PHASE 10) : draw(el, { t: number, seed: number }).
// Même toolkit ASCII, pas de `lock` — la couleur (cyan/magenta/violet/bleu
// électrique, Bible §19) est appliquée par le conteneur (src/ritual.js), pas
// par la primitive : le rendu reste du texte brut, une seule teinte à la fois.

const W = 44; // largeur du champ ASCII
const H = 12; // hauteur

const frame = (rows) => rows.map((r) => r.padEnd(W).slice(0, W)).join('\n');

// Petit hash déterministe chaîne -> graine cosmétique [0,1) (varie le bruit
// d'un vol à l'autre, ne révèle jamais la famille au joueur). Partagé par
// hack.js (motif d'analyse) et ritual.js (primitives de culmination, PHASE 10).
export function cosmeticSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < String(str).length; i++) {
		h ^= String(str).charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

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

function drawPackets(el, { t, seed, lock = 0 }) {
	const g = blank();
	const col = Math.round(W * 0.68); // fenêtre sur laquelle les paquets s'alignent
	for (let y = 0; y < H; y += 2) { // une ligne sur deux : respiration
		const track = packetTrack(y, seed);
		const P = track.length;
		// À la culmination le défilement se fige : les bursts se calent.
		const speed = (9 + Math.floor(noise(0, y, 2, seed) * 16)) * (1 - 0.92 * lock);
		const off = Math.floor(t * speed);
		for (let x = 0; x < W; x++) {
			const c = track[(((x + off) % P) + P) % P];
			if (c !== ' ') g[y][x] = c;
		}
		if (lock > 0.6) g[y][col] = '|';
	}
	el.textContent = frame(lines(g));
}

// --- LINK HIJACK : porteuse sinusoïdale + marqueur qui se cale sur une crête -

function drawCarrier(el, { t, seed, lock = 0 }) {
	const g = blank();
	const k = 0.30;      // rad/colonne
	const w = 1.6;       // rad/s
	const amp = 4.0;
	const mid = (H - 1) / 2;
	const carrier = (x) => mid - amp * Math.sin(x * k - t * w);

	for (let x = 0; x < W; x++) stroke(g, x, carrier(x), carrier(x + 1), '~', ':');

	// Crête la plus proche du 2/3 de l'écran, suivie une fois « synchronisé ».
	const target = W * 0.66;
	const n = Math.round((target * k - t * w - Math.PI / 2) / (2 * Math.PI));
	const lockedX = clamp(Math.round((Math.PI / 2 + 2 * n * Math.PI + t * w) / k), 0, W - 1);

	// Marqueur : glisse 3 s de gauche à droite, puis se verrouille. `lock` force
	// le verrouillage immédiat et épaissit le marqueur à la culmination.
	let mx;
	if (lock > 0.05) {
		mx = lockedX;
	} else {
		const ph = (t + seed * 4.5) % 4.5;
		mx = ph < 3 ? Math.round((ph / 3) * (W - 1)) : lockedX;
	}
	mx = clamp(mx, 0, W - 1);
	const mark = lock > 0.6 ? '#' : '|';
	for (let y = 0; y < H; y++) g[y][mx] = (Math.round(carrier(mx)) === y) ? '#' : mark;
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

function drawScope(el, { t, seed, lock = 0 }) {
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
		// À la culmination le segment façonné rejoint l'amplitude de la trace.
		const a = inj ? 4.3 - 2.9 * lock : 1.6;
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

function drawVectors(el, { t, seed, lock = 0 }) {
	const g = blank();
	for (let y = 1; y < H; y += 4) for (let x = 3; x < W; x += 7) g[y][x] = '.';

	for (let k = 14; k >= 1; k--) { // traînée : positions passées
		const [x, y] = driftAt(t - k * 0.6, seed);
		put(g, x, y, k > 7 ? ',' : '.');
	}

	const [dx, dy] = driftAt(t, seed);
	const [qx, qy] = driftAt(t - 0.6, seed);
	// À la culmination le réticule revient se caler sur l'origine (2/3, 5).
	const px = dx + (22 - dx) * lock;
	const py = dy + (5 - dy) * lock;
	const ang = Math.atan2(dy - qy, dx - qx);
	const arrow = ARROWS[((Math.round((ang / Math.PI) * 4) % 8) + 8) % 8];

	text(g, 21, 5, '[o]'); // position d'origine, fixe
	put(g, px, py, '+');
	put(g, px - 1, py, '-'); put(g, px + 1, py, '-');
	put(g, px, py - 1, '|'); put(g, px, py + 1, '|');
	if (lock < 0.5) {
		for (let i = 1; i <= 3; i++) put(g, px + Math.cos(ang) * i * 2.4, py + Math.sin(ang) * i * 1.2, arrow);
	}
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

function drawNodes(el, { t, seed, lock = 0 }) {
	const g = blank();
	for (const [a, b] of EDGES) edge(g, NODES[a], NODES[b]);

	// Front d'illumination : se propage de nœud en nœud puis se réamorce. À la
	// culmination tous les nœuds sont tenus.
	const cycle = NODES.length + 2;
	const front = lock > 0.5 ? cycle : (t * 1.1 + seed * cycle) % cycle;
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

function drawMemory(el, { t, seed, lock = 0 }) {
	const g = blank();
	const span = H + 3;
	const page = Math.floor((t * 4) / span);
	const flip = Math.floor((t * 4) % span);
	const frozen = lock > 0.9; // à la culmination le balayage s'arrête, l'image est stable
	for (let y = 0; y < H; y++) {
		const addr = ((page * H + y) * BYTES_PER_ROW) & 0xffff;
		let body;
		if (frozen) body = hexRow(y, page, seed);
		else if (y < flip) body = '·· '.repeat(BYTES_PER_ROW).trim();
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

// ============================================================================
// Primitives de culmination du rituel (PHASE 10, Bible §18-19). 8 blocs
// composables, communs aux 6 familles ; seul le sous-ensemble pondéré par
// famille (FAMILY_PRIMITIVES) et le nombre de battements (variante V1-V4,
// tools/ritual-model.mjs) changent — pas 24 animations écrites à la main.

// Vocabulaire d'ambiance déjà en liste blanche (hack-model.mjs) : réutilisé
// tel quel, aucun nouveau mot de "procédure" n'est introduit ici.
import { HACK_VOCAB } from '../tools/hack-model.mjs';
const VOCAB = [...HACK_VOCAB];

// --- scanBurst : défilement rapide de tokens du vocabulaire d'ambiance ------

function scanBurst(el, { t, seed }) {
	const g = blank();
	for (let y = 0; y < H; y++) {
		const row = [];
		let x = 0;
		let col = Math.floor(noise(0, y, 0, seed) * VOCAB.length);
		while (x < W) {
			const word = VOCAB[(col + Math.floor(t * 5 + y)) % VOCAB.length];
			row.push(word);
			x += word.length + 1;
			col++;
		}
		text(g, -Math.floor((t * 30 + y * 3) % 20), y, row.join(' '));
	}
	el.textContent = frame(lines(g));
}

// --- glitchShift : bandes de texte qui se déchirent horizontalement --------

function glitchShift(el, { t, seed }) {
	const g = blank();
	const base = Math.floor(t * 3);
	for (let y = 0; y < H; y++) {
		const tear = noise(base, y, 0, seed) > 0.72;
		const shift = tear ? Math.floor((noise(base, y, 1, seed) - 0.5) * W * 0.6) : 0;
		for (let x = 0; x < W; x++) {
			const sx = ((x - shift) % W + W) % W;
			const on = noise(sx, y, base * 0.3, seed) > 0.55;
			if (on) g[y][x] = tear ? '#' : (noise(sx, y, base * 0.3 + 1, seed) > 0.5 ? '▓' : '░');
		}
	}
	el.textContent = frame(lines(g));
}

// --- pulseRing : anneau ASCII qui s'étend depuis le centre -----------------

function pulseRing(el, { t, seed }) {
	const g = blank();
	const cx = W / 2;
	const cy = H / 2;
	const period = 1.4;
	const phase = (t + seed * period) % period;
	const radius = (phase / period) * (W / 2 + 2);
	const glyphs = ['·', 'o', 'O', '#'];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const d = Math.hypot((x - cx) / 1.9, y - cy);
			const rim = Math.abs(d - radius);
			if (rim < 1.4) g[y][x] = glyphs[clamp(Math.floor((1.4 - rim) * 2.4), 0, 3)];
		}
	}
	el.textContent = frame(lines(g));
}

// --- gridSwarm : grille de cellules qui s'allument en cascade --------------

const SWARM_CELL = 4;

function gridSwarm(el, { t, seed }) {
	const g = blank();
	const cols = Math.floor(W / SWARM_CELL);
	const rows = Math.floor(H / 2);
	for (let cy = 0; cy < rows; cy++) {
		for (let cx = 0; cx < cols; cx++) {
			const delay = noise(cx, cy, 0, seed) * 1.6;
			const on = ((t + seed * 3) % 1.6) > delay;
			put(g, cx * SWARM_CELL + 1, cy * 2, on ? '#' : '.');
		}
	}
	el.textContent = frame(lines(g));
}

// --- waveformSpike : onde façon oscilloscope avec un spike qui saute -------

function waveformSpike(el, { t, seed }) {
	const g = blank();
	const mid = (H - 1) / 2;
	const spikeX = Math.floor(noise(Math.floor(t * 6), 0, 0, seed) * W);
	for (let x = 0; x < W; x++) {
		const near = Math.abs(x - spikeX) < 2;
		const y = near
			? mid - (H / 2 - 1) * (1 - Math.abs(x - spikeX) / 2)
			: mid - 1.6 * Math.sin(x * 0.5 + t * 9 + seed * 6);
		put(g, x, clamp(y, 0, H - 1), near ? '#' : '·');
	}
	el.textContent = frame(lines(g));
}

// --- vectorSweep : flèche/ligne qui balaie l'écran de bas à droite --------

function vectorSweep(el, { t, seed }) {
	const g = blank();
	const period = 1.2;
	const phase = ((t + seed * period) % period) / period;
	const x0 = -4 + phase * (W + 8);
	const y0 = H - 1 - phase * (H - 1);
	for (let i = 0; i < 10; i++) put(g, x0 - i * 0.8, clamp(y0 + i * 0.3, 0, H - 1), i === 0 ? '>' : '-');
	el.textContent = frame(lines(g));
}

// --- memoryScroll : colonne d'offsets hexa qui défile vite -----------------

function memoryScroll(el, { t, seed }) {
	const g = blank();
	const speed = 18; // lignes/s : nettement plus rapide que drawMemory
	const off = Math.floor(t * speed);
	for (let y = 0; y < H; y++) {
		const addr = ((off + y) * BYTES_PER_ROW) & 0xffff;
		text(g, 0, y, `0x${addr.toString(16).padStart(4, '0')}: ${hexRow(off + y, 0, seed)}`);
	}
	el.textContent = frame(lines(g));
}

// --- chromaSplit : dédoublement de glyphes, façon aberration chromatique ---

function chromaSplit(el, { t, seed }) {
	const g = blank();
	const shift = 1 + Math.round(Math.sin(t * 7 + seed * 5) * 1.5);
	for (let y = 0; y < H; y++) {
		for (let x = 2; x < W - 2; x++) {
			if (noise(x, y, Math.floor(t * 4), seed) > 0.82) {
				put(g, x - shift, y, '[');
				put(g, x, y, '#');
				put(g, x + shift, y, ']');
			}
		}
	}
	el.textContent = frame(lines(g));
}

export const RITUAL_PRIMITIVES = {
	scanBurst, glitchShift, pulseRing, gridSwarm,
	waveformSpike, vectorSweep, memoryScroll, chromaSplit,
};

// 2-3 primitives pondérées par famille : mêmes 8 fonctions pour toutes, seul
// le sous-ensemble + l'ordre changent (grammaire, pas 24 séquences à la main).
// Une famille absente retomberait sur un générique — en pratique HACK_TYPES
// (6) couvre toutes les entrées, testé par ritual-selftest.mjs.
export const FAMILY_PRIMITIVES = {
	'COMMAND INJECTION': ['scanBurst', 'gridSwarm', 'glitchShift'],
	'LINK HIJACK': ['pulseRing', 'waveformSpike'],
	'TELEMETRY SPOOF': ['waveformSpike', 'chromaSplit'],
	'GNSS SPOOF': ['vectorSweep', 'chromaSplit'],
	'NETWORK TAKEOVER': ['gridSwarm', 'pulseRing'],
	'FIRMWARE OVERRIDE': ['memoryScroll', 'scanBurst'],
};
