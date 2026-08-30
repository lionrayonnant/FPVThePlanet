// Mesure la distance d'arrêt sous le rappel de la clôture (issue #139), pour
// chaque famille de drone, et en déduit R_HOLD et R_CAUTION.
//
//   node tools/geofence-measure.mjs [sceneDir]
//
// CLAUDE.md : mesurés, pas choisis à la main. Protocole : le drone accélère
// depuis l'arrêt, tangage plein (mode ANGLE, assiette tenue à 42°), jusqu'à
// sa vitesse en palier maximale, droit vers une face ; à l'entrée en HOLD les
// manches reviennent au neutre (le pilote a lu l'avertissement et a lâché) ;
// seuls A_MAX et la traînée de quad.js décélèrent. On mesure la pénétration.
//
// Manches au NEUTRE et non tirées à fond, délibérément : un pilote qui
// insiste doit pouvoir passer, c'est la moitié du design. R_HOLD dimensionne
// le cas où on obéit, pas le cas où on désobéit.
//
// QUATRE écarts au brief d'origine (task-4-brief.md), tous vérifiés par
// mesure et détaillés dans task-4-report.md :
//
//   1. `new FlightController()` doit recevoir `{ profile }`. Sans ça, le
//      contrôleur garde le PID et le mixer de DEFAULT_PROFILE (freestyle5)
//      quelle que soit la famille passée à phys.setProfile() — cinq familles
//      sur six auraient volé avec les gains d'une autre. Même paire que
//      tools/selftest.mjs:useFamily().
//
//   2. Un tangage tenu suppose le mode ANGLE. En mode ACRO (le défaut de
//      FlightController), le tangage est une VITESSE de rotation, pas une
//      assiette : tenir le manche à fond fait boucler le drone sans fin au
//      lieu de le stabiliser à 42° — mesuré : jusqu'à -25 m/s de vitesse
//      verticale après 3 s au lieu d'une vitesse en palier stable.
//
//   3. Le drone doit ACCÉLÉRER depuis l'arrêt jusqu'à sa vitesse en palier,
//      jamais être téléporté directement à cette vitesse à plat (assiette
//      LEVEL). Une coque à plat lancée à 25 m/s présente au vent tout le
//      disque rotor plutôt que les 42° inclinés qui ont produit cette
//      vitesse ; la traînée de « plaque » qui en résulte n'a rien à voir
//      avec le vol réel et tue la vitesse en quelques mètres, HOLD ou pas.
//      Conséquence : la face testée est +Z, la direction naturelle du
//      tangage plein depuis une assiette LEVEL (vérifié : vx≈0, vz=vmax en
//      partant à plat) — pas +X comme dans le brief. geofence.js est
//      symétrique par face ; seule la face testée change.
//
//   4. La formule à un coup du brief, R_HOLD = pénétration_mesurée + 1,
//      suppose la pénétration positive (le pilote dépasse la face) SOUS
//      L'ANCIEN COULOIR (R_HOLD = 40, la constante PROVISOIRE encore en
//      place au moment de la mesure). Ce n'est vrai pour AUCUNE des six
//      familles : sous 40 m de rampe, même la plus lourde s'arrête ~10 m
//      avant la face. La formule donnerait un R_HOLD négatif — exactement le
//      signal d'alarme que le brief demande de surveiller. La raison est que
//      la FORME de la rampe (0 à A_MAX sur R_HOLD mètres, voir pushOf() dans
//      geofence.js) dépend ELLE-MÊME de R_HOLD : rétrécir le couloir durcit
//      la rampe et change la distance d'arrêt qu'on cherche à mesurer avec.
//      Pas de raccourci : on cherche le point fixe — le R_HOLD sous la rampe
//      DUQUEL le pilote s'arrête pile à la marge visée — par itération
//      directe. Elle converge seule (contraction nette, 3-4 pas suffisent à
//      0,3 m près sur les six familles, voir task-4-report.md) en partant de
//      la constante actuelle, un point de départ connu sûr (jamais de
//      dépassement mesuré à R_HOLD=40) : l'itération ne fait donc QUE
//      rétrécir le couloir, jamais l'inverse, pas de risque de partir d'un
//      couloir trop court qui laisserait le pilote dépasser LOST pendant la
//      recherche elle-même.
import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics } from '../src/physics.js';
import { FlightController } from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { Geofence, horizontalMargin, A_MAX, R_HOLD } from '../src/geofence.js';

const sceneDir = path.resolve(process.argv[2] ?? 'public/scenes/tour-eiffel');
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
const BLINK_PERIOD_S = 0.5;   // drone-osd.js:51
const BLINKS_TO_READ = 3;
const MARGIN_M = 1;           // marge de sécurité visée, comme le "+1" du brief
const FIXED_POINT_TOL = 0.3;  // m : tolérance de convergence de l'itération
const MAX_ITERATIONS = 12;

