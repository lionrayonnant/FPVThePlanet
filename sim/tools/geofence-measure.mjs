// Mesure la distance d'arrêt sous le rappel de la clôture (issue #139), pour
// chaque famille de drone, et en déduit R_HOLD et R_CAUTION.
//
//   node tools/geofence-measure.mjs [sceneDir] [--start=<m>]
//
// CLAUDE.md : mesurés, pas choisis à la main.
//
// ---------------------------------------------------------------------------
// LE PROTOCOLE — en ACRO, parce que c'est le mode du jeu
// ---------------------------------------------------------------------------
//
// FlightController démarre en `acro` et src/entry-state.js:241 le force. En
// ACRO, des manches centrées ne remettent PAS l'appareil à plat : elles
// tiennent l'assiette. Mesuré avec ce banc, manches centrés à l'entrée en HOLD
// et gaz au stationnaire (le plus favorable au pilote) : l'assiette reste à
// 42° au degré près, cinq familles sur six franchissent la face sous un
// couloir de 29 m — de +4,7 m (cinewhoop, la seule à s'arrêter) à +44,6 m
// (heavy5) dans les dix secondes qui suivent l'entrée en HOLD — et quatre sur
// six la franchissent encore sous un couloir de 66 m. « Lâcher les manches »
// n'est donc PAS une façon d'obéir dans ce jeu, et une mesure faite en mode
// ANGLE (où lâcher remet à plat tout seul) répond à une question que le jeu ne
// pose pas.
//
// « Obéir » doit donc être un PROGRAMME DE MANCHE explicite. Le voici, en
// entier — c'est lui, la définition, et rien d'autre dans ce fichier n'a le
// droit de la contredire :
//
//   APPROCHE (avant l'entrée en HOLD)
//     gaz     : plein (1,0)
//     tangage : le pilote pique jusqu'à 42° — ANGLE_MAX_TILT, l'assiette la
//               plus inclinée que l'auto-stabilisation du dépôt tienne — et
//               tient cette assiette jusqu'au couloir.
//
//   FREINAGE (dès l'entrée en HOLD, le pilote a lu l'avertissement)
//     gaz     : ramenés quelque part entre zéro et le stationnaire. On BALAYE
//               cette bande de 0 à hoverThrottle() et on garde le PIRE cas :
//               le manche des gaz exact d'un pilote qui freine n'est pas
//               connaissable, donc on ne le suppose pas.
//     tangage : TIRÉ pour ramener l'appareil à plat — en ACRO il faut le
//               faire soi-même — puis CENTRÉ dès que l'horizon est revenu
//               (à 1° près) et plus jamais touché. À partir de là l'ACRO
//               tient l'assiette : rien ne remet le drone à plat pour le
//               pilote, et le résidu d'assiette qu'il a laissé, il le garde.
//
//   Le tangage, dans les deux phases, demande le MÊME taux de rotation que le
//   mode angle demanderait pour la même erreur d'assiette (ANGLE_STRENGTH,
//   flightController.js) — c'est la définition que le dépôt se donne déjà d'un
//   ralliement d'assiette correct — inversé à travers la courbe de rates de la
//   famille. Le pilote raisonne en degrés par seconde, pas en millimètres de
//   manche ; l'inversion rend le programme identique d'une famille à l'autre.
//   Vérifié : sur la grille 3x3 (taux divisé par 2, nominal, doublé) x (seuil
//   « à plat » 0,25°, 1°, 4°), le point fixe de la pire famille tient dans
//   63,40 - 65,98 m, soit 2,58 m d'écart, et RESTE sous la valeur figée dans
//   les neuf cas. Ce n'est pas ce modèle-là qui porte l'incertitude ; c'est le
//   manche des gaz, et c'est lui qu'on balaye.
//
// Une fois à plat, seuls le rappel plafonné (A_MAX) et la traînée de quad.js
// décélèrent. Manches ramenés au calme et non tirés à fond, délibérément : un
// pilote qui insiste DOIT pouvoir passer, c'est la moitié du design. R_HOLD
// dimensionne le cas où on obéit, pas le cas où on désobéit.
//
// Plein gaz, et non 75 % : « la vitesse maximale » n'a pas de sens à un manche
// arbitraire. À 42° et plein gaz la machine grimpe aussi — ce n'est pas un vol
// en palier, c'est un dash — mais seule la composante horizontale entre dans
// un couloir horizontal, et c'est elle qu'on retient. Le vol se déroule à
// bbox.max.y + 200 m, au-dessus du point le plus haut de la carte : la marge
// horizontale ne dépend pas de l'altitude (voir horizontalMargin), et à cette
// hauteur aucune collision avec la scène n'est possible — ce que le banc
// re-vérifie de toute façon en continu (maxImpact).
//
// ---------------------------------------------------------------------------
// POURQUOI UN POINT FIXE, ET PAS UNE SOUSTRACTION
// ---------------------------------------------------------------------------
//
// La FORME de la rampe du rappel (0 à A_MAX sur R_HOLD mètres, pushOf() dans
// geofence.js) dépend elle-même de R_HOLD : rétrécir le couloir durcit la
// rampe et change la distance d'arrêt qu'on cherche à mesurer avec. Pas de
// raccourci algébrique. On cherche le POINT FIXE — le couloir sous la rampe
// DUQUEL la famille s'arrête pile à MARGIN_M de la face — par itération
// directe : R(n+1) = R(n) + pénétration(n) + MARGIN_M. La contraction est
// nette (3 à 5 pas) et le résultat est indépendant du point de départ :
// mesuré à 65,82 / 65,83 / 65,84 / 65,87 / 65,93 m depuis des départs de 5,
// 10, 20, 40 et 66 m. Le départ est un ARGUMENT (--start), pas la constante
// qu'on calcule : un banc qui s'amorce sur son propre résultat ne contrôle
// plus rien. (Au-delà d'une centaine de mètres de départ, la rampe d'essai
// devient si molle qu'un résidu d'assiette l'équilibre : le drone flue au lieu
// de s'arrêter et le banc refuse de livrer un chiffre. C'est voulu.)
//
// ---------------------------------------------------------------------------
// MARGIN_M — mesurée elle aussi
// ---------------------------------------------------------------------------
//
// La marge de sécurité visée n'est pas un « +1 » posé à la main. Elle est
// prise égale à la DISPERSION mesurée du point d'arrêt sur le balayage des
// gaz de freinage : c'est l'écart que produit, à elle seule, la seule
// hypothèse de pilotage qu'on ne sait pas trancher. La régler là revient à
// dire qu'un pilote aussi loin du pire cas balayé que la bande balayée est
// large s'arrête encore dedans. Le banc RE-MESURE cette dispersion au point
// fixe et refuse de livrer un chiffre si elle dépasse MARGIN_M.
//
// ---------------------------------------------------------------------------
// CE QUE LE BRIEF D'ORIGINE DEMANDAIT ET QUI ÉTAIT FAUX
// ---------------------------------------------------------------------------
//
//   1. `new FlightController()` doit recevoir `{ profile }`. Sans ça, le
//      contrôleur garde le PID et le mixer de DEFAULT_PROFILE (freestyle5)
//      quelle que soit la famille passée à phys.setProfile() — cinq familles
//      sur six auraient volé avec les gains d'une autre. Même paire que
//      tools/selftest.mjs:useFamily().
//
//   2. « On pousse tangage plein et on laisse la traînée trouver son
//      équilibre » suppose une assiette tenue, donc le mode ANGLE. Mais le jeu
//      vole en ACRO — voir tout le haut de ce fichier : la réponse n'est pas
//      de changer de mode, c'est d'écrire le programme de manche.
//
//   3. Le drone ne doit jamais être TÉLÉPORTÉ à sa vitesse de croisière, et
//      surtout pas à plat : c'est piqué à 42° qu'il atteint cette vitesse. Une
//      coque à plat lancée d'un coup à 25 m/s présente aux quatre rotors toute
//      leur vitesse de translation, donc la traînée rotor kLateral·ω·v
//      (quad.js:287), qui est le terme dominant à plat — et non « une traînée
//      de plaque », qui serait faux dans le détail : bodyDrag.y vaut ~3 fois
//      bodyDrag.x/z, une coque à plat présente donc au vent ses axes de FAIBLE
//      traînée de carène. Conséquence pratique : le drone accélère depuis
//      l'arrêt sur un couloir dimensionné pour ça, et la face testée est celle
//      vers laquelle le piqué l'emmène (−Z, plein avant).
//
//   4. `R_HOLD = pénétration + 1` suppose une pénétration positive sous le
//      couloir d'essai. Voir le point fixe ci-dessus.
import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics } from '../src/physics.js';
import {
	FlightController, hoverThrottle, unrotateVec,
	actualRate, ANGLE_MAX_TILT, ANGLE_STRENGTH,
} from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { Geofence, horizontalMargin, A_MAX } from '../src/geofence.js';

