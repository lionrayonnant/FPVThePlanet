// Mesure les seuils de détection de pose (PHASE 14) et vérifie qu'ils tiennent.
//
//   node tools/landing-selftest.mjs [sceneDir]
//   node tools/landing-selftest.mjs --report      # imprime les distributions
//
// Deux familles de trajectoires sont rejouées dans le vrai Rapier :
//   - des poses     : le drone doit être reconnu comme posé (dont un rebond
//                     et un roulé à spin résiduel, qui doivent l'être aussi,
//                     mais pas trop tôt — voir `notBefore` sur ces cas) ;
//   - des rasants   : bas et rapides, ils ne doivent JAMAIS l'être. C'est le
//                     faux positif que l'issue #51 interdit, et c'est lui qui
//                     fixe la marge.
// Les seuils de src/flight-end.js sont posés dans la zone de séparation
// observée. CLAUDE.md : mesurés, pas choisis à la main.
import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics } from '../src/physics.js';
import { FlightController } from '../src/flightController.js';
import { FlightEnd, LANDING, LANDING_READY } from '../src/flight-end.js';
import { idleThrottle } from '../src/quad.js';

const args = process.argv.slice(2);
const REPORT = args.includes('--report');
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
const SPAWN = manifest.spawn;

// Le seuil de « gaz coupés » de la famille en vol ici (freestyle5, le profil
// par défaut de Physics) — dérivé, pas les 0,06 en dur d'avant PHASE 14 (voir
// idleThrottle, src/quad.js). Rejoué à la fois dans le garde `touchdown`
// ci-dessous (fidèle à celui de main.js) et dans le `landing` passé à
// `FlightEnd` par `detects()`.
const THR_IDLE = idleThrottle(phys.profile);

const ZERO = { x: 0, y: 0, z: 0 };
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };

// Repose le corps à `height` mètres au-dessus du sol, à plat, immobile. Au
// spawn par défaut ; x/z permettent de reposer ailleurs (pose sur pente,
// correction 4 de la revue finale).
function place(height, vel = ZERO, x = SPAWN.x, z = SPAWN.z) {
	const g = phys.groundBelow(x, SPAWN.y + 200, z) ?? SPAWN.y;
	phys.body.setTranslation({ x, y: g + height, z }, true);
	phys.body.setRotation(LEVEL, true);
	phys.body.setLinvel(vel, true);
	phys.body.setAngvel(ZERO, true);
	phys.setGroundHold(false);
	return g;
}

function heightNow() {
	const p = phys.position;
	const g = phys.groundBelow(p.x, p.y, p.z);
	return g === null ? Infinity : p.y - g;
}

// Rejoue une trajectoire et rend la trace de ce que la machine à états verrait.
// `sticks(t, state)` rend les manches ; `seconds` la durée simulée. `angvel`
// impose une vitesse angulaire de départ (le cas « roulé » : un contact avec
// du spin résiduel, pas une chute propre).
function fly({ sticks, seconds, mode = 'acro', windless = true, angvel = null }) {
	const fc = new FlightController();
	fc.setMode(mode);
	fc.arm();
	if (windless) phys.setWind(ZERO, 0);
	if (angvel) phys.body.setAngvel(angvel, true);
	const trace = [];
	const steps = Math.round(seconds / STEP);
	for (let i = 0; i < steps; i++) {
		const t = i * STEP;
		const h = heightNow();
		const s = sticks(t, { height: h, velocity: phys.velocity });
		// Même règle que main.js : gaz coupés au ras du sol → moteurs à zéro et
		// groundHold, sinon une sphère de collision roule sans fin. THR_IDLE est
		// le seuil dérivé de la famille en vol, pas 0,06 en dur.
		const touchdown = s.throttle < THR_IDLE && h < 0.6;
		phys.setGroundHold(touchdown);
		const { motors } = fc.update(s, phys, STEP);
		if (touchdown) motors.fill(0);
		phys.step(motors, STEP);
		const v = phys.velocity, w = phys.angularVelocity;
		trace.push({
			t,
			height: heightNow(),
			speed: Math.hypot(v.x, v.y, v.z),
			angularSpeed: Math.hypot(w.x, w.y, w.z),
			throttle: s.throttle,
		});
	}
	return trace;
}

const stick = (over = {}) => ({ throttle: 0, roll: 0, pitch: 0, yaw: 0, ...over });

