// Source de vérité créative de l'arc musical (issue #122). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Le pipeline de génération
// (tools/music-gen.mjs) et le selftest importent ce fichier tel quel.
//
// L'ADN commun de FPVTP! : ÉLECTRONIQUE PRÉ-2005, JOUÉE SUR DU MATÉRIEL.
// Bandes-son analogiques 80s, tribal et goa 90s, electronica, IDM, techno,
// trance, hardcore début 2000.
//
// Cette fenêtre a été élargie vers l'ARRIÈRE (elle disait « fin 90 / début
// 2000 »). Pourquoi vers l'arrière et pas vers l'avant : la règle d'époque
// n'était qu'un proxy, et l'anti-cible est la vraie règle — pas d'EDM de
// festival, pas de musique de bande-annonce. Trois envies exprimées à la
// deuxième écoute (synthwave, hardcore-punk berlinois, tribal sacré) avaient
// chacune un ancêtre AVANT 2005 : les BO analogiques 80s, le digital hardcore
// de 1995-99, le tribal-goa de 1997-2000. Viser l'ancêtre plutôt que le
// revival garde l'unité du jeu sans rien s'interdire.
//
// Ces huit prompts définissent le centre de gravité, PAS huit genres verrouillés :
// buildPrompt() les décale sur six axes pour que deux morceaux d'une même
// famille se ressemblent sans être le même.
//
// Règle de la phase :
//   La musique ne dit pas au joueur quelle catégorie il a reçue.
//   Elle lui en donne une intuition.

import { rngFrom } from './target-build.mjs';

