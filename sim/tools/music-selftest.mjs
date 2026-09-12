// node tools/music-selftest.mjs
//
// Couvre le modèle PUR de l'arc musical : sélection, intensité, prompts,
// manifeste, bouclage. Rien ici ne touche Web Audio, le DOM ni le GPU — ce qui
// s'écoute se vérifie à l'oreille, pas ici.

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	MUSIC_SCHEMA_VERSION, MUSIC_POOLS, INTENSITY, PHASE_INTENSITY, FADE, DUCK, FLIGHT,
	intensityParams, flightIntensity, pickTrack, pushRecent, validateManifest,
	poolForFamily, RECENT_LIMIT, INTENSITY_TAU,
} from './music-model.mjs';
import {
	POOLS, AXES, AXIS_NAMES, AXES_PER_TRACK, buildPrompt, negativesFor,
	NEGATIVES_COMMON, NO_VOICE, WORDLESS_VOICE, POOL_VOICE, POOL_AXIS_BANS,
} from './music-prompts.mjs';
import { planFor, trackId, DEFAULTS, suggestSeedBase } from './music-gen.mjs';
import { partition } from './music-retire.mjs';
import { loopFilter, loudnormMeasureFilter, loudnormApplyFilter, TARGET_LUFS, TARGET_PEAK_DBFS, TARGET_LRA, CROSSFADE_S } from './music-loop.mjs';
import { judge, BOUNDS } from './music-gate.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

const SIM = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// --- pools et familles ------------------------------------------------------

test('chaque famille de drone a son pool, et les deux pools hors FAMILIES sont connus', () => {
	for (const f of FAMILIES) {
		assert.ok(MUSIC_POOLS.includes(f), `famille ${f} sans pool musical`);
		assert.equal(poolForFamily(f), f);
	}
	// Deux pools ne sont pas dans FAMILIES, pour deux raisons opposées : `menu`
	// n'est pas un drone du tout, et `swarmNode` en est un qui se PILOTE mais
	// que FAMILIES exclut volontairement (jamais un candidat de scan ordinaire,
	// jamais un ambiant — src/drone-profiles.js). L'ordre suit MUSIC_POOLS.
	assert.deepEqual(MUSIC_POOLS.filter((p) => !FAMILIES.includes(p)), ['menu', 'swarmNode']);
	// Et celui-là, contrairement à `menu`, DOIT rendre un pool.
	assert.equal(poolForFamily('swarmNode'), 'swarmNode');
});

test('menu n\'est pas un pool de drone', () => {
	assert.equal(poolForFamily('menu'), null);
	assert.equal(poolForFamily('inconnu'), null);
});

test('chaque pool a un noyau, une fourchette de BPM et une sensation', () => {
	for (const p of MUSIC_POOLS) {
		const spec = POOLS[p];
		assert.ok(spec, `pool ${p} sans spec`);
		assert.ok(spec.core.length > 40, `${p} : noyau trop court`);
		assert.ok(spec.feel.length > 5, `${p} : sensation manquante`);
		assert.ok(spec.bpm[0] < spec.bpm[1], `${p} : fourchette de BPM vide`);
	}
});

// --- prompts ----------------------------------------------------------------

test('buildPrompt est déterministe', () => {
	const a = buildPrompt('race5', 'seed-a');
	const b = buildPrompt('race5', 'seed-a');
	assert.deepEqual(a, b);
});

test('deux seeds donnent des prompts différents', () => {
	const seen = new Set();
	for (let i = 0; i < 30; i++) seen.add(buildPrompt('race5', `s${i}`).prompt);
	assert.ok(seen.size > 15, `trop peu de variété : ${seen.size}/30`);
});

test('le BPM reste dans la fourchette de la famille', () => {
	for (const p of MUSIC_POOLS) {
		const [lo, hi] = POOLS[p].bpm;
		for (let i = 0; i < 40; i++) {
			const { bpm } = buildPrompt(p, `s${i}`);
			assert.ok(bpm >= lo && bpm <= hi, `${p} : ${bpm} hors [${lo},${hi}]`);
		}
	}
});

test('tout prompt porte la clôture de genre et son BPM', () => {
	for (const p of MUSIC_POOLS) {
		const { prompt, bpm } = buildPrompt(p, 'x');
		assert.ok(prompt.includes(negativesFor(p)), `${p} : négatifs absents`);
		assert.ok(prompt.includes(NEGATIVES_COMMON), `${p} : anti-cible absente`);
		assert.ok(prompt.includes(`${bpm} BPM`), `${p} : BPM absent du prompt`);
	}
});

test('HEAVY est le SEUL pool à porter des voix, et seulement sans paroles', () => {
	assert.deepEqual(Object.keys(POOL_VOICE), ['heavy5'],
		'la voix est la signature de HEAVY, pas une couleur commune');
	for (const p of MUSIC_POOLS) {
		const { prompt } = buildPrompt(p, 'x');
		if (p === 'heavy5') {
			assert.ok(prompt.includes(WORDLESS_VOICE), 'heavy5 : clôture de voix absente');
			assert.ok(!prompt.includes(NO_VOICE), 'heavy5 : interdit les voix qu\'il demande');
		} else {
			assert.ok(prompt.includes(NO_VOICE), `${p} : devrait être strictement instrumental`);
		}
	}
});

