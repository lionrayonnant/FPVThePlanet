// Selftest de la marque (#73). Deux choses y sont vérifiées, et la seconde est
// la raison d'être du fichier :
//
//  1. le modèle rend bien ce qu'on lui demande (ordre du tracé, comptage) ;
//  2. le modèle DIT LA MÊME CHOSE que `public/brand/fpvtp-mark.svg` et que le
//     motif écrit dans `docs/brand.md`.
//
// La marque a une source, et ce n'est pas ce code : c'est le SVG, comme
// `docs/brand.md` l'écrit (« recopier depuis ici, ne pas ré-exporter »). Le
// modèle n'existe que parce qu'un écran de boot ne peut pas se permettre un
// fetch qui échoue — il est une copie, et ce test est ce qui interdit à la
// copie de dériver.
//
// Lancer : node tools/brand-mark-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	MODULE, PATTERN_ROWS, FRAME_RECTS, CELL_RECTS, MARK_RECTS,
	TRACE, revealCount, nameVisibleAt,
} from './brand-mark-model.mjs';
import { INTRO_PHASES } from './intro-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const simRoot = join(here, '..');
const repoRoot = join(simRoot, '..');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const key = (r) => `${r.x},${r.y},${r.w},${r.h}`;

// --- la copie et sa source ---------------------------------------------------

// Les rectangles du SVG, dans l'ordre du fichier. Un `<rect>` par ligne, quatre
// attributs : le fichier est écrit à la main et le restera (19 rectangles, ni
// transform ni groupe), donc une expression régulière suffit et vaut mieux
// qu'une dépendance de parseur XML pour un selftest qui doit rester sans E/S
// autre que cette lecture.
function svgRects() {
	const svg = readFileSync(join(simRoot, 'public/brand/fpvtp-mark.svg'), 'utf8');
	const out = [];
	const re = /<rect\s+x="([-\d.]+)"\s+y="([-\d.]+)"\s+width="([-\d.]+)"\s+height="([-\d.]+)"/g;
	for (const m of svg.matchAll(re)) {
		out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
	}
	return out;
}

t('le SVG de la marque porte 19 rectangles, et rien d\'autre', () => {
	const rects = svgRects();
	assert.equal(rects.length, 19);
	const svg = readFileSync(join(simRoot, 'public/brand/fpvtp-mark.svg'), 'utf8');
	// Aucun trait, aucun arrondi, aucun chevauchement (brand.md, « Géométrie »).
	for (const forbidden of ['<path', '<circle', '<g ', 'rx=', 'ry=', 'stroke']) {
		assert.ok(!svg.includes(forbidden), `le SVG ne doit pas contenir ${forbidden}`);
	}
});

t('#73 : le modèle rend EXACTEMENT les rectangles du SVG', () => {
	const fromSvg = new Set(svgRects().map(key));
	const fromModel = new Set(MARK_RECTS.map(key));
	assert.equal(fromModel.size, 19, 'le modèle porte 19 rectangles distincts');
	assert.deepEqual([...fromModel].sort(), [...fromSvg].sort(),
		'le modèle a dérivé du SVG : c\'est le SVG qui fait foi, pas ce code');
});