// Les six clés de famille sont celles de src/drone-profiles.js FAMILIES, plus
// deux qui n'y sont pas : `menu`, qui n'est pas un drone mais l'ambiance du
// terminal, et `swarmNode`, la famille délibérément absente de FAMILIES — le
// nœud de commandement d'un essaim, jamais un candidat ordinaire, jamais un
// ambiant, mais bel et bien PILOTÉ (issue #116).
export const MUSIC_POOLS = [
	'menu',
	'freestyle5',
	'race5',
	'cinewhoop',
	'longrange',
	'heavy5',
	'toothpick',
	'swarmNode',
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
		// BPM relevé de 126-138 à 155-172. Le freestyle sert à tenter des
		// tricks — flips, punchouts, murs — et un groove à 130 ne suit pas ça.
		// Le recouvrement avec RACE (142-154) n'est pas un problème malgré la
		// proximité de tempo : RACE est un kick droit, implacable, qui avance ;
		// FREESTYLE est un breakbeat cassé qui s'arrête et repart. Le RYTHME
		// les sépare, pas la vitesse.
		bpm: [155, 172],
		feel: 'polyvalent, nerveux, libre — le son FPV de référence',
		// v3 : « funky and swaggering » était faux d'INTENTION, pas seulement
		// d'exécution. On vise le digital hardcore berlinois de 1995-99,
		// l'ancêtre revendiqué du gabber-punk d'aujourd'hui.
		core: 'late-1990s Berlin digital hardcore, distorted breakbeats at punk intensity, '
			+ 'overdriven chopped drum loops, screaming detuned synth riffs, '
			+ 'abrupt stops and sudden restarts, raw unhinged energy, '
			+ 'sounds like a machine being thrown around and caught, '
			+ 'hardware samplers pushed into clipping',
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
		bpm: [98, 116],
		feel: 'distance, endurance, solitude — regarder le RSSI descendre',
		// v4. Le dub techno a échoué deux fois (1 retenu sur 3), et la v3 a
		// échoué autrement : viser la BO analogique 80s a donné du Carpenter —
		// minimal, lent, menaçant — alors que la synthwave demandée est
		// PUNCHY et GROOVY. Deux choses opposées sous la même étiquette « 80s ».
		//
		// Ce qu'on vise ici est le versant funk de la production 80s : batterie
		// qui claque à grosse réverbe, basse saw grasse, arpège qui roule en
		// doubles-croches, mélodie franche. La route de nuit, mais en roulant
		// vite — pas en attendant quelque chose dans le noir.
		core: '1980s synth-funk and electro production, nocturnal neon highway feeling, '
			+ 'punchy gated drum machine with a big cracking snare on the backbeat, '
			+ 'fat detuned analog saw bassline with groove, '
			+ 'driving sixteenth-note arpeggio rolling through the whole track, '
			+ 'bright confident lead melody, lush chorused pads underneath, '
			+ 'sleek and propulsive, cruising alone at high speed after dark, '
			+ 'vintage polysynth, LinnDrum-style kit and analog chorus character',
	},
	heavy5: {
		label: 'HEAVY 5"',
		bpm: [124, 136],
		feel: 'masse, puissance, inertie — la machine doit peser',
		// v3, et c'est la réécriture la plus profonde. Les v1 et v2 cherchaient
		// la masse dans la techno industrielle, donc dans le vocabulaire de
		// RACE : percussion mécanique, basse saturée. La v3 la cherche dans le
		// SACRÉ — tribal-goa de 1997-2000 — et c'est ce qui règle enfin le
		// recouvrement : la masse ne vient plus de la percussion mais du
		// sub-bass et de l'ESPACE entre les coups.
		//
		// Seul pool à porter des voix, et seulement SANS PAROLES (cf.
		// negativesFor). Un chœur au-dessus d'un groove tribal très lourd :
		// c'est la signature de HEAVY, pas une couleur commune. La Bible §37
		// (« pas de voix ») vise le narrateur et la voix de hacker, pas un
		// chœur traité comme un instrument.
		core: 'late-1990s ceremonial tribal trance, sacred and monumental, '
			+ 'wordless choir soaring high above everything, '
			+ 'enormous spaced tribal drums with long decay, huge silence between hits, '
			+ 'deep physical sub bass you feel in the chest, '
			+ 'tuned metal percussion, hand drums and low ritual horns, '
			+ 'slow ceremonial build releasing into a massive tribal groove, '
			+ 'ancient temple atmosphere, organic instruments against hardware synthesizers',
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
	// La huitième entrée, et la seule qui ne soit pas dans FAMILIES : le nœud de
	// commandement d'un essaim (issue #116). Le vol le plus rare du jeu était
	// aussi le seul à se jouer en silence.
	//
	// La cible a été choisie en écoute comparée, une mécanique d'inquiétude à la
	// fois. Ce qui a été ÉCARTÉ compte autant que ce qui reste :
	//   — le pulse fin et nu de Carpenter, parce qu'il contredit le hoover : la
	//     peur fine et sèche et la peur grasse et désaccordée ne sont pas la
	//     même peur, et un prompt qui demande les deux fait trancher le modèle ;
	//   — la mesure impaire de `Halloween`, juste sur le fond (un motif qui ne
	//     tombe jamais) mais que Stable Audio suit mal ;
	//   — le cluster dissonant, qui est le terrain de `menu` ;
	//   — la sirène industrielle, doublon du hoover.
	//
	// Carpenter reste, mais pour son OSSATURE — ostinato mineur figé sur une
	// pédale de basse immobile — pas pour son timbre. C'est aussi ce qui règle
	// une vieille tension : `longrange` v3 avait produit du Carpenter et l'avait
	// rejeté (trop lent, trop statique), et sa v4 passe son temps à le fuir. Ici
	// il a enfin une maison.
	swarmNode: {
		label: 'SWARM NODE',
		// Le nœud est une machine lourde qui porte son élan. Descendre le centre
		// le sépare de RACE (142-154) par le TEMPO en plus du timbre. Le
		// recouvrement qui reste est celui de MICRO (132-144), où aucune
		// confusion n'est possible : trance claire et euphorique d'un côté,
		// techno sèche en mineur de l'autre.
		bpm: [132, 142],
		feel: 'menace qui avance, motif qui ne lâche pas, une masse qui se rapproche',
		// « dry close-miked, almost no reverb » n'est pas un détail de
		// production : c'est ce qui sépare ce pool de HEAVY, entièrement bâti
		// sur les longues décroissances et l'espace du temple.
		//
		// L'ATTAQUE IMMÉDIATE est une contrainte de jeu, pas un goût. Ce morceau
		// démarre au DROP, à la fin du hack, là où il faut de l'impact — une
		// mise en place de vingt secondes y est rédhibitoire. La v1 disait
		// « slowly swelling sub bass growing under everything » : une
		// instruction de montée, et les trois morceaux mettaient trop longtemps
		// à se poser. Le sub reste, mais présent d'emblée.
		//
		// Le rognage de tête de music-loop.mjs ne sauve pas : il ne coupe que le
		// SILENCE mesuré, pas une intro douce.
		core: 'dark industrial hard techno with an early-1980s horror-score motif on top, '
			+ 'starts immediately in full flow, the groove already running from the first bar, '
			+ 'no intro, no build-up, no gradual fade-in, '
			+ 'hard mechanical four-to-the-floor kick leading the whole track, '
			+ 'obsessive four-note minor ostinato repeating without variation over a static bass pedal, '
			+ 'fat detuned screaming hoover lead used as a recurring alarm, '
			+ 'constant deep sub bass pressure underneath, never letting go, '
			+ 'dry close-miked production with almost no reverb, everything pressed against the ear, '
			+ 'stalking and relentless, something large closing in formation, '
			+ 'vintage analog sequencers, cold polysynth and overdriven drum machines',
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

// Valeurs d'axe qu'un pool ne doit JAMAIS recevoir, parce qu'elles nient un mot
// déjà présent dans son noyau. Sans ce garde-fou le tirage produit des prompts
// qui se contredisent — « raw unhinged energy at punk intensity » suivi de
// « restrained and patient » — et le modèle tranche alors tout seul, en général
// vers le plus mou.
//
// C'est un garde-fou de cohérence, pas un réglage de goût : on n'interdit que
// ce qui contredit un mot ÉCRIT dans le noyau. Une valeur bannie est remplacée
// par l'option neutre, jamais par une autre — le tirage reste déterministe.
export const POOL_AXIS_BANS = {
	freestyle5: {
		energy: ['restrained and patient'],        // vs « punk intensity »
		aggression: ['smooth and rounded'],        // vs « pushed into clipping »
		atmosphere: ['hypnotic and repetitive'],   // vs « abrupt stops and sudden restarts »
	},
	race5: {
		energy: ['restrained and patient'],        // vs « extremely energetic »
		aggression: ['smooth and rounded'],        // vs « aggressive, distorted »
	},
	heavy5: {
		energy: ['restrained and patient'],        // vs « monumental »
		aggression: ['smooth and rounded'],        // vs « enormous », « massive »
		// Le grain tracker jure avec le temple : HEAVY est organique.
		grain: ['gritty digital samplers, early tracker character'],
	},
	swarmNode: {
		// Le mode d'échec documenté de `longrange` v3 : un noyau d'horreur plus
		// un axe qui retient donne du statique, et le statique n'inquiète pas —
		// il endort. Le noyau dit « leading », « relentless ».
		energy: ['restrained and patient'],
		// Le SEUL bannissement de cet axe du fichier, et le plus important :
		// éclaircir ce pool l'annule. Tout le reste — l'ostinato, le hoover, le
		// sub qui monte — ne vaut que sombre.
		darkness: ['brighter and more open'],
		aggression: ['smooth and rounded'],        // vs « screaming », « overdriven »
		// Même leçon que `menu`, pour une raison différente : ici « sparse »
		// contredit « already running from the first bar » et rend un morceau
		// qui s'installe au lieu de frapper. Le tirage qui l'avait reçu était
		// le plus faible du premier lot de 5,6 dB.
		density: ['sparse arrangement, lots of space'],
		// Même raison que heavy5 : le grain tracker jure avec « vintage analog
		// sequencers ».
		grain: ['gritty digital samplers, early tracker character'],
		// `atmosphere: 'hypnotic and repetitive'` reste AUTORISÉ et souhaité :
		// c'est la définition de l'ostinato, pas une contradiction.
	},
	menu: {
		// Les DEUX extrêmes, et c'est le second qui a mordu à l'écoute.
		// Le noyau dit déjà « sparse minimal percussion, patient and watchful » ;
		// quand un axe ajoute encore « restrained » ou « sparse, lots of space »,
		// le prompt ne demande plus rien et le modèle rend du vide — trois
		// tirages consécutifs à 6, 15 et 36 % de fenêtres silencieuses, décrits
		// à l'écoute comme « y a même pas de musique ». Les trois morceaux de
		// menu qui MARCHENT ont reçu « dense layered arrangement », « harsh
		// distorted edges » et « hypnotic and repetitive » : ce pool a besoin
		// qu'on lui donne de la matière, pas qu'on lui en retire.
		energy: ['relentless and driving', 'restrained and patient'],
		density: ['sparse arrangement, lots of space'],
	},
};

// La clôture du genre : toujours présente, jamais variée, et le selftest
// vérifie qu'aucun prompt ne sort sans.
//
// C'est l'ANTI-CIBLE qui tient l'identité, pas la fenêtre d'époque. Un morceau
// peut venir de 1984 ou de 2003 ; ce qu'il ne doit jamais être, c'est de l'EDM
// de festival ou de la musique de bande-annonce.
export const NEGATIVES_COMMON = 'no festival EDM, no modern EDM drop, no cinematic trailer music';

// Sept pools sur huit sont strictement instrumentaux.
export const NO_VOICE = 'instrumental, no vocals';

// HEAVY est la seule exception, et elle est étroite : un chœur traité comme un
// instrument. Ce qui reste interdit — paroles, couplet/refrain, parole
// dite — est ce que vise réellement la Bible §37, et c'est aussi ce qui
// transformerait un morceau en chanson.
export const WORDLESS_VOICE = 'wordless choral voices only, no lyrics, no words, '
	+ 'no spoken word, no rapping, no verse or chorus structure';

export const POOL_VOICE = { heavy5: WORDLESS_VOICE };

/** La clôture applicable à un pool. */
export function negativesFor(pool) {
	return `${POOL_VOICE[pool] ?? NO_VOICE}, ${NEGATIVES_COMMON}`;
}

// Nombre d'axes (hors `grain`, toujours tiré) qu'un morceau reçoit. Deux, pas
// six : au-delà le prompt se contredit et Stable Audio rend de la bouillie.
export const AXES_PER_TRACK = 2;

const AXIS_POOL = AXIS_NAMES.filter((k) => k !== 'grain');

/** La valeur est-elle interdite pour ce pool ? */
function banned(pool, axis, value) {
	return !!value && (POOL_AXIS_BANS[pool]?.[axis] ?? []).includes(value);
}

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
		let value = options[Math.floor(rand() * options.length)];
		// Le tirage est consommé DANS TOUS LES CAS avant le remplacement, pour
		// qu'ajouter un bannissement ne décale pas les morceaux déjà générés
		// des autres pools.
		if (banned(pool, name, value)) value = null;
		axes[name] = value;
		if (value) fragments.push(value);
	}
	// Le grain est le seul axe toujours présent : s'il est banni on reprend le
	// suivant dans la liste plutôt que de laisser le morceau sans ancrage
	// matériel, qui est ce qui tient l'ADN.
	let grain = AXES.grain[Math.floor(rand() * AXES.grain.length)];
	if (banned(pool, 'grain', grain)) {
		grain = AXES.grain.find((g) => !banned(pool, 'grain', g)) ?? grain;
	}
	axes.grain = grain;
	fragments.push(grain);

	const prompt = [`${spec.core}`, `${bpm} BPM`, ...fragments, negativesFor(pool)].join(', ');
	return { pool, bpm, prompt, axes };
}