test('même avec voix, aucun prompt ne peut devenir une chanson', () => {
	// Ce que la Bible §37 vise réellement : le narrateur, la voix de hacker, la
	// parole. Un chœur traité comme un instrument n'est pas ça — mais des
	// paroles, si.
	for (const p of MUSIC_POOLS) {
		const { prompt } = buildPrompt(p, 'x');
		for (const forbidden of ['no lyrics', 'no spoken word']) {
			const covered = prompt.includes(forbidden) || prompt.includes(NO_VOICE);
			assert.ok(covered, `${p} : rien n'interdit « ${forbidden.slice(3)} »`);
		}
	}
});

test('aucun prompt ne se contredit lui-même', () => {
	// Le défaut qui a motivé POOL_AXIS_BANS : un noyau à « punk intensity »
	// recevait « restrained and patient », et le modèle tranchait tout seul —
	// vers le plus mou. Un prompt qui se contredit est un prompt qui ne demande
	// plus rien.
	for (const pool of MUSIC_POOLS) {
		const bans = POOL_AXIS_BANS[pool] ?? {};
		for (let i = 0; i < 300; i++) {
			const { axes, prompt } = buildPrompt(pool, `s${i}`);
			for (const [axis, values] of Object.entries(bans)) {
				assert.ok(!values.includes(axes[axis]),
					`${pool} : « ${axes[axis]} » contredit son noyau`);
				for (const v of values) {
					assert.ok(!prompt.includes(v), `${pool} : « ${v} » a fui dans le prompt`);
				}
			}
		}
	}
});

test('le grain matériel survit à un bannissement', () => {
	// Le grain est le seul axe toujours présent : c'est lui qui tient l'ancrage
	// « joué sur du matériel », donc l'ADN. Le bannir ne doit pas le supprimer.
	for (const pool of MUSIC_POOLS) {
		for (let i = 0; i < 50; i++) {
			const { axes } = buildPrompt(pool, `g${i}`);
			assert.ok(axes.grain, `${pool} : morceau sans ancrage matériel`);
			assert.ok(AXES.grain.includes(axes.grain), `${pool} : grain hors vocabulaire`);
			assert.ok(!(POOL_AXIS_BANS[pool]?.grain ?? []).includes(axes.grain),
				`${pool} : grain banni retenu`);
		}
	}
});

test('on ne bannit que ce qui existe dans le vocabulaire des axes', () => {
	// Une faute de frappe dans POOL_AXIS_BANS serait un bannissement muet : la
	// valeur contradictoire continuerait de sortir sans que rien ne le dise.
	for (const [pool, bans] of Object.entries(POOL_AXIS_BANS)) {
		assert.ok(MUSIC_POOLS.includes(pool), `bannissement pour un pool inconnu : ${pool}`);
		for (const [axis, values] of Object.entries(bans)) {
			assert.ok(AXES[axis], `${pool} : axe inconnu « ${axis} »`);
			for (const v of values) {
				assert.ok(AXES[axis].includes(v), `${pool}.${axis} : « ${v} » n'est pas une valeur de cet axe`);
			}
		}
	}
});

test('aucun prompt ne contient de terme hors ADN', () => {
	// Le prompt DIT « no modern EDM drop » ; ce qu'on interdit ici, c'est de le
	// demander en positif.
	const banned = ['orchestral', 'cinematic score', 'dubstep', 'future bass', 'hip hop', 'rock band'];
	for (const p of MUSIC_POOLS) {
		for (let i = 0; i < 20; i++) {
			const { prompt } = buildPrompt(p, `s${i}`);
			const head = prompt.slice(0, prompt.indexOf(negativesFor(p)));
			for (const b of banned) assert.ok(!head.includes(b), `${p} : « ${b} » dans le prompt`);
		}
	}
});

test('un morceau reçoit AXES_PER_TRACK axes plus le grain', () => {
	const { axes } = buildPrompt('cinewhoop', 'x');
	assert.equal(Object.keys(axes).length, AXES_PER_TRACK + 1);
	assert.ok(axes.grain, 'le grain est toujours tiré');
	assert.ok(AXES.grain.includes(axes.grain));
});

test('chaque axe propose une option neutre sauf le grain', () => {
	for (const name of AXIS_NAMES) {
		if (name === 'grain') { assert.ok(!AXES[name].includes(null)); continue; }
		assert.ok(AXES[name].includes(null), `${name} : pas d'option neutre`);
	}
});

// Mots trop communs pour dire quoi que ce soit d'une identité musicale.
const STOP = new Set(('and the of a an with in to that at more than into over under '
	+ 'early late 2000s 1990s music musical sound like its it is are be').split(' '));

const contentWords = (core) => new Set(core.toLowerCase()
	.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
	.filter((w) => w.length > 3 && !STOP.has(w)));