const args = process.argv.slice(2);
const startArg = args.find((a) => a.startsWith('--start='));
const sceneDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'public/scenes/tour-eiffel');
const manifest = JSON.parse(fs.readFileSync(path.join(sceneDir, 'manifest.json')));
const raw = fs.readFileSync(path.join(sceneDir, 'collision.bin'));
const vc = raw.readUInt32LE(8), ic = raw.readUInt32LE(12);
const collision = {
	vertices: new Float32Array(raw.buffer, raw.byteOffset + 16, vc * 3),
	indices: new Uint32Array(raw.buffer, raw.byteOffset + 16 + vc * 12, ic),
};

await initPhysics();
// Un seul monde : plusieurs trimeshes pleine résolution épuisent le tas wasm.
const phys = new Physics(collision, manifest.spawn);

const STEP = 1 / 250;
const BLINK_PERIOD_S = 0.5;    // drone-osd.js:51
const BLINKS_TO_READ = 3;
// Marge de sécurité visée par le point fixe : la dispersion mesurée du point
// d'arrêt sur le balayage des gaz de freinage, arrondie au mètre supérieur
// (voir l'en-tête). Vérifiée au point fixe par le banc lui-même.
const MARGIN_M = 12;
const FIXED_POINT_TOL = 0.3;   // m : tolérance de convergence de l'itération
const MAX_ITERATIONS = 20;
const BRAKE_STEPS = 10;        // pas du balayage des gaz de freinage, 0 → hover
// Point de départ de l'itération. Délibérément PAS R_HOLD : un banc qui
// s'amorce sur la constante qu'il calcule ne la contrôle plus. Surchargeable
// par --start=<m> — c'est ce qui rend reproductible la vérification
// d'indépendance au point de départ citée dans l'en-tête.
const DEFAULT_START = 10;
const START = startArg ? Number(startArg.slice('--start='.length)) : DEFAULT_START;
if (!Number.isFinite(START) || START <= 0) throw new Error(`--start invalide : ${startArg}`);
// « L'horizon est revenu » : à 1° près. Mesuré, le point fixe de la pire
// famille ne bouge que de 1,1 m entre 0,25° et 4° (64,92 → 65,98) : ce seuil
// ne porte pas le chiffre.
const LEVEL_SIN = Math.sin(1 * Math.PI / 180);
const CRUISE_SIN = Math.sin(ANGLE_MAX_TILT);
const SIM_CAP_S = 90;          // garde-fou ; voir findRHold() pour ce qu'il attrape

