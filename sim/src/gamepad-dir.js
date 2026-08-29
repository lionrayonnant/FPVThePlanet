// Lecture d'une direction de manette (D-pad ou stick gauche), factorisée
// entre bootstrap.js (saisie du CONTROL VECTOR à la définition) et ritual.js
// (saisie pendant un hack, PHASE 10). Fonction pure au sens DOM : seule
// dépendance, navigator.getGamepads().
//
// `prev` : direction retenue au dernier appel (anti-répétition — sans elle,
// une manette tenue en biais spammerait la même direction à chaque poll).
// Retourne 'up'|'right'|'down'|'left' (direction NOUVELLE), '__hold' (même
// direction encore tenue, à ignorer), ou null (rien d'actif).
export function readGamepadDir(prev) {
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	if (!pad) return null;
	const [x, y] = pad.axes;
	const b = pad.buttons;
	let dir = null;
	if (b[12]?.pressed || y < -0.5) dir = 'up';
	else if (b[13]?.pressed || y > 0.5) dir = 'down';
	else if (b[14]?.pressed || x < -0.5) dir = 'left';
	else if (b[15]?.pressed || x > 0.5) dir = 'right';
	return dir && dir !== prev ? dir : (dir ? '__hold' : null);
}
