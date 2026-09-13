// Le verrouillage empilé de docs/brand.md — symbole, un module d'écart, nom —
// en une seule composition pour tout le jeu (#134).
//
// POURQUOI ICI. La marque était écrite deux fois : le cracktro la posait
// correctement (symbole + FPVTP! en --font-ui 500), l'écran de chargement
// écrivait le nom long seul, en Departure Mono et en capitales, c'est-à-dire
// « FPVTHEPLANET! » — une composition que le document n'autorise nulle part.
// Deux écrans, deux marques. Ce module est la réponse : le balisage vient
// d'ici, la géométrie de brand-mark-model.mjs, et l'intro n'en garde que ce qui
// lui est propre (le tracé module par module, la zone de respect opaque).
//
// PUR côté données : la géométrie est importée, le rendu est une chaîne. Le
// tracé progressif reste dans intro.js, qui a besoin d'un rect à la fois.
import { MARK_RECTS } from '../tools/brand-mark-model.mjs';

// Le symbole entier. `fill` est laissé à currentColor par la feuille : aucune
// couleur ne descend d'ici (interdit de brand.md, y compris pendant un rituel).
export function markSvg(className = 'lockup-mark') {
	const rects = MARK_RECTS
		.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
		.join('');
	return `<svg class="${className}" viewBox="0 0 100 100" aria-hidden="true">${rects}</svg>`;
}

// Le verrouillage empilé, symbole posé et nom dessous. `splitName` découpe le
// nom en spans : le cracktro déforme colonne par colonne, et un écran statique
// ne paie rien pour des spans qu'il ne bouge pas.
export function stackedLockup({ name = 'FPVTP!', extra = '', splitName = false } = {}) {
	const label = splitName
		? name.split('').map((ch) => `<span>${ch}</span>`).join('')
		: name;
	return `<div class="lockup ${extra}" role="img" aria-label="${name}">`
		+ markSvg()
		+ `<div class="lockup-name" aria-hidden="true">${label}</div>`
		+ '</div>';
}