// --- les poses -------------------------------------------------------------
// Descente gaz coupés depuis trois hauteurs, puis on laisse le drone s'immobiliser.
const LANDINGS = [1, 3, 8].map((h) => ({
	name: `pose depuis ${h} m`,
	run: () => { place(h); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 6 }); },
}));

// Pose vent de travers : le drone est poussé pendant qu'il se pose.
LANDINGS.push({
	name: 'pose par vent de travers (8 m/s)',
	run: () => {
		place(3);
		const fc = { sticks: () => stick({ throttle: 0 }) };
		phys.setWind({ x: 8, y: 0, z: 0 }, 0.3);
		const trace = fly({ ...fc, seconds: 8, windless: false });
		phys.setWind(ZERO, 0);
		return trace;
	},
});

// Gaz pas tout à fait coupés (issue « trop dur à poser », PHASE 14) : le
// pilote descend avec un manche à mi-chemin entre 0 et THR_IDLE, pas à zéro
// franc. C'est exactement la fenêtre que l'ancien seuil (0,06 en dur) fermait
// à tort pour les familles peu chargées — sans ce cas, rien ne verrouille que
// la fenêtre a bien été élargie plutôt que juste déplacée.
LANDINGS.push({
	name: `pose gaz mi-fenêtre (throttle=${(THR_IDLE / 2).toFixed(3)})`,
	run: () => { place(3); return fly({ sticks: () => stick({ throttle: THR_IDLE / 2 }), seconds: 6 }); },
});

// Rebond (section D5 de la spec, absent du brief initial) : chute assez dure
// pour que la restitution du sol (0.15, voir physics.js) fasse un contact
// bref, un décollage, un re-contact, avant que ça s'immobilise pour de bon.
// `notBefore` verrouille ce que le test doit prouver : la pose ne doit être
// reconnue ni pendant le premier contact (t~0.26-0.30s, hauteur basse mais
// vitesse encore >1 m/s) ni pendant l'arc du rebond (t~0.30-0.61s, hauteur
// remontée au-dessus de H_ON) — seulement une fois le second contact
// vraiment digéré, mesuré ici après t=0.6s.
LANDINGS.push({
	name: 'pose avec rebond (chute vy=-10 m/s depuis 3 m)',
	notBefore: 0.6,
	run: () => { place(3, { x: 0, y: -10, z: 0 }); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 6 }); },
});

// Roulé au sol, spin résiduel au contact (section D5). Mesuré : quelle que
// soit l'intensité du spin imposé (essayé jusqu'à 20 rad/s, bien au-delà
// d'un impact réaliste), le roulis retombe sous W_ON très vite — c'est le
// `setGroundHold` de physics.js qui l'amortit, pas W_ON : ce n'est pas une
// pose qui « échappe » indéfiniment, c'est un régime transitoire qui
// s'éteint. Reclassé ici en pose retardée plutôt qu'en rasant : il n'y a pas
// de configuration physique où ce roulis ne se pose « jamais ».
// `notBefore` vérifie ce que W_ON doit vraiment garantir : pas de détection
// tant que le spin est encore visible.
// Le plancher valait 0,45 s tant que le ground hold n'amortissait la
// rotation qu'exponentiellement (le spin mettait ~0,5 s à passer sous W_ON).
// Depuis que la friction statique l'annule au lieu de l'asymptoter (voir
// physics.js), le même spin de 8 rad/s tombe à zéro en 0,07 s (mesuré
// 2026-08-29 : 7,63 · 5,92 · 4,44 · 0,44 · 0,00 rad/s à 20 ms d'intervalle)
// — un quad qui percute le sol sur ses pieds ne continue pas de tourner une
// demi-seconde. La détection tombe donc à 0,31 s, soit l'extinction du spin
// plus T_HOLD : c'est exactement l'invariant que ce plancher protège, et
// c'est lui qu'on écrit, à 0,3 s.
LANDINGS.push({
	name: 'roulé au sol (spin résiduel 8 rad/s au contact)',
	notBefore: 0.3,
	run: () => { place(0.16); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 6, angvel: { x: 8, y: 0, z: 0 } }); },
});