const b = manifest.bbox;
// Au-dessus du point le plus haut de la carte : aucune collision possible, et
// la marge horizontale ne dépend pas de l'altitude.
const HIGH_Y = b.max[1] + 200;
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Place le corps à l'arrêt, à plat. Mêmes appels que
// tools/landing-selftest.mjs:53-61 — il n'existe pas de `teleport`. Pas de
// paramètre de vitesse : rien ici n'est jamais lancé à une vitesse posée à la
// main, c'est tout l'objet de l'écart 3.
function place(z) {
	phys.body.setTranslation({ x: 0, y: HIGH_Y, z }, true);
	phys.body.setRotation(LEVEL, true);
	phys.body.setLinvel(ZERO, true);
	phys.body.setAngvel(ZERO, true);
	phys.setGroundHold(false);
}

// Prépare une famille : profil dans la physique ET dans le contrôleur (écart
// 1), vent coupé, corps posé à l'arrêt. `setProfile()` reconstruit la
// Propulsion, donc chaque run repart batterie pleine et rotors à l'arrêt.
function setup(family, z) {
	const profile = PROFILES[family];
	phys.setProfile(profile);
	const fc = new FlightController({ profile });   // mode par défaut : ACRO
	fc.arm();
	phys.setWind(ZERO, 0);
	place(z);
	return { profile, fc, rates: fc.rates.pitch, maxRate: fc.rates.pitch.max * Math.PI / 180 };
}