// Seuil réglé sur la mesure, pas au jugé. Le couple le plus proche après la
// réécriture v2 est race5 ↔ toothpick à 0,149 — et ces deux-là sont, à
// l'écoute, les plus reconnaissables de la bibliothèque : leurs mots communs
// (« energetic », « percussion », « underground ») sont génériques, pas
// identitaires. 0,16 laisse donc passer ce qui marche et attrape la
// régression : avant la v2, race5 ↔ heavy5 était à 0,190 en partageant
// « mechanical percussion kick distorted bass », et heavy5 sonnait comme un
// race5 raté.
const MAX_CORE_OVERLAP = 0.16;

test('deux pools ne se marchent pas dessus', () => {
	// Attention à ce que ce test prouve : le recouvrement lexical est un
	// détecteur d'odeur, pas un verdict. Deux prompts disjoints peuvent rendre
	// deux morceaux jumeaux, et seule l'oreille tranche (music-review). Ce
	// qu'il attrape, lui, c'est le cas où l'on a ÉCRIT deux fois la même
	// famille — ce qui est arrivé.
	const pools = Object.keys(POOLS);
	for (let i = 0; i < pools.length; i++) {
		for (let j = i + 1; j < pools.length; j++) {
			const a = contentWords(POOLS[pools[i]].core);
			const b = contentWords(POOLS[pools[j]].core);
			const shared = [...a].filter((w) => b.has(w));
			const overlap = shared.length / new Set([...a, ...b]).size;
			assert.ok(overlap <= MAX_CORE_OVERLAP,
				`${pools[i]} ↔ ${pools[j]} : ${overlap.toFixed(3)} de recouvrement [${shared.join(' ')}]`);
		}
	}
});

test('aucun noyau ne recule sur trois adjectifs à la fois', () => {
	// La v1 de cinewhoop disait « subtle », « gentle » et « restrained » dans
	// la même phrase : rien ne s'engageait, et c'est le pool qui a le moins
	// convaincu à la première écoute. Un hedge va bien (le « slightly strange »
	// de MICRO est une torsion, pas un recul) ; trois, c'est un prompt qui
	// n'ose rien demander.
	const hedges = ['subtle', 'gentle', 'restrained', 'slightly', 'somewhat', 'mild', 'soft'];
	for (const p of Object.keys(POOLS)) {
		const core = POOLS[p].core.toLowerCase();
		const found = hedges.filter((h) => core.includes(h));
		assert.ok(found.length < 3, `${p} : ${found.length} adjectifs qui reculent [${found.join(' ')}]`);
	}
});

test('un pool inconnu échoue franchement', () => {
	assert.throws(() => buildPrompt('nope', 'x'), /pool inconnu/);
});

// --- intensité --------------------------------------------------------------

test('intensityParams est borné aux extrémités', () => {
	assert.equal(intensityParams(0).cutoffHz, INTENSITY.cutoffHz[0]);
	assert.equal(intensityParams(1).cutoffHz, INTENSITY.cutoffHz[1]);
	assert.equal(intensityParams(1).gain, 1);
	assert.ok(Math.abs(intensityParams(0).gain - Math.pow(10, INTENSITY.gainDb[0] / 20)) < 1e-9);
});

test('intensityParams sature hors de [0,1] au lieu de diverger', () => {
	assert.deepEqual(intensityParams(-5), intensityParams(0));
	assert.deepEqual(intensityParams(9), intensityParams(1));
});

test('intensityParams ne rend jamais NaN', () => {
	for (const bad of [NaN, undefined, null, 'x', Infinity]) {
		const { cutoffHz, gain } = intensityParams(bad);
		assert.ok(Number.isFinite(cutoffHz) && Number.isFinite(gain), `NaN sur ${bad}`);
	}
});

test('intensityParams est strictement croissant', () => {
	let prevC = -1; let prevG = -1;
	for (let k = 0; k <= 1.0001; k += 0.05) {
		const { cutoffHz, gain } = intensityParams(k);
		assert.ok(cutoffHz > prevC, `coupure non croissante à k=${k}`);
		assert.ok(gain > prevG, `gain non croissant à k=${k}`);
		prevC = cutoffHz; prevG = gain;
	}
});

test('le HACK est bien « la pièce d\'à côté » et le DROP est plein', () => {
	assert.ok(PHASE_INTENSITY.HACK < PHASE_INTENSITY.MENU, 'le hack doit être plus sourd que le menu');
	assert.ok(PHASE_INTENSITY.MENU < PHASE_INTENSITY.DROP);
	assert.equal(PHASE_INTENSITY.DROP, 1);
	// À l'intensité du hack, la coupure doit rester basse : sinon on n'entend
	// pas une musique lointaine, on entend une musique moins forte. Relevée à
	// 1,2 kHz avec HACK (issue retour terrain : le hack était inaudible) — la
	// borne monte avec elle, mais reste loin des ~19 kHz du plein volume.
	assert.ok(intensityParams(PHASE_INTENSITY.HACK).cutoffHz < 1200);
});