// --- pose sur pente (D5, correction 4 de la revue finale) ------------------
// La spec liste « posé sur pente » parmi les trajectoires à rejouer ; elle
// manquait au banc. Ce n'est pas cosmétique : `height` est un raycast
// vertical depuis le centre d'une sphère de rayon 0,15 m, donc une sphère
// posée sur une pente d'angle θ mesure 0,15 / cos θ sous elle — 0,1488 m à
// plat (voir plus haut), donc géométriquement au-delà d'environ 41° pour un
// H_ON de 0,2 la détection ne peut plus déclencher.
//
// On cherche une vraie pente dans la scène plutôt que d'en deviner une :
// balayage de `groundBelow` sur une grille autour du spawn, pente estimée
// par différence finie centrée (pas 0,3 m) dans les deux directions
// horizontales — la normale du terrain n'est jamais lue directement, mais sa
// composante verticale se déduit de la hauteur sondée aux quatre voisins.
function slopeAngleAt(x, z, d = 0.3) {
	const xp = phys.groundBelow(x + d, SPAWN.y + 200, z);
	const xm = phys.groundBelow(x - d, SPAWN.y + 200, z);
	const zp = phys.groundBelow(x, SPAWN.y + 200, z + d);
	const zm = phys.groundBelow(x, SPAWN.y + 200, z - d);
	if (xp === null || xm === null || zp === null || zm === null) return null;
	return Math.atan(Math.hypot((xp - xm) / (2 * d), (zp - zm) / (2 * d))) * 180 / Math.PI;
}

// Cherche, sur un carré de 60 m autour du spawn, la facette la plus proche de
// `targetDeg`. Mesuré sur tour-eiffel (2026-08-29) : viser 30° trouve une
// facette à 30,0° — c'est la pente la plus raide qui se stabilise dans les
// seuils actuels. Ce n'est pas la hauteur qui borne (H_ON=0,2 reste large
// jusqu'à ~41° géométriquement) : au-delà de l'angle de friction du ground
// hold (atan(0,6) ≈ 31°, voir physics.js) la sphère glisse et quitte la
// pente — mesuré à 35° avant correction, elle retombait 18 m plus bas.
//
// Le fluage résiduel qui bloquait jadis toute pente au-delà de ~30° (la
// vitesse angulaire ne redescendait plus sous W_ON, 0,37 rad/s en fin de
// trace à 33°) n'était pas une limite du modèle mais un défaut : le ground
// hold amortissait la vitesse sans jamais l'annuler. C'est corrigé dans
// physics.js — la friction statique l'annule — et la section « poses
// réparties » ci-dessous verrouille le résultat sur du terrain réel.
function findSlope(targetDeg, radius = 60, step = 1) {
	let best = null;
	for (let x = SPAWN.x - radius; x <= SPAWN.x + radius; x += step) {
		for (let z = SPAWN.z - radius; z <= SPAWN.z + radius; z += step) {
			const angle = slopeAngleAt(x, z);
			if (angle === null) continue;
			if (!best || Math.abs(angle - targetDeg) < Math.abs(best.angle - targetDeg)) best = { x, z, angle };
		}
	}
	return best;
}

const SLOPE = findSlope(30);
LANDINGS.push({
	name: `pose sur pente (${SLOPE.angle.toFixed(1)}°, x=${SLOPE.x} z=${SLOPE.z})`,
	run: () => { place(3, ZERO, SLOPE.x, SLOPE.z); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 6 }); },
});