t('#73 : la marque n\'introduit aucune couleur — elle hérite celle du contexte', () => {
	const svg = readFileSync(join(simRoot, 'public/brand/fpvtp-mark.svg'), 'utf8');
	assert.ok(!/fill="(?!currentColor)/.test(svg), 'un fill littéral s\'est glissé dans le SVG');
	// Et le modèle ne porte pas de couleur du tout : il ne connaît que des
	// rectangles. C'est le CSS qui pose var(--ink) — et l'interdit de
	// brand.md (« pas de couleur d'état ni de couleur demo ») ne tient que
	// parce que rien ici ne peut en imposer une.
	for (const r of MARK_RECTS) assert.deepEqual(Object.keys(r).sort(), ['h', 'w', 'x', 'y']);
});

t('#73 : le motif 5 × 5 du modèle est celui que docs/brand.md écrit', () => {
	const md = readFileSync(join(repoRoot, 'docs/brand.md'), 'utf8');
	// Le premier bloc de cinq lignes de cinq jetons `.`/`#` du document.
	const block = md.match(/```text\n((?:[.#](?: [.#]){4}\n){5})```/);
	assert.ok(block, 'le motif 5 × 5 est introuvable dans docs/brand.md');
	const rows = block[1].trimEnd().split('\n').map((l) => l.split(' ').join(''));
	assert.deepEqual(PATTERN_ROWS, rows,
		'le modèle et la documentation ne décrivent plus la même marque');
});

// --- la géométrie ------------------------------------------------------------

t('le motif : 5 lignes de 5, 14 cellules pleines', () => {
	assert.equal(PATTERN_ROWS.length, 5);
	for (const row of PATTERN_ROWS) assert.equal(row.length, 5);
	const filled = PATTERN_ROWS.join('').split('').filter((c) => c === '#').length;
	assert.equal(filled, 14);
	assert.equal(CELL_RECTS.length, 14);
});

t('le cadre : cinq rectangles, interrompu au bord supérieur seulement', () => {
	assert.equal(FRAME_RECTS.length, 5);
	const top = FRAME_RECTS.filter((r) => r.y === 0);
	assert.equal(top.length, 2, 'le bord supérieur est en deux morceaux');
	// 28 unités d'interruption, centrées (brand.md, « Géométrie »).
	const [left, right] = top.sort((a, b) => a.x - b.x);
	assert.equal(right.x - (left.x + left.w), 28);
	assert.equal(left.x + left.w, 50 - 14, 'l\'interruption est centrée');
});

t('le module vaut 100 / 16', () => {
	assert.equal(MODULE, 100 / 16);
});

// --- le tracé ----------------------------------------------------------------

t('#73 : le cadre se trace en premier — c\'est le panneau, pas un ornement', () => {
	assert.deepEqual(MARK_RECTS.slice(0, 5).map(key), FRAME_RECTS.map(key));
	assert.deepEqual(MARK_RECTS.slice(5).map(key), CELL_RECTS.map(key));
});

t('#73 : les cellules se tracent en ordre de lecture', () => {
	for (let i = 1; i < CELL_RECTS.length; i++) {
		const a = CELL_RECTS[i - 1], b = CELL_RECTS[i];
		assert.ok(b.y > a.y || (b.y === a.y && b.x > a.x),
			`la cellule ${i} ne suit pas l'ordre de lecture`);
	}
});

t('#73 : revealCount va de 0 à 19 sans jamais reculer', () => {
	assert.equal(revealCount(0), 0);
	assert.equal(revealCount(-500), 0, 'clampé avant le départ');
	let prev = 0;
	for (let ms = 0; ms <= TRACE.doneMs; ms += 10) {
		const c = revealCount(ms);
		assert.ok(c >= prev, `revealCount recule à ${ms} ms`);
		assert.ok(c <= 19, `revealCount dépasse 19 à ${ms} ms`);
		prev = c;
	}
	assert.equal(revealCount(TRACE.doneMs), 19);
	assert.equal(revealCount(TRACE.doneMs + 10000), 19, 'clampé après la fin');
});

t('#73 : le cadre est entier avant que la première cellule tombe', () => {
	assert.equal(revealCount(TRACE.frameDoneMs), 5);
	assert.ok(revealCount(TRACE.frameDoneMs - 1) < 5);
});

t('#73 : le nom s\'inscrit APRÈS la marque, jamais avec elle', () => {
	assert.ok(TRACE.nameAtMs >= TRACE.doneMs,
		'le nom ne doit pas s\'inscrire pendant que la marque se trace');
	assert.equal(nameVisibleAt(TRACE.nameAtMs - 1), false);
	assert.equal(nameVisibleAt(TRACE.nameAtMs), true);
});

t('#73 : tout le tracé tient dans la phase reveal — aucune durée nouvelle', () => {
	const revealMs = INTRO_PHASES[0].durMs;
	// Les deux modèles restent indépendants (pas de minutage réinventé dans
	// src/intro.js) mais doivent tomber d'accord : une marque encore en train
	// de se tracer quand la plasma démarre serait la marque prise dans les
	// couleurs demo, ce que brand.md interdit.
	assert.ok(TRACE.nameAtMs < revealMs,
		`le tracé (${TRACE.nameAtMs} ms) déborde de la phase reveal (${revealMs} ms)`);
});

console.log(`\n${n} tests OK`);