// sin(assiette piquée) lu sur le quaternion : upB.z vaut +sin(piqué).
const noseDown = () => unrotateVec(phys.rotation, 0, 1, 0).z;

// L'inverse de actualRate() : quel manche demande ce taux ? La courbe est
// monotone en |manche|, une bissection suffit.
function invActualRate(rate, r) {
	const s = Math.sign(rate), target = Math.abs(rate);
	if (target >= actualRate(1, r)) return s;
	let lo = 0, hi = 1;
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		if (actualRate(mid, r) < target) lo = mid; else hi = mid;
	}
	return (s * (lo + hi)) / 2;
}

// Le manche de tangage du pilote : la même demande de taux que le mode angle
// produirait pour rejoindre `targetSin`, inversée à travers les rates de la
// famille (voir l'en-tête).
function pitchStick(targetSin, rates, maxRate) {
	const want = ANGLE_STRENGTH * (noseDown() - targetSin);
	return invActualRate(Math.max(-maxRate, Math.min(maxRate, want)), rates);
}

// Rampe locale du rappel horizontal, identique à pushOf() de geofence.js mais
// paramétrée par un R_HOLD D'ESSAI plutôt que la constante figée : c'est
// justement celle-là qu'on cherche. Croisée contre le vrai pushOf() ci-dessous
// avant tout usage.
function localPush(margin, trial) {
	if (margin >= trial) return 0;
	if (margin <= 0) return A_MAX;
	return (A_MAX * (trial - margin)) / trial;
}

function crossCheckLocalPush() {
	const f = new Geofence(b);
	// localPush() suppose que le bord des données est à marge nulle. C'est le
	// cas par construction dans Geofence — mais c'est une hypothèse, donc on la
	// vérifie plutôt que de la supposer.
	if (f.h.edge !== 0) throw new Error(`crossCheck : h.edge vaut ${f.h.edge}, localPush() suppose 0`);
	const hold = f.h.hold;
	for (const frac of [1, 0.75, 0.5, 0.25, 0, -0.15]) {
		const m = hold * frac;
		f.reset();
		f.update({ x: 0, y: HIGH_Y, z: b.min[2] + m });
		const real = f.out.push.z;             // face −Z : la normale rentrante est +Z
		const mine = localPush(m, hold);
		if (Math.abs(real - mine) > 1e-6) {
			throw new Error(`localPush() diverge de pushOf() à margin=${m.toFixed(2)} : réel=${real} local=${mine}`);
		}
	}
}

// L'approche seule, sans clôture : à quelle distance de son départ arrêté la
// famille atteint-elle sa vitesse horizontale maximale, et laquelle ? Cette
// distance sert à dimensionner le couloir d'élan pour que l'entrée en HOLD
// tombe PILE sur ce pic — le pire cas.
function approach(family) {
	const { fc, rates, maxRate } = setup(family, 0);
	let best = { v: -1, d: 0 };
	for (let i = 0; i < 30 * 250; i++) {
		const stick = pitchStick(CRUISE_SIN, rates, maxRate);
		const { motors } = fc.update({ throttle: 1, roll: 0, pitch: stick, yaw: 0 }, phys, STEP);
		phys.step(motors, STEP);
		const s = phys.velocity;
		const vh = Math.hypot(s.x, s.z);
		if (vh > best.v) best = { v: vh, d: -phys.position.z };
	}
	return best;
}