// --- poses réparties dans la scène (issue « pose impossible ») -------------
// Un seul emplacement de pose ne dit rien : celui du spawn se trouve être
// plat. Mesuré le 2026-08-29 sur une grille de 5 m autour du spawn de
// tour-eiffel, 81 emplacements rejoués 12 s chacun : seulement 20 étaient
// reconnus. Sur les 61 autres — des pentes de 1 à 3°, pas des falaises — la
// vitesse angulaire se stabilisait entre 0,07 et 0,38 rad/s et n'en
// redescendait jamais : la sphère de collision flue le long de la pente, et
// l'amortissement exponentiel de setGroundHold l'amortit sans l'annuler.
// C'est un régime permanent, pas un transitoire : attendre plus longtemps ne
// sert à rien. En jeu, le joueur pose, appuie sur J, et rien ne se passe.
//
// Une pose doit être reconnue là où le joueur se pose, pas seulement sur la
// dalle du spawn. La grille est plus lâche que celle de la mesure (25 points
// au lieu de 81) pour tenir dans le temps du banc.
const SPOTS = [];
for (let dx = -20; dx <= 20; dx += 10) {
	for (let dz = -20; dz <= 20; dz += 10) {
		const x = SPAWN.x + dx, z = SPAWN.z + dz;
		// Les emplacements sans sol sous eux (bord de scène) ne sont pas des
		// emplacements de pose : on ne les compte pas.
		if (phys.groundBelow(x, SPAWN.y + 200, z) === null) continue;
		const angle = slopeAngleAt(x, z);
		// Au-delà de la limite géométrique du raycast vertical (voir
		// findSlope ci-dessus), ce n'est plus une pose mais une paroi.
		if (angle === null || angle > 30) continue;
		SPOTS.push({ x, z, angle });
	}
}
for (const sp of SPOTS) {
	LANDINGS.push({
		name: `pose répartie (pente ${sp.angle.toFixed(1)}°, x=${sp.x.toFixed(0)} z=${sp.z.toFixed(0)})`,
		run: () => { place(3, ZERO, sp.x, sp.z); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 8 }); },
	});
}

// --- les rasants (faux positifs) -------------------------------------------
// Passage bas et rapide : mode altitude pour tenir la hauteur, tangage plein
// pot pour la vitesse.
//
// Un rasant qui rejette la détection ne prouve rien à lui seul (correction 5,
// revue finale) : si un changement de physique le faisait décrocher, se
// crasher, ou simplement ralentir jusqu'à quasi rien, il « rejetterait »
// encore, pour la mauvaise raison. Chaque cas porte donc en plus un plancher
// de vitesse et une bande de hauteur visée, tous deux mesurés sur les traces
// mêmes que le banc rejoue (2026-08-29, tour-eiffel).
//
// La vitesse de croisière atteinte ne dépend quasiment que du tangage, pas de
// la hauteur visée : minimum observé sur les trois hauteurs, 4,642 / 9,134 /
// 15,974 m/s pour tangage 0,3 / 0,6 / 1. Les planchers ci-dessous gardent
// ~15 % de marge — assez pour ne pas être un test fragile, assez peu pour
// détecter une régression qui casserait la propulsion ou le contrôleur.
const SPEED_FLOOR = { 0.3: 4.0, 0.6: 7.7, 1.0: 13.5 };

const PASSES = [];
for (const h of [0.3, 0.6, 1.0]) {
	for (const push of [0.3, 0.6, 1.0]) {
		PASSES.push({
			name: `rasant ${h} m, tangage ${push}`,
			speedFloor: SPEED_FLOOR[push],
			// Bande de hauteur visée : mesurée à h+0,22 m dans le pire cas (0,3 m /
			// tangage 1) et h-0,29 m dans l'autre (0,6 m / tangage 1). ±0,35 m
			// garde de la marge sur ces deux extrêmes sans laisser passer un
			// décrochage (hauteur qui s'effondre) ou un envol (hauteur qui dérive).
			heightBand: [Math.max(0.05, h - 0.35), h + 0.35],
			run: () => {
				place(h + 0.2);
				return fly({
					mode: 'altitude',
					seconds: 6,
					sticks: (t, st) => stick({
						// Servo d'altitude simple autour de la hauteur visée : le mode
						// altitude tient la sienne, ce P la ramène sur la nôtre.
						throttle: Math.max(0, Math.min(1, 0.5 + (h - st.height) * 0.5)),
						pitch: t > 0.5 ? push : 0,
					}),
				});
			},
		});
	}
}

// Stationnaire bas : lent, bas, mais gaz mis — ce n'est pas une pose.
PASSES.push({
	name: 'stationnaire bas (gaz mis)',
	run: () => {
		place(0.5);
		return fly({
			mode: 'altitude', seconds: 6,
			sticks: (t, st) => stick({ throttle: Math.max(0, Math.min(1, 0.5 + (0.5 - st.height) * 0.5)) }),
		});
	},
});

// --- mesure ----------------------------------------------------------------
// Ce que la machine verrait sur cette trace : est-elle passée en LANDING_READY ?
function detects(trace) {
	// Même THR_IDLE que le garde `touchdown` ci-dessus (main.js les fait
	// coïncider en injectant la même valeur dérivée aux deux endroits).
	const fe = new FlightEnd({ landing: { ...LANDING, THR_IDLE } });
	for (let i = 1; i < trace.length; i++) {
		const s = trace[i];
		fe.update({ dt: STEP, armed: true, crashed: false, ...s });
		if (fe.phase === LANDING_READY) return s.t;
	}
	return null;
}

