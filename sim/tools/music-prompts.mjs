// Source de vérité créative de l'arc musical (issue #122). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Le pipeline de génération
// (tools/music-gen.mjs) et le selftest importent ce fichier tel quel.
//
// L'ADN commun, non négociable, est celui de FPVTP! : fin 90 / début 2000,
// electronica, IDM, techno, trance. Pas de modern EDM, pas de musique de film.
// Ces sept prompts définissent le centre de gravité, PAS sept genres verrouillés :
// buildPrompt() les décale sur six axes pour que deux morceaux d'une même
// famille se ressemblent sans être le même.
//
// Règle de la phase :
//   La musique ne dit pas au joueur quelle catégorie il a reçue.
//   Elle lui en donne une intuition.

import { rngFrom } from './target-build.mjs';

// Les six clés de famille sont celles de src/drone-profiles.js FAMILIES, plus
// `menu` qui n'est pas un drone mais l'ambiance du terminal.
export const MUSIC_POOLS = [
	'menu',
	'freestyle5',
	'race5',
	'cinewhoop',
	'longrange',
	'heavy5',
	'toothpick',
];

// Le noyau de chaque pool. `core` est la description de genre, `bpm` la
// fourchette autorisée (le centre est la valeur de l'issue #122), `feel` n'entre
// pas dans le prompt : c'est la sensation visée, gardée ici pour que la revue à
// l'oreille sache ce qu'elle juge.
export const POOLS = {
	menu: {
		label: 'MENU',
		bpm: [84, 96],
		feel: 'complot, attente, institution froide',
		core: 'late-1990s dark ambient electronica, conspiratorial and institutional, '
			+ 'cold digital pads, sparse minimal percussion, deep quiet bass, '
			+ 'slow unresolved harmonic movement, patient and watchful',
	},
	freestyle5: {
		label: '5" FREESTYLE',
		bpm: [126, 138],
		feel: 'polyvalent, nerveux, libre — le son FPV de référence',
		core: 'early-2000s underground electro and breakbeat, energetic and playful, '
			+ 'crisp drum programming, rolling bassline, agile synth patterns, '
			+ 'subtle IDM elements, technical but loose, PC demo scene atmosphere',
	},
	race5: {
		label: '5" RACE',
		bpm: [142, 154],
		feel: 'vitesse, concentration, pression — « putain, ce drone va vite »',
		core: 'early-2000s hard techno and IDM, extremely energetic, '
			+ 'aggressive mechanical percussion, relentless four-on-the-floor kick, '
			+ 'distorted bass sequence, rapid rhythmic patterns, sharp synthetic transients, '
			+ 'tense forward momentum, underground European rave atmosphere',
	},
	cinewhoop: {
		label: 'CINEWHOOP',
		bpm: [104, 118],
		feel: 'observation, stabilité, paysage',
		core: 'early-2000s atmospheric electronica, warm synthesizers, spacious pads, '
			+ 'subtle breakbeat percussion, gentle bassline, slow evolving textures, '
			+ 'restrained IDM influences, curious atmosphere, '
			+ 'slightly nostalgic computer hardware character',
	},
	longrange: {
		label: 'LONG RANGE',
		bpm: [98, 110],
		feel: 'distance, endurance, solitude — regarder le RSSI descendre',
		core: 'late-1990s and early-2000s dub techno, deep sub bass, '
			+ 'hypnotic four-to-the-floor pulse, long tape delays, sparse percussion, '
			+ 'slowly evolving filters, distant synthetic textures, spacious stereo field, '
			+ 'minimal and introspective, underground electronic music',
	},
	heavy5: {
		label: 'HEAVY 5"',
		bpm: [120, 132],
		feel: 'masse, puissance, inertie — la machine doit peser',
		core: 'early-2000s industrial techno, heavy low end, powerful kick drums, '
			+ 'dense mechanical percussion, distorted analog bass, '
			+ 'industrial synthesizer textures, physical and massive rhythm, '
			+ 'dark but controlled, underground European electronic scene',
	},
	toothpick: {
		label: 'MICRO',
		bpm: [132, 144],
		feel: 'petit, vif, joueur, presque euphorique',
		core: 'late-1990s and early-2000s progressive trance, '
			+ 'bright arpeggiated synthesizers, playful rhythmic patterns, '
			+ 'light punchy percussion, euphoric but slightly strange, '
			+ 'agile melodic sequences, warm digital synthesizer textures, '
			+ 'underground PC and rave culture atmosphere, energetic and lightweight',
	},
};