const b = manifest.bbox;
const MID_Y = (b.min[1] + b.max[1]) / 2;
// Distance de départ avant la face +Z, drone à l'arrêt. Doit dépasser
// largement la distance de convergence vers la vitesse en palier (mesurée :
// 8 m pour toothpick à 85 m pour heavy5) tout en laissant le temps d'y
// accélérer avant la zone CAUTION — la valeur exacte n'entre dans aucun
// calcul, seule compte la marge. Dégagement vérifié par mesure (aucun
// impact enregistré sur les six familles, voir task-4-report.md).
const RUNWAY = 200;

const LEVEL = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Place le corps, à plat, à la vitesse voulue. Mêmes appels que
// tools/landing-selftest.mjs:place() — il n'existe pas de `teleport`.
function place(pos, vel) {
	phys.body.setTranslation(pos, true);
	phys.body.setRotation(LEVEL, true);
	phys.body.setLinvel(vel, true);
	phys.body.setAngvel(ZERO, true);
	phys.setGroundHold(false);
}

// La vitesse en palier maximale d'un profil : tangage plein en mode ANGLE
// (assiette tenue à 42°, PAS une vitesse de rotation — écart 2 ci-dessus),
// loin de tout, jusqu'à ce que la traînée trouve son équilibre.
function topSpeed(family) {
	const profile = PROFILES[family];
	phys.setProfile(profile);
	const fc = new FlightController({ profile });   // écart 1 : profile lié au contrôleur
	fc.arm();
	fc.setMode('angle');                             // écart 2 : assiette, pas vitesse
	phys.setWind(ZERO, 0);
	place({ x: 0, y: b.max[1] + 200, z: 0 }, ZERO);
	let v = 0;
	for (let i = 0; i < 25 * 250; i++) {
		const sticks = { throttle: 0.75, roll: 0, pitch: 1, yaw: 0 };
		// fc.update(sticks, phys, dt) rend { motors }, et step prend
		// (motors, dt) dans CET ordre.
		const { motors } = fc.update(sticks, phys, STEP);
		phys.step(motors, STEP);
		const s = phys.velocity;
		v = Math.max(v, Math.hypot(s.x, s.z));
	}
	return v;
}

// Rampe locale du rappel horizontal, identique à pushOf() de geofence.js
// mais paramétrée par un R_HOLD D'ESSAI plutôt que la constante figée :
// c'est justement cette constante qu'on cherche (écart 4 ci-dessus).
// Recopiée plutôt qu'importée pour ne rien changer à geofence.js avant
// d'avoir une valeur en main ; croisée contre le vrai pushOf() (via un vrai
// Geofence) juste en dessous avant de s'y fier.
function localPush(margin, rHoldTrial) {
	if (margin >= rHoldTrial) return 0;
	if (margin <= 0) return A_MAX;
	return A_MAX * (rHoldTrial - margin) / rHoldTrial;
}

function crossCheckLocalPush() {
	const f = new Geofence(b);
	for (const frac of [1, 0.75, 0.5, 0.25, 0, -0.15]) {
		const m = R_HOLD * frac;
		f.reset();
		f.update({ x: 0, y: MID_Y, z: b.max[2] - m });
		const real = f.out.push.z;          // pousse vers -Z depuis la face +Z
		const mine = -localPush(m, R_HOLD);
		if (Math.abs(real - mine) > 1e-6) {
			throw new Error(`localPush() diverge de pushOf() à margin=${m.toFixed(2)} : réel=${real} local=${mine}`);
		}
	}
}