// Un run complet : élan puis freinage sous un couloir d'essai `trial`, gaz de
// freinage `brakeT`. Rend la pénétration maximale (positive = la face est
// franchie), l'impact maximal enregistré et la vitesse à l'entrée en HOLD.
function runOnce(family, trial, brakeT, runup) {
	const runway = runup + trial;
	const startZ = b.min[2] + runway;
	const { profile, fc, rates, maxRate } = setup(family, startZ);
	// La face visée doit bien être la plus proche au départ, sinon la mesure
	// parle d'une autre face que celle qu'on croit. C'est ce qui arrive sur une
	// carte trop petite : le banc a besoin de `runup` mètres pour amener la
	// famille à sa vitesse de pic PLUS le couloir d'essai, et sur bastille
	// (demi-côté 164 m) ça ne rentre pas. Il refuse plutôt que de mesurer une
	// approche qui n'a pas eu la place d'exister — c'est aussi la raison pour
	// laquelle geofence.js BORNE son couloir au lieu de le mesurer par scène.
	const m0 = horizontalMargin(phys.position, b);
	if (Math.abs(m0 - runway) > 1e-3) {
		throw new Error(`carte trop petite pour ce banc : ${family} a besoin de ${runup.toFixed(1)} m d'élan + ${trial.toFixed(1)} m de couloir = ${runway.toFixed(1)} m devant la face −Z, mais au point de départ la face la plus proche n'est qu'à ${m0.toFixed(1)} m. Aucune mesure possible ici.`);
	}
	let deepest = -Infinity, maxImpact = 0, entryV = 0;
	let entered = false, levelled = false, stopped = false;
	for (let i = 0; i < SIM_CAP_S * 250; i++) {
		const margin = horizontalMargin(phys.position, b);
		deepest = Math.max(deepest, -margin);
		if (!entered && margin <= trial) {
			entered = true;
			entryV = Math.hypot(phys.velocity.x, phys.velocity.z);
		}
		if (entered && !levelled && noseDown() <= LEVEL_SIN) levelled = true;
		// Le programme de manche, et rien d'autre : voir l'en-tête.
		const stick = entered && levelled ? 0 : pitchStick(entered ? 0 : CRUISE_SIN, rates, maxRate);
		const throttle = entered ? brakeT : 1;
		const { motors } = fc.update({ throttle, roll: 0, pitch: stick, yaw: 0 }, phys, STEP);
		// Le rappel entre par le TROISIÈME paramètre de step(), en newtons et
		// repère monde — comme main.js le fera (#139, tâche 6) — jamais par un
		// addForce après step(), que resetForces() effacerait sans l'intégrer.
		// +Z : la normale rentrante depuis la face −Z.
		const push = entered ? localPush(margin, trial) : 0;
		const impact = phys.step(motors, STEP, { x: 0, y: 0, z: push * profile.mass });
		maxImpact = Math.max(maxImpact, impact);
		if (entered && phys.velocity.z >= 0) { stopped = true; break; }
	}
	return { deepest, maxImpact, entryV, levelled, stopped };
}

// Le pire des gaz de freinage, de 0 au stationnaire, et la dispersion que ce
// balayage produit à lui seul.
function worstOverBrake(family, trial, runup) {
	const hoverT = hoverThrottle(PROFILES[family], LEVEL);
	let worst = null, shallowest = Infinity, maxImpact = 0, allLevelled = true, allStopped = true;
	let allMoving = true;
	for (let i = 0; i <= BRAKE_STEPS; i++) {
		const brakeT = (hoverT * i) / BRAKE_STEPS;
		const r = runOnce(family, trial, brakeT, runup);
		maxImpact = Math.max(maxImpact, r.maxImpact);
		allLevelled = allLevelled && r.levelled;
		allStopped = allStopped && r.stopped;
		allMoving = allMoving && r.entryV > 0;
		shallowest = Math.min(shallowest, r.deepest);
		if (!worst || r.deepest > worst.deepest) worst = { ...r, brakeT };
	}
	return { ...worst, hoverT, spread: worst.deepest - shallowest, maxImpact, allLevelled, allStopped, allMoving };
}

