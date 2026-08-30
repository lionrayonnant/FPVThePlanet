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
		// v2 : la v1 demandait « energetic and playful, agile synth patterns »,
		// c'est-à-dire le terrain de MICRO, et se faisait manger par lui. Le
		// freestyle n'est pas joueur, il est FUNKY et cassé : le groove
		// bouscule, la caisse claire tombe où on ne l'attend pas.
		core: 'early-2000s underground electro and chopped breakbeat, '
			+ 'funky and swaggering, heavy syncopated snare, '
			+ 'thick rubbery bassline with attitude, broken drum edits, '
			+ 'gritty electro stabs, groove that pushes and pulls against the grid, '
			+ 'PC demo scene and tracker music attitude',
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
		// v2 : la v1 disait « subtle », « gentle », « restrained » dans la même
		// phrase — trois adjectifs qui reculent, et rien qui s'engage. On
		// commet une vraie identité : une mélodie qui flotte, mélancolique et
		// large, et une accroche située plutôt qu'un « curious atmosphere ».
		core: 'early-2000s atmospheric electronica with a real floating melody, '
			+ 'wide glowing pads, wistful and unhurried, '
			+ 'clear melodic motif that drifts and returns, '
			+ 'deep round bassline, crisp detailed breakbeat underneath, '
			+ 'the melancholy of an empty city seen from above at dawn, '
			+ 'warm 90s digital synthesizer character',
	},
	longrange: {
		label: 'LONG RANGE',
		bpm: [98, 110],
		feel: 'distance, endurance, solitude — regarder le RSSI descendre',
		// v2 : la v1 empilait minimal / sparse / slowly / distant — tout tirait
		// dans le même sens et le résultat devenait du papier peint. La
		// solitude n'est pas l'absence : il faut UNE voix, seule, dans un
		// espace immense. D'où l'accord de nappe qui revient et la basse
		// physique sous les échos.
		core: 'late-1990s Berlin dub techno, cavernous and lonely, '
			+ 'one aching chord stab drenched in long tape echo, returning again and again, '
			+ 'deep physical sub bass you feel more than hear, '
			+ 'steady hypnotic four-to-the-floor pulse, crackling vinyl haze, '
			+ 'vast empty stereo space, patient and unresolved',
	},
	heavy5: {
		label: 'HEAVY 5"',
		bpm: [116, 126],
		feel: 'masse, puissance, inertie — la machine doit peser',
		// v2 : la v1 demandait « mechanical percussion, distorted bass », soit
		// le terrain de RACE, en moins rapide — donc un RACE raté. La masse ne
		// se dit pas par la vitesse mais par la LENTEUR : demi-tempo, coups
		// espacés, et le temps que met une chose lourde à s'arrêter. BPM
		// abaissé (120-132 → 116-126) pour la même raison.
		core: 'early-2000s industrial techno at half-time feel, colossal and slow, '
			+ 'enormous slow kick drums with long decay, huge space between hits, '
			+ 'grinding low-end drone underneath, corroded metallic impacts, '
			+ 'the sound of heavy machinery that takes time to stop, '
			+ 'dark, patient and crushing, underground European electronic scene',
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