// La pénétration sous un couloir d'essai `rHoldTrial` : accélère depuis
// l'arrêt (tangage plein, throttle 0.75, comme topSpeed()) jusqu'à l'entrée
// dans CE couloir d'essai (margin <= rHoldTrial), puis manches au neutre
// (throttle 0.5, tangage 0) — seuls A_MAX (rampe locale) et la traînée de
// quad.js décélèrent, jusqu'à l'arrêt (vitesse <= 0) ou 60 s simulées.
// Rend { deepest, maxImpact } : maxImpact doit rester 0 sur toute la
// mesure — un impact non nul voudrait dire que le drone a percuté la scène
// réelle (pas la clôture, qui est synthétique) et que la mesure est fausse.
function overshootAt(family, rHoldTrial) {
	const profile = PROFILES[family];
	phys.setProfile(profile);
	const fc = new FlightController({ profile });
	fc.arm();
	fc.setMode('angle');
	phys.setWind(ZERO, 0);
	place({ x: 0, y: MID_Y, z: b.max[2] - RUNWAY }, ZERO);
	let deepest = -Infinity;
	let maxImpact = 0;
	let entered = false;
	for (let i = 0; i < 60 * 250; i++) {
		const p = phys.position;
		const margin = horizontalMargin(p, b);
		deepest = Math.max(deepest, p.z - b.max[2]);
		if (margin <= rHoldTrial) entered = true;
		const sticks = { throttle: entered ? 0.5 : 0.75, roll: 0, pitch: entered ? 0 : 1, yaw: 0 };
		const { motors } = fc.update(sticks, phys, STEP);
		// -Z : la normale rentrante depuis la face +Z. Le rappel entre par le
		// TROISIÈME paramètre de step(), en newtons et repère monde — comme
		// main.js le fera (#139, tâche 6 step 1) — jamais par un addForce
		// après step(), que resetForces() effacerait sans l'intégrer.
		const push = entered ? -localPush(margin, rHoldTrial) : 0;
		const impact = phys.step(motors, STEP, { x: 0, y: 0, z: push * profile.mass });
		maxImpact = Math.max(maxImpact, impact);
		if (entered && phys.velocity.z <= 0) break;
	}
	return { deepest, maxImpact };
}

// Le R_HOLD self-consistant d'une famille : le plus petit couloir qui
// arrête sa vitesse en palier à MARGIN_M de marge avant la face. Itération
// directe (voir écart 4) : R_HOLD(n+1) = R_HOLD(n) + pénétration(n) + marge.
function findRHold(family) {
	let trial = R_HOLD;   // la constante actuelle : point de départ sûr, voir écart 4
	const trace = [];
	let maxImpact = 0;
	for (let it = 0; it < MAX_ITERATIONS; it++) {
		const r = overshootAt(family, trial);
		maxImpact = Math.max(maxImpact, r.maxImpact);
		trace.push({ trial, d: r.deepest });
		const next = Math.max(1, trial + r.deepest + MARGIN_M);
		if (Math.abs(next - trial) < FIXED_POINT_TOL) { trial = next; break; }
		trial = next;
	}
	return { rHold: trial, trace, maxImpact };
}

console.log('vitesse en palier maximale (mode angle, tangage plein, throttle 0.75) :');
const vmax = {};
for (const family of FAMILIES) {
	vmax[family] = topSpeed(family);
	console.log(`  ${family.padEnd(12)} vmax ${vmax[family].toFixed(2)} m/s`);
}

crossCheckLocalPush();
console.log('\ncross-check localPush() vs pushOf() (à R_HOLD actuel) : ok');

console.log(`\nR_HOLD self-consistant par famille (marge visée ${MARGIN_M} m), trace de l'itération :`);
const perFamily = {};
let worstImpact = 0;
for (const family of FAMILIES) {
	const { rHold, trace, maxImpact } = findRHold(family);
	perFamily[family] = rHold;
	worstImpact = Math.max(worstImpact, maxImpact);
	const t = trace.map((s) => `${s.trial.toFixed(1)}→${s.d.toFixed(1)}`).join('  ');
	console.log(`  ${family.padEnd(12)} R_HOLD* ${rHold.toFixed(2)} m   [${t}]   maxImpact ${maxImpact.toFixed(1)} N`);
}

if (worstImpact > 0) {
	console.log(`\n  ATTENTION : impact non nul détecté (${worstImpact.toFixed(1)} N) — le drone a`);
	console.log(`  percuté la scène réelle pendant la mesure. Les chiffres ci-dessus sont faux.`);
}

const worstFamily = FAMILIES.reduce((a, c) => (perFamily[c] > perFamily[a] ? c : a));
const worstVFamily = FAMILIES.reduce((a, c) => (vmax[c] > vmax[a] ? c : a));
const worstV = vmax[worstVFamily];

const rHold = Math.ceil(perFamily[worstFamily]);
const rCaution = Math.ceil(rHold + BLINKS_TO_READ * BLINK_PERIOD_S * worstV);

console.log(`\n  A_MAX             ${A_MAX.toFixed(3)} m/s²`);
console.log(`  pire R_HOLD*      ${perFamily[worstFamily].toFixed(2)} m (${worstFamily})`);
console.log(`  pire vmax         ${worstV.toFixed(2)} m/s (${worstVFamily})`);
console.log(`\n  R_HOLD    = ${rHold}`);
console.log(`  R_CAUTION = ${rCaution}   (= R_HOLD + ${BLINKS_TO_READ} × ${BLINK_PERIOD_S} s × ${worstV.toFixed(2)} m/s)`);
console.log(`\n  → reporter ces deux valeurs dans src/geofence.js, avec la date.`);
