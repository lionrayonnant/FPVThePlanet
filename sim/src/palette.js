// PHASE 19 (issue #56) — le pont entre tokens.css et le peu de code qui peint
// lui-même.
//
// Une couche vectorielle Leaflet ne comprend pas `var(--warm-white)` : elle veut
// une couleur résolue, en chaîne. Plutôt que de recopier les valeurs dans le JS
// — c'est exactement ce qui avait fait diverger `#7ddc8a` et `#7ddc9a` avant
// cette phase — on lit la feuille de style, qui reste la source unique.
//
// Ce qui N'EST PAS ici : la palette canvas de drone-osd.js. Cet OSD est peint
// dans l'image du drone et traverse la liaison vidéo — c'est de la matière
// filmée, pas de l'interface. Ses couleurs appartiennent au matériel, pas aux
// tokens, et la Bible §42 veut que ce qui passe par la caméra reste brut.

const cache = new Map();

// Les valeurs de repli servent au rendu hors navigateur (tests Node) et à
// l'instant où une couche se construirait avant que la feuille soit appliquée.
// Elles doivent rester alignées sur tokens.css ; palette-selftest.mjs le vérifie.
const FALLBACK = {
	'--black': '#0a0908',
	'--dark-grey': '#121110',
	'--grey': '#221f1c',
	'--warm-white': '#ece7dd',
	'--light-grey': '#8a827a',
	'--green': '#7aa96b',
	'--yellow': '#d4b155',
	'--orange': '#cf7b3e',
	'--red': '#c8504a',
	// The one demo colour a daily screen may touch, and only under the cursor:
	// DATA marks the SELECTED item with it (issue #26, Bible §19).
	'--magenta': '#e34de0',
};

export function token(name) {
	if (cache.has(name)) return cache.get(name);
	let v = '';
	if (typeof document !== 'undefined') {
		v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	}
	if (!v) return FALLBACK[name] ?? '';
	// On ne met en cache qu'une valeur réellement résolue : sinon un appel trop
	// tôt figerait le repli pour toute la session.
	cache.set(name, v);
	return v;
}

// Uniquement pour les tests : la feuille ne change pas en cours de partie.
export function resetPaletteCache() { cache.clear(); }