// Le R_HOLD self-consistant d'une famille : le plus petit couloir sous la
// rampe duquel son pire freinage s'arrête à MARGIN_M de la face.
function findRHold(family, runup) {
	let trial = START, last = null;
	const trace = [];
	let maxImpact = 0, converged = false;
	for (let it = 0; it < MAX_ITERATIONS; it++) {
		last = worstOverBrake(family, trial, runup);
		maxImpact = Math.max(maxImpact, last.maxImpact);
		trace.push(`${trial.toFixed(1)}→${last.deepest.toFixed(1)}`);
		if (!last.allStopped) {
			// Cas connu : sous un couloir TRÈS large la rampe est si molle qu'un
			// résidu d'assiette de 2° aux gaz de stationnaire l'équilibre — le
			// drone flue au lieu de s'arrêter et la pénétration serait tronquée
			// par la garde de temps. C'est ce qui arrive avec un --start
			// exagéré (au-delà d'environ 100 m sur tour-eiffel). Le banc ne
			// livre pas de chiffre là-dessus, il n'en a pas de bon.
			throw new Error(`${family} : un freinage n'a pas atteint l'arrêt en ${SIM_CAP_S} s (couloir d'essai ${trial.toFixed(1)} m). Sous un couloir aussi large le drone flue au lieu de s'arrêter et la pénétration mesurée serait tronquée. Si c'est un --start exagéré, en prendre un plus petit.`);
		}
		if (!last.allMoving) {
			// Un run où le drone entre en HOLD à l'arrêt ne mesure rien : la
			// pénétration est alors ~−trial et l'itération converge sagement
			// vers MARGIN_M, ce qui a l'air d'un résultat.
			throw new Error(`${family} : le drone est entré dans le couloir à l'arrêt (couloir d'essai ${trial.toFixed(1)} m) — il n'y a pas eu d'approche, donc pas de distance d'arrêt à mesurer`);
		}
		if (!last.allLevelled) {
			throw new Error(`${family} : le pilote n'a jamais retrouvé l'horizon (couloir d'essai ${trial.toFixed(1)} m) — le programme de manche ne décrit plus ce qui se passe`);
		}
		const next = trial + last.deepest + MARGIN_M;
		if (next <= 0) {
			throw new Error(`${family} : l'itération demande un couloir négatif (${next.toFixed(1)} m) — le harnais est faux`);
		}
		if (Math.abs(next - trial) < FIXED_POINT_TOL) { trial = next; converged = true; break; }
		trial = next;
	}
	if (!converged) {
		throw new Error(`${family} : pas de convergence en ${MAX_ITERATIONS} itérations, trace [${trace.join('  ')}]`);
	}
	return { rHold: trial, trace, maxImpact, last };
}

crossCheckLocalPush();
console.log(`cross-check localPush() vs pushOf() : ok`);
console.log(`scène ${path.basename(sceneDir)}   A_MAX ${A_MAX.toFixed(3)} m/s²   MARGIN_M ${MARGIN_M} m   départ de l'itération ${START} m\n`);

console.log(`approche : plein gaz, assiette tenue à ${(ANGLE_MAX_TILT * 180 / Math.PI).toFixed(0)}°, depuis l'arrêt`);
const peak = {};
for (const family of FAMILIES) {
	peak[family] = approach(family);
	console.log(`  ${family.padEnd(12)} vpic ${peak[family].v.toFixed(2)} m/s   atteinte à ${peak[family].d.toFixed(0)} m`);
}