test('le plancher de vol laisse la musique VRAIMENT présente', () => {
	assert.ok(PHASE_INTENSITY.FLOOR > PHASE_INTENSITY.HACK);
	// Le plancher n'est pas une valeur de confort : c'est la garantie qu'un
	// geste de pilotage normal ne fait pas disparaître la musique. À 0,30 elle
	// tombait à -14 dB derrière une coupure à 1,2 kHz, ce qui s'entendait comme
	// une extinction.
	const p = intensityParams(PHASE_INTENSITY.FLOOR);
	assert.ok(20 * Math.log10(p.gain) > -9, `plancher à ${(20 * Math.log10(p.gain)).toFixed(1)} dB, trop bas`);
	assert.ok(p.cutoffHz > 3000, `plancher à ${Math.round(p.cutoffHz)} Hz, trop sourd`);
	// Mais il reste un arc : le plein doit rester nettement au-dessus.
	assert.ok(PHASE_INTENSITY.FLOOR < 0.8, 'un plancher trop haut annule l\'arc');
});

test('couper les gaz ne coupe pas la musique', () => {
	// En FPV on coupe les gaz sans arrêt — punch, chop, dive, coast. C'est le
	// geste le plus courant du pilotage, et il ne doit pas ducker la musique.
	for (const speedMs of [5, 15, 25]) {
		const plein = flightIntensity({ throttle: 1, speedMs });
		const coupe = flightIntensity({ throttle: 0, speedMs });
		const dbPlein = 20 * Math.log10(intensityParams(plein).gain);
		const dbCoupe = 20 * Math.log10(intensityParams(coupe).gain);
		assert.ok(dbPlein - dbCoupe < 2.5,
			`à ${speedMs} m/s, couper les gaz retire ${(dbPlein - dbCoupe).toFixed(1)} dB`);
	}
});

test('la vitesse pèse nettement plus que le manche', () => {
	// Le manche est nerveux, la vitesse a de l'inertie. Un rapport trop
	// équilibré rend la musique sensible à un geste qui ne change rien à ce que
	// le pilote ressent.
	assert.ok(FLIGHT.wSpeed >= 3 * FLIGHT.wThrottle,
		`rapport ${(FLIGHT.wSpeed / FLIGHT.wThrottle).toFixed(1)}, le manche pèse trop`);
});

test('le lissage est asymétrique : monter vite, redescendre lentement', () => {
	// Le vrai remède aux coupures de gaz. Une coupure dure une demi-seconde,
	// une accalmie dure dix secondes ; avec une constante unique les deux se
	// ressemblent.
	assert.ok(INTENSITY_TAU.fall > 4 * INTENSITY_TAU.rise,
		`descente ${INTENSITY_TAU.fall} s contre montée ${INTENSITY_TAU.rise} s : pas assez asymétrique`);
	// Un chop d'une demi-seconde ne doit parcourir qu'une fraction du chemin.
	const parcouru = 1 - Math.exp(-0.5 / INTENSITY_TAU.fall);
	assert.ok(parcouru < 0.35, `un chop de 0,5 s parcourt ${(parcouru * 100).toFixed(0)} % de la descente`);
	// Mais un rush doit s'entendre tout de suite.
	assert.ok(1 - Math.exp(-0.5 / INTENSITY_TAU.rise) > 0.8, 'la montée est trop lente pour un rush');
});

test('flightIntensity reste dans [FLOOR, 1]', () => {
	const cases = [
		{}, { throttle: 0, speedMs: 0 }, { throttle: 1, speedMs: 1000 },
		{ throttle: -3, speedMs: -12 }, { throttle: NaN, speedMs: NaN },
		{ throttle: Infinity, speedMs: Infinity }, { throttle: null, speedMs: undefined },
	];
	for (const c of cases) {
		const k = flightIntensity(c);
		assert.ok(Number.isFinite(k), `NaN sur ${JSON.stringify(c)}`);
		assert.ok(k >= PHASE_INTENSITY.FLOOR - 1e-9 && k <= 1 + 1e-9, `${k} hors bornes sur ${JSON.stringify(c)}`);
	}
});

test('désarmé, la musique attend au plancher', () => {
	assert.equal(flightIntensity({ throttle: 1, speedMs: 40, armed: false }), PHASE_INTENSITY.FLOOR);
});

test('un rush est plus intense qu\'un stationnaire', () => {
	const hover = flightIntensity({ throttle: 0.45, speedMs: 0.5 });
	const rush = flightIntensity({ throttle: 0.95, speedMs: 28 });
	// La plage est plus étroite depuis que le plancher est haut, mais l'arc doit
	// rester franc : au moins 4 dB entre un stationnaire et un rush.
	const dbHover = 20 * Math.log10(intensityParams(hover).gain);
	const dbRush = 20 * Math.log10(intensityParams(rush).gain);
	assert.ok(dbRush - dbHover > 4, `arc trop plat : ${(dbRush - dbHover).toFixed(1)} dB`);
});

test('la vitesse pèse plus que le manche', () => {
	// C'est ce que le joueur SUBIT qui porte l'intensité, pas ce qu'il fait :
	// plein gaz dans un mur ne doit pas sonner comme un rush.
	assert.ok(FLIGHT.wSpeed > FLIGHT.wThrottle);
	assert.ok(Math.abs(FLIGHT.wSpeed + FLIGHT.wThrottle - 1) < 1e-9, 'les poids doivent sommer à 1');
});

