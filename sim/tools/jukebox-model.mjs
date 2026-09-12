// Le modèle PUR du jukebox (issue #120). Aucun DOM, aucun Web Audio, aucun
// node: — src/jukebox.js est l'écran, src/radio.js est le séquenceur, et ici il
// n'y a que de l'arithmétique et du formatage.
//
// Le manifeste n'est pas revalidé ici : src/music.js le passe déjà par
// validateManifest() au chargement, et un second garde qui dirait autre chose
// serait pire qu'aucun.
import { MUSIC_POOLS } from './music-model.mjs';

// L'ordre de MUSIC_POOLS, en table, pour trier sans indexOf quadratique.
const POOL_RANK = new Map(MUSIC_POOLS.map((p, i) => [p, i]));

// La bibliothèque, à plat, groupée par pool puis par id croissant.
//
// Cet ordre EST aussi celui de l'enchaînement : la radio parcourt le pool où
// elle est, puis roule dans le suivant. Et il est stable d'un appel à l'autre —
// une liste qui bougerait sous le curseur entre deux rendus serait pire qu'une
// liste non triée.
export function buildLibrary(manifest) {
	const tracks = manifest?.tracks;
	if (!Array.isArray(tracks)) return [];
	// Un pool inconnu passe derrière tout le reste plutôt que de casser le tri.
	const rank = (t) => POOL_RANK.get(t.pool) ?? MUSIC_POOLS.length;
	return [...tracks].sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
}

// Les filtres offerts : ALL, puis les pools RÉELLEMENT présents dans la
// bibliothèque déjà bâtie.
//
// `swarmNode` est déclaré dans MUSIC_POOLS mais vide aujourd'hui ; un filtre sur
// lequel on tombe toujours vide est du bruit. Il apparaîtra le jour où il aura
// des morceaux, sans qu'on touche à ce fichier.
export function libraryFilters(library) {
	const present = new Set((library ?? []).map((t) => t.pool));
	return ['ALL', ...MUSIC_POOLS.filter((p) => present.has(p))];
}

export function filterLibrary(library, filter) {
	if (!filter || filter === 'ALL') return library;
	return library.filter((t) => t.pool === filter);
}

// '1:24'. Arrondi à la seconde : la ligne dit une durée, pas une mesure.
export function formatDuration(durS) {
	const total = Math.max(0, Math.round(Number(durS) || 0));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 'menu-1aec9db0' -> '1aec9db0'. L'id complet redirait le pool, qui est déjà
// la première colonne.
export function shortId(id) {
	const s = String(id ?? '');
	const cut = s.indexOf('-');
	return cut < 0 ? s : s.slice(cut + 1);
}

// La partie commune à la ligne de liste et à la ligne ON AIR.
// Colonnes fixes : c'est ce qui fait lire la liste comme une table sous
// `white-space: pre` et les chiffres tabulaires de button.terminal-row.
function trackLabel(track) {
	if (!track) return '';
	return [
		String(track.pool ?? '').toUpperCase().padEnd(10),
		shortId(track.id),
		formatDuration(track.durS).padStart(5),
		`${String(Math.round(Number(track.bpm) || 0)).padStart(3)} BPM`,
	].join(' · ');
}

// Le préfixe fait DEUX caractères dans les deux états, et il vit dans le
// libellé : la colonne ::before est déjà prise par le marqueur de focus ▌
// (style.css). Le curseur et l'antenne sont deux faits distincts, ils doivent
// se lire ensemble — et sans que les colonnes sautent d'une ligne à l'autre.
export const PLAYING_MARK = '▶ ';
export const IDLE_MARK = '  ';

export function jukeboxRow(track, { playing = false } = {}) {
	return `${playing ? PLAYING_MARK : IDLE_MARK}${trackLabel(track)}`;
}

export const STOPPED_LINE = 'ON AIR   -- STOPPED --';

export function nowPlayingLine(track) {
	return track ? `ON AIR   ${trackLabel(track)}` : STOPPED_LINE;
}

// L'en-tête de l'écran : ce que la bibliothèque contient, compté et non figé.
export function librarySummary(library) {
	const pools = new Set(library.map((t) => t.pool));
	return `${library.length} TRACKS · ${pools.size} POOLS`;
}

// Index circulaire. `i` à -1 veut dire « rien n'a encore joué » : on entre alors
// par le début ou par la fin selon le sens, plutôt que de compter depuis -1.
export function stepIndex(len, i, delta) {
	if (!len || len <= 0) return -1;
	if (i < 0) return delta >= 0 ? 0 : len - 1;
	return ((i + delta) % len + len) % len;
}