console.log(`\nR_HOLD self-consistant par famille (pire des ${BRAKE_STEPS + 1} gaz de freinage) :`);
const res = {};
let worstImpact = 0, worstSpread = 0;
for (const family of FAMILIES) {
	const r = findRHold(family, peak[family].d);
	res[family] = r;
	worstImpact = Math.max(worstImpact, r.maxImpact);
	worstSpread = Math.max(worstSpread, r.last.spread);
	const p = PROFILES[family];
	console.log(`  ${family.padEnd(12)} R_HOLD* ${r.rHold.toFixed(2).padStart(6)} m   entrée ${r.last.entryV.toFixed(2)} m/s   pire gaz ${r.last.brakeT.toFixed(3)}/${r.last.hoverT.toFixed(3)}   dispersion ${r.last.spread.toFixed(2)} m   bodyDrag.z/masse ${(p.bodyDrag.z / p.mass).toFixed(5)}   impact ${r.maxImpact.toFixed(1)} N`);
	console.log(`               [${r.trace.join('  ')}]`);
}

// Un banc qui a heurté quelque chose ne livre pas de chiffre. Les lignes par
// famille ci-dessus sont déjà sorties — elles s'impriment au fil de l'eau,
// une mesure prend quelques secondes — donc c'est le livrable, les deux
// valeurs à figer, qui ne sort pas. On nomme les familles touchées plutôt que
// de condamner les six en bloc : `worstImpact` est un max, et une seule
// famille qui percute ne rend pas les cinq autres lignes fausses (chacune
// imprime déjà son propre `impact`).
const hit = FAMILIES.filter((f) => res[f].maxImpact > 0);
if (hit.length > 0) {
	console.error(`\nÉCHEC : impact non nul (jusqu'à ${worstImpact.toFixed(1)} N) — le drone a percuté`);
	console.error(`la scène pendant la mesure de : ${hit.join(', ')}. Ces lignes-là sont fausses ;`);
	console.error(`aucune valeur figeable n'est imprimée.`);
	process.exit(1);
}
// MARGIN_M doit couvrir la dispersion qu'elle prétend couvrir.
if (Math.ceil(worstSpread) > MARGIN_M) {
	console.error(`\nÉCHEC : dispersion mesurée ${worstSpread.toFixed(2)} m > MARGIN_M ${MARGIN_M} m.`);
	console.error(`La marge ne couvre plus l'incertitude de pilotage qu'elle est censée couvrir :`);
	console.error(`remonter MARGIN_M à ${Math.ceil(worstSpread)} et relancer. Les R_HOLD* par famille`);
	console.error(`ci-dessus valent pour l'ancienne marge ; aucune valeur figeable n'est imprimée.`);
	process.exit(1);
}

const worstFamily = FAMILIES.reduce((a, c) => (res[c].rHold > res[a].rHold ? c : a));
const worstVFamily = FAMILIES.reduce((a, c) => (peak[c].v > peak[a].v ? c : a));
const worstV = peak[worstVFamily].v;

const rHold = Math.ceil(res[worstFamily].rHold);
const rCaution = Math.ceil(rHold + BLINKS_TO_READ * BLINK_PERIOD_S * worstV);

console.log(`\n  pire R_HOLD*       ${res[worstFamily].rHold.toFixed(2)} m (${worstFamily})`);
console.log(`  pire vitesse       ${worstV.toFixed(2)} m/s (${worstVFamily})`);
console.log(`  pire dispersion    ${worstSpread.toFixed(2)} m  (≤ MARGIN_M = ${MARGIN_M} m : ok)`);
console.log(`\n  R_HOLD    = ${rHold}`);
console.log(`  R_CAUTION = ${rCaution}   (= R_HOLD + ${BLINKS_TO_READ} × ${BLINK_PERIOD_S} s × ${worstV.toFixed(2)} m/s)`);
console.log(`               la bande d'avertissement vaut ${rCaution - rHold} m, soit ${((rCaution - rHold) / worstV).toFixed(2)} s à ${worstV.toFixed(2)} m/s`);
console.log(`\n  → reporter ces deux valeurs dans src/geofence.js, avec la date.`);