test('le rituel duck la musique sans la faire taire', () => {
	assert.ok(DUCK.ritual > 0 && DUCK.ritual < 1);
	assert.ok(DUCK.ms > 0);
});

test('les durées de transition sont ordonnées comme la mise en scène', () => {
	// Le crash coupe net, l'entrée en scène est un geste.
	assert.ok(FADE.kill < FADE.drop, 'le crash doit couper plus court que le drop');
	assert.ok(FADE.drop < FADE.menuToHack);
});

// --- sélection --------------------------------------------------------------

const fakeManifest = {
	schemaVersion: MUSIC_SCHEMA_VERSION,
	tracks: ['a', 'b', 'c', 'd'].map((s) => ({
		id: `race5-${s}`, pool: 'race5', file: `music/race5/race5-${s}.opus`, durS: 87, bpm: 148,
	})).concat([{ id: 'menu-a', pool: 'menu', file: 'music/menu/menu-a.opus', durS: 90, bpm: 90 }]),
};

test('pickTrack est déterministe sur une même seed', () => {
	const a = pickTrack(fakeManifest, 'race5', 'seed::0');
	const b = pickTrack(fakeManifest, 'race5', 'seed::0');
	assert.equal(a.id, b.id);
});

test('pickTrack ne sort jamais du pool demandé', () => {
	for (let i = 0; i < 50; i++) {
		assert.equal(pickTrack(fakeManifest, 'race5', `s${i}`).pool, 'race5');
	}
});

test('pickTrack écarte les morceaux récents', () => {
	const recent = ['race5-a', 'race5-b', 'race5-c'];
	for (let i = 0; i < 50; i++) {
		assert.equal(pickTrack(fakeManifest, 'race5', `s${i}`, recent).id, 'race5-d');
	}
});

test('un pool entièrement récent rejoue plutôt que de rendre le silence', () => {
	const all = fakeManifest.tracks.filter((t) => t.pool === 'race5').map((t) => t.id);
	const t = pickTrack(fakeManifest, 'race5', 'x', all);
	assert.ok(t && all.includes(t.id));
});

test('un pool vide rend null, pas une exception', () => {
	assert.equal(pickTrack(fakeManifest, 'cinewhoop', 'x'), null);
	assert.equal(pickTrack({ tracks: [] }, 'race5', 'x'), null);
	assert.equal(pickTrack(null, 'race5', 'x'), null);
	assert.equal(pickTrack(undefined, 'race5', 'x'), null);
});

test('pushRecent met en tête, dédoublonne et borne', () => {
	let r = [];
	for (let i = 0; i < RECENT_LIMIT + 8; i++) r = pushRecent(r, `t${i}`);
	assert.equal(r.length, RECENT_LIMIT);
	assert.equal(r[0], `t${RECENT_LIMIT + 7}`);
	const again = pushRecent(r, r[3]);
	assert.equal(again[0], r[3]);
	assert.equal(new Set(again).size, again.length, 'doublon dans les récents');
});

test('pushRecent supporte un id absent', () => {
	assert.deepEqual(pushRecent(['a'], null), ['a']);
});

// --- manifeste --------------------------------------------------------------

test('le manifeste factice est valide', () => {
	assert.deepEqual(validateManifest(fakeManifest), []);
});

test('validateManifest refuse ce qui rendrait le jeu muet en silence', () => {
	const bad = (m) => validateManifest(m).length > 0;
	assert.ok(bad(null));
	assert.ok(bad({ schemaVersion: 99, tracks: [] }));
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: 'nope' }));
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'race5', file: 'f', bpm: 1 }] }), 'durS manquant');
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'nope', file: 'f', durS: 1, bpm: 1 }] }), 'pool inconnu');
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'race5', file: 'f', durS: 0, bpm: 1 }] }), 'durée nulle');
});

test('validateManifest attrape les doublons d\'id et de fichier', () => {
	const dup = (tracks) => validateManifest({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks });
	const t = { pool: 'race5', durS: 1, bpm: 1 };
	assert.ok(dup([{ ...t, id: 'a', file: 'f1' }, { ...t, id: 'a', file: 'f2' }]).some((p) => /id dupliqué/.test(p)));
	assert.ok(dup([{ ...t, id: 'a', file: 'f' }, { ...t, id: 'b', file: 'f' }]).some((p) => /file dupliqué/.test(p)));
});

test('le manifeste livré, s\'il existe, est valide et pointe vers des fichiers présents', () => {
	const p = join(SIM, 'public/music.json');
	if (!existsSync(p)) return; // avant la première vague, il n'y a rien à valider
	const m = JSON.parse(readFileSync(p, 'utf8'));
	assert.deepEqual(validateManifest(m), []);
	for (const t of m.tracks) {
		assert.ok(existsSync(join(SIM, 'public', t.file)), `fichier absent : ${t.file}`);
	}
});

// --- pipeline ---------------------------------------------------------------

