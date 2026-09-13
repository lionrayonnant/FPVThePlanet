// node tools/onboard-regime-selftest.mjs — what the props are saying (issue
// #264). This does not test the rendering, but the PHYSICS the rendering gives
// the viewer to read: which motor speeds up on which stick, and how the rpm
// answers to time and to the battery.
import { Propulsion, mixOf, idleThrottle } from '../src/quad.js';
import { PROFILES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const STILL = { v: { x: 0, y: 0, z: 0 }, omega: null, agl: null, shake: 0 };
const profile = PROFILES.freestyle5;
const mix = mixOf(profile);

// Motor commands for a given stick, through the real mixer.
const cmd = (thr, { roll = 0, pitch = 0, yaw = 0 } = {}) =>
	mix.map((m) => Math.max(0, Math.min(1, thr + m.roll * roll + m.pitch * pitch + m.yaw * yaw)));

const settle = (motors, seconds = 1.5) => {
	const p = new Propulsion({ profile, seed: 1 });
	const dt = 1 / 250;
	for (let i = 0; i < seconds / dt; i++) p.step(motors, STILL, dt);
	return p;
};

console.log('onboard-regime');

// 1. Yaw, the central promise: the two props IN FRAME are the front ones —
//    motors 1 (front right, spin -1) and 3 (front left, spin +1) — so two
//    opposite diagonals. quad.js sets yaw: -m.spin and its comment fixes the
//    direction: "yaw left = +omega.y -> spin-down motors up".
{
	const left = settle(cmd(0.5, { yaw: +1 }));
	check('yaw left: the front right speeds up, the front left slows down',
		left.omega[1] > left.omega[3], `${left.omega[1].toFixed(0)} vs ${left.omega[3].toFixed(0)} rad/s`);
	const right = settle(cmd(0.5, { yaw: -1 }));
	check('yaw right: the other way round', right.omega[1] < right.omega[3],
		`${right.omega[1].toFixed(0)} vs ${right.omega[3].toFixed(0)} rad/s`);
	check('yaw: the two front props turn opposite ways in the mixer',
		Math.sign(mix[1].yaw) === -Math.sign(mix[3].yaw));
}

// 2. Pitch moves the two front props TOGETHER. Roll SEPARATES them — and it has
//    to be said exactly: mixOf() gives all four motors a non-zero roll
//    coefficient, and the two front ones sit on either side of the axis, so on
//    the visible pair roll has the SAME sign signature as yaw. Issue #264
//    claimed "roll only moves one of them": that is wrong. Of the two props in
//    frame, only pitch has a signature of its own.
{
	const p = settle(cmd(0.5, { pitch: +0.5 }));
	const neutral = settle(cmd(0.5));
	const d1 = p.omega[1] - neutral.omega[1], d3 = p.omega[3] - neutral.omega[3];
	check('pitch: the two props in frame go the same way',
		Math.sign(d1) === Math.sign(d3) && Math.abs(d1) > 1, `${d1.toFixed(0)} / ${d3.toFixed(0)}`);
	const r = settle(cmd(0.5, { roll: +0.5 }));
	const r1 = r.omega[1] - neutral.omega[1], r3 = r.omega[3] - neutral.omega[3];
	check('roll: they go opposite ways',
		Math.sign(r1) === -Math.sign(r3), `${r1.toFixed(0)} / ${r3.toFixed(0)}`);
}

// 3. The asymmetry of the motor lag: props wind up sharply and come back down
//    slowly. It used to be asserted twice — once as behaviour, and once as
//    `profile.tauSpinDown > profile.tauSpinUp`, which was reading the input
//    data back rather than testing anything. Since src/motor.js there is no
//    such field to read: the asymmetry is a CONSEQUENCE of the ESC only
//    letting part of the regenerative current through, so going up the motor
//    is driven and coming down it is not. It can therefore only be measured,
//    which is what both checks below now do.
{
	const p = new Propulsion({ profile, seed: 1 });
	const dt = 1 / 250;
	for (let i = 0; i < 250; i++) p.step(cmd(0.3), STILL, dt);
	const base = p.omega[0];
	for (let i = 0; i < 25; i++) p.step(cmd(0.9), STILL, dt);   // 0.1 s winding up
	const up = p.omega[0] - base;
	for (let i = 0; i < 25; i++) p.step(cmd(0.3), STILL, dt);   // 0.1 s coming down
	const down = p.omega[0] - base;
	// The plan's `|| up > 0` made this tautological: `up` is positive the moment
	// the stick rises. Only the branch that bites is kept — over the SAME 0.1 s
	// window, the climb gains more than the fall gives back.
	check('winding up is steeper than coming down', up > Math.abs(down - up),
		`+${up.toFixed(0)} then ${(down - up).toFixed(0)} rad/s`);

	// The same asymmetry as a time constant, measured from the model rather than
	// read off the profile: how long each direction takes to cover 63% of the
	// same rpm step.
	const tau = (from, to) => {
		const q = new Propulsion({ profile, seed: 1 });
		for (let i = 0; i < 500; i++) q.step(cmd(from), STILL, dt);
		const start = q.omega[0];
		const target = settle(cmd(to), 3).omega[0];
		for (let i = 0; i < 500; i++) {
			q.step(cmd(to), STILL, dt);
			if (Math.abs(q.omega[0] - start) >= 0.632 * Math.abs(target - start)) return (i + 1) * dt;
		}
		return Infinity;
	};
	const tUp = tau(0.3, 0.9), tDown = tau(0.9, 0.3);
	check('spin-down is slower than spin-up, as a measured time constant',
		tDown > tUp, `up ${(tUp * 1000).toFixed(0)} ms, down ${(tDown * 1000).toFixed(0)} ms`);
}

// 4. The battery: "Motor rpm tracks voltage, so a sagging pack lowers the
//    ceiling on thrust". The props announce the dying pack. The pack is emptied
//    by its CHARGE, not by its voltage: `voltage` is a derived value that
//    `Battery.update()` recomputes on every step from `openCircuit()`, and so
//    from `usedMah`. Writing to it by hand does not survive the first step, and
//    the two propulsions end up at the same rpm.
{
	const full = settle(cmd(0.8), 1.0);
	const flat = new Propulsion({ profile, seed: 1 });
	flat.battery.usedMah = 0.9 * profile.battery.capacityMah;   // ~9% of charge
	const dt = 1 / 250;
	for (let i = 0; i < 250; i++) flat.step(cmd(0.8), STILL, dt);
	// The 5% threshold leaves the sag model room to move without the check
	// becoming a comparison of neighbouring floats.
	check('empty pack: the rpm ceiling comes down', flat.omega[0] < 0.95 * full.omega[0],
		`${flat.omega[0].toFixed(0)} < ${full.omega[0].toFixed(0)} rad/s, i.e. ${(full.omega[0] - flat.omega[0]).toFixed(0)} less`);
}

// 5. At idle the rpm is low but not zero: this is the case where the blades can
//    be told apart one by one in frame.
{
	const idle = settle(cmd(idleThrottle(profile)));
	check('idle: low rpm, and not zero', idle.omega[0] > 0 && idle.omega[0] < 0.6 * profile.maxOmega,
		`${idle.omega[0].toFixed(0)} rad/s out of ${profile.maxOmega}`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