// La fenêtre stable de fin de trace : ce que « posé » vaut réellement ici.
function tail(trace, seconds = 1.5) {
	const from = trace[trace.length - 1].t - seconds;
	return trace.filter((s) => s.t >= from);
}
const maxOf = (rows, key) => rows.reduce((m, r) => Math.max(m, r[key]), 0);

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

console.log('\nposes');
const landStats = [];
for (const c of LANDINGS) {
	const trace = c.run();
	const end = tail(trace);
	const at = detects(trace);
	landStats.push({ name: c.name, h: maxOf(end, 'height'), v: maxOf(end, 'speed'), w: maxOf(end, 'angularSpeed') });
	check(`${c.name} : reconnue`, at !== null,
		at === null ? 'jamais détectée' : `à t=${at.toFixed(2)}s`);
	// Cas à rebond/roulis : la reconnaissance doit aussi arriver assez tard,
	// pas seulement finir par arriver — sinon le test ne prouve rien de plus
	// que les descentes propres ci-dessus.
	if (c.notBefore !== undefined && at !== null) {
		check(`${c.name} : pas avant t=${c.notBefore}s`, at >= c.notBefore,
			`détectée à t=${at.toFixed(2)}s`);
	}
}

console.log('\nrasants (aucun ne doit être reconnu)');
const passStats = [];
for (const c of PASSES) {
	const trace = c.run();
	const at = detects(trace);
	const flying = trace.filter((s) => s.t > 1);
	const minH = Math.min(...flying.map((s) => s.height));
	const maxH = Math.max(...flying.map((s) => s.height));
	const maxV = Math.max(...flying.map((s) => s.speed));
	passStats.push({ name: c.name, h: Math.min(...flying.map((s) => s.height)), v: Math.min(...flying.map((s) => s.speed)) });
	check(`${c.name} : rejeté`, at === null, at === null ? '' : `faux positif à t=${at.toFixed(2)}s`);
	// Un rasant qui ne rejette pas la détection pour la bonne raison (il vole
	// toujours bas et vite) échoue quand même (correction 5) : la vitesse
	// atteinte doit dépasser la cible mesurée, et la hauteur rester dans la
	// bande visée du bout en bout.
	if (c.speedFloor !== undefined) {
		check(`${c.name} : vitesse atteinte >= ${c.speedFloor}m/s`, maxV >= c.speedFloor, `mesuré ${maxV.toFixed(2)}m/s`);
	}
	if (c.heightBand) {
		const [lo, hi] = c.heightBand;
		check(`${c.name} : hauteur dans [${lo.toFixed(2)}, ${hi.toFixed(2)}]m`, minH >= lo && maxH <= hi,
			`mesuré [${minH.toFixed(3)}, ${maxH.toFixed(3)}]m`);
	}
}

if (REPORT) {
	console.log('\nposes — fin de trace (max sur 1,5 s) :');
	for (const s of landStats) console.log(`  ${s.name.padEnd(34)} h=${s.h.toFixed(3)}m v=${s.v.toFixed(3)}m/s w=${s.w.toFixed(3)}rad/s`);
	console.log('\nrasants — minimums en vol :');
	for (const s of passStats) console.log(`  ${s.name.padEnd(34)} h=${s.h.toFixed(3)}m v=${s.v.toFixed(3)}m/s`);
	const hPose = Math.max(...landStats.map((s) => s.h));
	const vPose = Math.max(...landStats.map((s) => s.v));
	const vPass = Math.min(...passStats.map((s) => s.v));
	console.log(`\nséparation : hauteur posée <= ${hPose.toFixed(3)}m · vitesse posée <= ${vPose.toFixed(3)}m/s · vitesse rasante >= ${vPass.toFixed(3)}m/s`);
	console.log(`seuils actuels : H_ON=${LANDING.H_ON} V_ON=${LANDING.V_ON} W_ON=${LANDING.W_ON} T_HOLD=${LANDING.T_HOLD}`);
}

console.log(failures ? `\n${failures} échec(s)` : '\nOK');
process.exit(failures ? 1 : 0);