test('trackId est stable et sépare bien les voisins', () => {
	assert.equal(trackId('race5', 'v1', 0), trackId('race5', 'v1', 0));
	const ids = [];
	for (let i = 0; i < 200; i++) ids.push(trackId('race5', 'v1', i));
	assert.equal(new Set(ids).size, 200, 'collision d\'id');
	// Le point de l'avalanche : deux index consécutifs ne doivent pas donner
	// deux ids qui se ressemblent, sinon la revue à l'oreille se trompe de ligne.
	assert.notEqual(ids[0].slice(-8, -4), ids[1].slice(-8, -4));
});

test('planFor produit un plan complet et reproductible', () => {
	const a = planFor({ pool: 'heavy5', count: 4, seedBase: 'v1', duration: 90 });
	const b = planFor({ pool: 'heavy5', count: 4, seedBase: 'v1', duration: 90 });
	assert.deepEqual(a.map((j) => j.id), b.map((j) => j.id));
	assert.equal(a.length, 4);
	for (const j of a) {
		assert.equal(j.pool, 'heavy5');
		assert.equal(j.durationS, 90);
		assert.ok(Number.isInteger(j.modelSeed) && j.modelSeed >= 0, 'la seed du modèle doit être un entier positif');
		assert.ok(j.prompt.includes(negativesFor(j.pool)));
		assert.ok(j.out.endsWith(`${j.id}.wav`));
	}
});

test('loopFilter découpe en tête/corps/queue et recolle les deux jonctions', () => {
	const f = loopFilter({ startS: 0, endS: 90, crossfadeS: 3 });
	assert.ok(f.includes('atrim=0:3'), 'tête');
	assert.ok(f.includes('atrim=87:90'), 'queue');
	assert.ok(f.includes('atrim=3:87'), 'corps');
	assert.ok(f.includes('[tail][head]acrossfade=d=3'), 'la queue se fond DANS la tête, pas l\'inverse');
	assert.ok(f.indexOf('[joint][body]concat') > f.indexOf('acrossfade'), 'le raccord précède le corps');
});

test('loopFilter tient compte du silence de tête coupé', () => {
	const f = loopFilter({ startS: 1.2, endS: 88, crossfadeS: 3 });
	assert.ok(f.includes('atrim=1.2:4.2'));
	assert.ok(f.includes('atrim=85:88'));
});

test('loopFilter refuse un segment trop court pour son recouvrement', () => {
	assert.throws(() => loopFilter({ startS: 0, endS: 6, crossfadeS: 3 }), /trop court/);
});

test('la première passe demande bien une mesure', () => {
	const f = loudnormMeasureFilter();
	assert.ok(f.startsWith('loudnorm='));
	assert.ok(f.includes(`I=${TARGET_LUFS}`));
	assert.ok(f.includes(`TP=${TARGET_PEAK_DBFS}`));
	assert.ok(f.includes('print_format=json'), 'sans JSON, la seconde passe n\'a rien à lire');
	assert.ok(!f.includes('measured_'), 'la première passe ne connaît encore rien');
});

const measured = {
	input_i: '-15.80', input_tp: '0.30', input_lra: '9.10',
	input_thresh: '-26.10', target_offset: '-0.40',
};

test('la seconde passe reporte TOUTES les mesures et reste linéaire', () => {
	const f = loudnormApplyFilter(measured);
	for (const [key, value] of [
		['measured_I', measured.input_i], ['measured_TP', measured.input_tp],
		['measured_LRA', measured.input_lra], ['measured_thresh', measured.input_thresh],
		['offset', measured.target_offset],
	]) {
		assert.ok(f.includes(`${key}=${value}`), `${key} absent de la seconde passe`);
	}
	// Sans linear=true, loudnorm compresse la dynamique au lieu de se contenter
	// d'un gain statique quand un gain statique suffit.
	assert.ok(f.includes('linear=true'));
	assert.ok(f.includes(`I=${TARGET_LUFS}`) && f.includes(`TP=${TARGET_PEAK_DBFS}`) && f.includes(`LRA=${TARGET_LRA}`));
});

test('une mesure incomplète échoue au lieu de normaliser à une passe', () => {
	// Le piège silencieux : loudnorm accepte un filtre sans measured_*, et rend
	// alors une normalisation à une passe — donc une bibliothèque qui s'étale.
	for (const missing of Object.keys(measured)) {
		const partial = { ...measured };
		delete partial[missing];
		assert.throws(() => loudnormApplyFilter(partial), /mesure loudnorm incomplète/, `${missing} manquant non détecté`);
	}
	assert.throws(() => loudnormApplyFilter(null), /incomplète/);
	assert.throws(() => loudnormApplyFilter({ ...measured, input_tp: 'nan' }), /incomplète/);
});

test('la cible de crête laisse de la marge sous 0 dBFS', () => {
	assert.ok(TARGET_PEAK_DBFS < 0, 'Opus peut dépasser à la décompression');
	assert.ok(TARGET_LRA > 0);
});

test('le recouvrement de boucle est audible mais court', () => {
	assert.ok(CROSSFADE_S >= 1 && CROSSFADE_S <= 6);
});

