// Mesure les seuils de détection de pose (PHASE 14) et vérifie qu'ils tiennent.
//
//   node tools/landing-selftest.mjs [sceneDir]
//   node tools/landing-selftest.mjs --report      # imprime les distributions
//
// Deux familles de trajectoires sont rejouées dans le vrai Rapier :
//   - des poses     : le drone doit être reconnu comme posé ;
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

const ZERO = { x: 0, y: 0, z: 0 };
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };

// Repose le corps à `height` mètres au-dessus du sol du spawn, à plat, immobile.
function place(height, vel = ZERO) {
	const g = phys.groundBelow(SPAWN.x, SPAWN.y + 200, SPAWN.z) ?? SPAWN.y;
	phys.body.setTranslation({ x: SPAWN.x, y: g + height, z: SPAWN.z }, true);
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
// `sticks(t, state)` rend les manches ; `seconds` la durée simulée.
function fly({ sticks, seconds, mode = 'acro', windless = true }) {
	const fc = new FlightController();
	fc.setMode(mode);
	fc.arm();
	if (windless) phys.setWind(ZERO, 0);
	const trace = [];
	const steps = Math.round(seconds / STEP);
	for (let i = 0; i < steps; i++) {
		const t = i * STEP;
		const h = heightNow();
		const s = sticks(t, { height: h, velocity: phys.velocity });
		// Même règle que main.js : gaz coupés au ras du sol → moteurs à zéro et
		// groundHold, sinon une sphère de collision roule sans fin.
		const touchdown = s.throttle < 0.06 && h < 0.6;
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

// --- les rasants (faux positifs) -------------------------------------------
// Passage bas et rapide : mode altitude pour tenir la hauteur, tangage plein
// pot pour la vitesse.
const PASSES = [];
for (const h of [0.3, 0.6, 1.0]) {
	for (const push of [0.3, 0.6, 1.0]) {
		PASSES.push({
			name: `rasant ${h} m, tangage ${push}`,
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
	const fe = new FlightEnd();
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
}

console.log('\nrasants (aucun ne doit être reconnu)');
const passStats = [];
for (const c of PASSES) {
	const trace = c.run();
	const at = detects(trace);
	const flying = trace.filter((s) => s.t > 1);
	passStats.push({ name: c.name, h: Math.min(...flying.map((s) => s.height)), v: Math.min(...flying.map((s) => s.speed)) });
	check(`${c.name} : rejeté`, at === null, at === null ? '' : `faux positif à t=${at.toFixed(2)}s`);
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