// Les six axes de variation de l'issue #122. Chaque axe propose trois
// inflexions ; `null` veut dire « ne rien ajouter sur cet axe », ce qui laisse
// le noyau parler seul et évite les prompts surchargés qui virent au bruit.
export const AXES = {
	energy:     [null, 'restrained and patient', 'relentless and driving'],
	darkness:   [null, 'darker and colder', 'brighter and more open'],
	density:    [null, 'sparse arrangement, lots of space', 'dense layered arrangement'],
	aggression: [null, 'smooth and rounded', 'harsh distorted edges'],
	atmosphere: [null, 'hypnotic and repetitive', 'restless and shifting'],
	// Le grain matériel : c'est ce qui tient l'ancrage « fin 90 » quand les
	// autres axes tirent ailleurs.
	grain: [
		'raw hardware synthesizers',
		'vintage drum machines and analog hardware',
		'gritty digital samplers, early tracker character',
	],
};

export const AXIS_NAMES = Object.keys(AXES);

// Toujours présent, jamais varié : c'est la clôture du genre. Le selftest
// vérifie qu'aucun prompt ne sort sans.
export const NEGATIVES = 'instrumental, no vocals, no modern EDM drop, no cinematic trailer music';

// Nombre d'axes (hors `grain`, toujours tiré) qu'un morceau reçoit. Deux, pas
// six : au-delà le prompt se contredit et Stable Audio rend de la bouillie.
export const AXES_PER_TRACK = 2;

const AXIS_POOL = AXIS_NAMES.filter((k) => k !== 'grain');

// Tire `n` axes distincts, dans un ordre stable, sans réordonner la liste
// source : le résultat ne dépend que de la seed.
function pickAxes(rand, n) {
	const remaining = AXIS_POOL.slice();
	const out = [];
	for (let i = 0; i < n && remaining.length; i++) {
		out.push(remaining.splice(Math.floor(rand() * remaining.length), 1)[0]);
	}
	return out.sort();
}

/**
 * Construit un prompt et sa fiche pour un morceau. Pur et déterministe : la
 * même (pool, seed) rend toujours le même prompt, ce qui rend la bibliothèque
 * reproductible et le rejet d'un morceau explicable.
 *
 * @returns {{ pool, bpm, prompt, axes }}
 */
export function buildPrompt(pool, seed) {
	const spec = POOLS[pool];
	if (!spec) throw new Error(`[music-prompts] pool inconnu : ${pool}`);

	const rand = rngFrom(`${seed}::music::${pool}`);

	const [lo, hi] = spec.bpm;
	const bpm = lo + Math.floor(rand() * (hi - lo + 1));

	const chosen = pickAxes(rand, AXES_PER_TRACK);
	const axes = {};
	const fragments = [];
	for (const name of chosen) {
		const options = AXES[name];
		const value = options[Math.floor(rand() * options.length)];
		axes[name] = value;
		if (value) fragments.push(value);
	}
	const grain = AXES.grain[Math.floor(rand() * AXES.grain.length)];
	axes.grain = grain;
	fragments.push(grain);

	const prompt = [`${spec.core}`, `${bpm} BPM`, ...fragments, NEGATIVES].join(', ');
	return { pool, bpm, prompt, axes };
}