test('le gate attrape un morceau VIDE, pas seulement un morceau plat', () => {
	// Le trou qui a laissé passer trois tirages de menu décrits comme « y a même
	// pas de musique ». L'écart RMS ne suffit pas : un morceau très dynamique a
	// lui aussi un grand écart. Ce qui distingue le vide, c'est la PROPORTION du
	// morceau passée sous la médiane.
	const t = { durationS: 90, lufs: -14, truePeak: 0, headSilenceS: 0, tailSilenceS: 1, rmsSpreadDb: 20, sideDb: -14 };
	// Mesures réelles des trois tirages ratés.
	for (const silentFraction of [0.15, 0.36]) {
		assert.ok(judge({ ...t, silentFraction }, 90).reasons.some((r) => /vide/.test(r)),
			`${silentFraction * 100} % de vide non détecté`);
	}
	// Et le pire morceau ACCEPTÉ à l'oreille doit continuer de passer.
	assert.deepEqual(judge({ ...t, silentFraction: 0.06 }, 90).reasons, [],
		'6 % de vide est la mesure de cinewhoop-1fbea112, validé à l\'oreille');
});

test('menu ne peut plus recevoir d\'axe qui le vide', () => {
	// Le noyau du pool dit déjà « sparse minimal percussion, patient and
	// watchful ». Un axe qui ajoute du vide par-dessus rend un prompt qui ne
	// demande rien. J'avais banni « relentless and driving » — la mauvaise
	// direction : les trois morceaux de menu qui marchent sont les plus DENSES.
	const bans = POOL_AXIS_BANS.menu;
	assert.ok(bans.energy.includes('restrained and patient'), 'menu peut encore se faire vider');
	assert.ok(bans.density.includes('sparse arrangement, lots of space'));
	for (let i = 0; i < 300; i++) {
		const { axes } = buildPrompt('menu', `s${i}`);
		assert.notEqual(axes.energy, 'restrained and patient');
		assert.notEqual(axes.density, 'sparse arrangement, lots of space');
	}
});

