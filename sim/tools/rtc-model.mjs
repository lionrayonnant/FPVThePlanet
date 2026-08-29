// Logs RTC décoratifs (PHASE 05, Bible §9). Le crew commente l'acquisition en
// arrière-plan — jamais un état du pipeline, jamais quelque chose que le
// joueur doit lire pour continuer. Aucune E/S, aucun DOM : le scanner tire les
// lignes une à une sur un minuteur, le selftest vérifie juste que le script
// est stable et que les emplacements sont bien remplis.
//
// Le texte est en anglais (D5, Bible §11) : c'est de l'interface de jeu, même
// décorative. Le crew est celui du §10 : root (tranche), vex (--), mikhail
// (garde-fou), jensen (agent double, peu bavard par construction).

const SCRIPT = [
	['root', 'new sector queued'],
	['vex', 'on it'],
	['root', '{name}'],
	['vex', 'obviously'],
	['root', 'how many tiles'],
	['vex', '{tiles}'],
	['root', 'that a lot'],
	['vex', 'depends what you count'],
	['mikhail', 'you counting drones or tiles'],
	['root', 'does it matter'],
	['mikhail', 'yes'],
	['jensen', 'it matters'],
	['root', 'why are you even in this channel'],
	['jensen', 'no comment'],
	['vex', 'mesh is coming in fine'],
	['mikhail', 'define fine'],
	['vex', 'no holes so far'],
	['mikhail', 'so far is not a guarantee'],
	['root', 'ship it when it lands'],
	['mikhail', 'no'],
	['root', 'why'],
	['mikhail', 'because it is not landed yet'],
	['root', 'fair'],
	['vex', 'textures baking'],
	['jensen', 'watching'],
	['root', 'watching what'],
	['jensen', 'no comment'],
];

// Un script déterministe : les mêmes {name}/{tiles} produisent toujours les
// mêmes lignes. Ni tirage aléatoire, ni horloge — juste du texte de saveur, la
// même à chaque écoute d'une même acquisition.
export function rtcScript({ name, tiles }) {
	const n = String(name ?? 'this sector').toUpperCase();
	const t = Number.isFinite(tiles) && tiles > 0 ? `~${Math.round(tiles)}` : 'a lot';
	return SCRIPT.map(([speaker, line]) => ({
		speaker,
		line: line.replace('{name}', n).replace('{tiles}', t),
	}));
}

export const CREW = ['root', 'vex', 'mikhail', 'jensen'];