test('judge accepte un morceau sain et nomme chaque défaut', () => {
	const sane = { durationS: 90, lufs: -13, truePeak: -1.2, headSilenceS: 0.1, tailSilenceS: 1.0, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	assert.deepEqual(judge(sane, 90).reasons, []);
	assert.ok(judge({ ...sane, durationS: 40 }, 90).reasons.some((r) => /durée/.test(r)));
	assert.ok(judge({ ...sane, headSilenceS: 9 }, 90).reasons.some((r) => /tête/.test(r)));
	assert.ok(judge({ ...sane, tailSilenceS: 30 }, 90).reasons.some((r) => /queue/.test(r)));
	assert.ok(judge({ ...sane, lufs: -40 }, 90).reasons.some((r) => /LUFS/.test(r)));
	assert.ok(judge({ ...sane, lufs: NaN }, 90).reasons.some((r) => /non mesuré/.test(r)));
	assert.ok(judge({ ...sane, rmsSpreadDb: 0.1 }, 90).reasons.some((r) => /nappe/.test(r)));
	assert.ok(judge({ ...sane, sideDb: -70 }, 90).reasons.some((r) => /mono/.test(r)));
	assert.ok(judge({ ...sane, truePeak: 20 }, 90).reasons.some((r) => /cassé/.test(r)));
});

test('le gate ne rejette PAS une crête inter-échantillon normale', () => {
	// 19 des 21 morceaux du lot de calibration dépassent 0 dBFS. C'est le
	// comportement normal d'un master fort, et music-loop.mjs le corrige par un
	// gain statique. Rejeter là-dessus viderait la bibliothèque.
	const sane = { durationS: 90, lufs: -13, headSilenceS: 0, tailSilenceS: 1, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	for (const truePeak of [0.1, 0.6, 1.4, 2.9]) {
		assert.deepEqual(judge({ ...sane, truePeak }, 90).reasons, [], `crête ${truePeak} rejetée à tort`);
	}
});

test('le gate laisse vivre les genres volontairement égaux', () => {
	// Le dub techno (LONG RANGE) et l'ambiance de menu sont hypnotiques par
	// construction : un seuil d'écart RMS trop haut rejetterait exactement les
	// pools dont c'est l'identité. Mesures réelles du lot : 1.29 et 1.75 dB.
	const even = { durationS: 90, lufs: -14, truePeak: 1.1, headSilenceS: 0, tailSilenceS: 1, silentFraction: 0, sideDb: -18 };
	for (const rmsSpreadDb of [1.29, 1.75, 3.3]) {
		assert.deepEqual(judge({ ...even, rmsSpreadDb }, 90).reasons, [], `écart ${rmsSpreadDb} dB rejeté à tort`);
	}
	// Mais le silence déguisé reste attrapé.
	assert.ok(judge({ ...even, rmsSpreadDb: 0.2 }, 90).reasons.some((r) => /nappe/.test(r)));
});

test('le fondu de queue normal du modèle passe, une queue morte non', () => {
	const t = { durationS: 90, lufs: -13, truePeak: 0.5, headSilenceS: 0, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	for (const tailSilenceS of [0, 1.12, 2.95, 4.42]) {
		assert.deepEqual(judge({ ...t, tailSilenceS }, 90).reasons, [], `queue ${tailSilenceS} s rejetée à tort`);
	}
	assert.ok(judge({ ...t, tailSilenceS: 30 }, 90).reasons.some((r) => /queue/.test(r)));
});

test('les bornes du gate sont ordonnées et plausibles', () => {
	assert.ok(BOUNDS.lufs[0] < BOUNDS.lufs[1]);
	assert.ok(BOUNDS.lufs[0] < TARGET_LUFS && TARGET_LUFS < BOUNDS.lufs[1],
		'la cible de normalisation doit tomber dans la plage acceptée');
	assert.ok(BOUNDS.headSilenceS < BOUNDS.tailSilenceS,
		'on tolère plus de silence en queue : music-loop la recoupe');
	assert.ok(BOUNDS.minSideDb < 0);
	assert.ok(BOUNDS.maxSilentFraction > 0.06 && BOUNDS.maxSilentFraction < 0.15,
		'le seuil de vide doit laisser passer le pire morceau accepté (6 %) et attraper les ratés (15 %)');
});

test('la génération reste au point de fonctionnement du modèle', () => {
	// Contre-intuitif, donc à protéger : monter le nombre de pas DÉGRADE ce
	// modèle. Stable Audio 3 est construit pour l'inférence rapide et 8 pas est
	// son régime nominal, pas un raccourci. À 50 pas la sortie tombe de 3,6 à
	// 8,7 dB et part hors-style — vérifié à l'oreille sur le pool `menu`.
	assert.equal(DEFAULTS.steps, 8, 'le modèle sort de son régime au-delà');
	// Et le CFG reste bas : à 7 le rendu sort déjà compressé (-5,3 LUFS, LRA 4,4).
	assert.ok(DEFAULTS.cfgScale <= 2, `cfg ${DEFAULTS.cfgScale} : le rendu sera écrasé`);
});

test('suggestSeedBase suit la série et n\'entre jamais en collision', () => {
	// Le piège le plus facile du pipeline : réutiliser une graine ne produit pas
	// d'autres morceaux, elle rend EXACTEMENT les mêmes, que le worker saute
	// ensuite comme déjà générés. On croit avoir agrandi la bibliothèque et il
	// ne s'est rien passé — silencieusement.
	assert.equal(suggestSeedBase(new Set()), 'v1');
	assert.equal(suggestSeedBase(new Set(['v5'])), 'v6');
	assert.equal(suggestSeedBase(new Set(['cal1', 'v2', 'v3', 'v5'])), 'v6');
	// Une graine hors série ne doit pas bloquer la suggestion.
	assert.equal(suggestSeedBase(new Set(['cal1'])), 'v1');
	// Et la suggestion ne doit jamais être déjà prise.
	for (const used of [new Set(['v1']), new Set(['v1', 'v2', 'v3']), new Set(['v9', 'cal1'])]) {
		assert.ok(!used.has(suggestSeedBase(used)), 'la suggestion entre en collision');
	}
});

// --- retrait ----------------------------------------------------------------

const lib = [
	{ id: 'race5-a', pool: 'race5', file: 'music/race5/a.opus', durS: 80, bpm: 148, seed: 'cal1::0' },
	{ id: 'race5-b', pool: 'race5', file: 'music/race5/b.opus', durS: 80, bpm: 148, seed: 's50::0' },
	{ id: 'menu-a', pool: 'menu', file: 'music/menu/a.opus', durS: 80, bpm: 90, seed: 'cal1::0' },
	{ id: 'menu-b', pool: 'menu', file: 'music/menu/b.opus', durS: 80, bpm: 90, seed: 's50::0' },
];

test('partition sépare par graine et par id', () => {
	const parGraine = partition(lib, { before: 's50' });
	assert.deepEqual(parGraine.drop.map((t) => t.id), ['race5-a', 'menu-a']);
	assert.deepEqual(parGraine.keep.map((t) => t.id), ['race5-b', 'menu-b']);

	const parId = partition(lib, { ids: ['menu-b'] });
	assert.deepEqual(parId.drop.map((t) => t.id), ['menu-b']);
	assert.equal(parId.keep.length, 3);
});

test('partition ne retire rien sans critère', () => {
	const p = partition(lib, {});
	assert.equal(p.drop.length, 0);
	assert.equal(p.keep.length, lib.length);
});

test('partition supporte un morceau sans graine', () => {
	// Les entrées les plus anciennes du manifeste pourraient ne pas en avoir ;
	// les traiter comme « à retirer » silencieusement serait une perte de
	// données déguisée en nettoyage.
	const sansGraine = [{ id: 'x', pool: 'menu', file: 'f', durS: 1, bpm: 1 }];
	const p = partition(sansGraine, { before: 's50' });
	assert.equal(p.drop.length, 1, 'un morceau sans graine ne survit pas à --before, et c\'est voulu');
	assert.equal(partition(sansGraine, { ids: [] }).drop.length, 0);
});

console.log(`music-selftest : ${passed} tests`);
