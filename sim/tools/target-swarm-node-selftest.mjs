// node tools/target-swarm-node-selftest.mjs — the swarmNode family
// (issue #29, "swarmNode" section). Not a target-scan family: reachable only
// through a swarm cluster's forced family, never an ordinary candidate and
// never an ambient. This checks the two halves of that promise:
//
//   1. swarmNode is a real, INVARIANTS-respecting, radius=0.15 family, exactly
//      like any of the six flyable ones — targetBuild()/shapeOf() must not
//      need to special-case it.
//   2. it is invisible to the ordinary scan machinery: absent from
//      FAMILY_CLASS, TARGET_FAMILIES and drone-profiles.js's own FAMILIES.

import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { targetBuild, INVARIANTS, thrustToWeight } from './target-build.mjs';
import { FAMILY_CLASS, TARGET_FAMILIES } from './target-model.mjs';
import { targetCamera, CAMERA_FAMILIES } from './target-camera.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`); }
	else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const FAMILY = 'swarmNode';
const base = PROFILES[FAMILY];

check('swarmNode exists in PROFILES', !!base);

// --- invisible to the ordinary scan
check('absent from FAMILIES (src/drone-profiles.js)', !FAMILIES.includes(FAMILY));
check('absent from FAMILY_CLASS (tools/target-model.mjs)', !(FAMILY in FAMILY_CLASS));
check('absent from TARGET_FAMILIES', !TARGET_FAMILIES.includes(FAMILY));

// --- radius : constraint 4, never anything but the collision sphere
check('radius === 0.15', base.radius === 0.15);

// --- family identity intact across drawn builds (issue #44's rule, checked
// here the same way target-build-selftest.mjs checks it for the six flyable
// families — targetBuild() has no idea swarmNode is absent from FAMILIES)
{
	const N = 500;
	let bad = '';
	for (let i = 0; i < N; i++) {
		const seed = `swarm-node-${i}`;
		const { profile } = targetBuild({ seed, family: FAMILY });
		for (const key of INVARIANTS) {
			if (profile[key] !== base[key]) { bad = `${seed}: ${key}`; break; }
		}
		if (profile.battery.cells !== base.battery.cells) bad ||= `${seed}: battery.cells`;
		if (JSON.stringify(profile.pid) !== JSON.stringify(base.pid)) bad ||= `${seed}: pid`;
		if (bad) break;
	}
	check(`family identity intact across ${N} draws`, !bad, bad);
}

// --- exactly the starting sheet from the brief
check('label', base.label === 'SWARM NODE');
check('rates', base.rates === 'cinematic');
check('mass', base.mass === 0.95);
check('armX/armZ', base.armX === 0.090 && base.armZ === 0.090);
check('propRadius', base.propRadius === 0.0762);
check('bladeCount', base.bladeCount === 3);
check('maxThrustPerMotor', base.maxThrustPerMotor === 10.5);
check('battery 6S 2200 mAh', base.battery.cells === 6 && base.battery.capacityMah === 2200);

// --- pid was actually measured at the bench, not left on freestyle5
check('pid differs from the freestyle5 tune (bench written, not left default)',
	JSON.stringify(base.pid) !== JSON.stringify(PROFILES.freestyle5.pid));

// --- plausible TWR for a heavy 6" (the brief targets ~4.5)
{
	const twr = thrustToWeight(base);
	check('TWR ~= 4.5', Math.abs(twr - 4.5) < 0.3, `twr=${twr.toFixed(2)}`);
}

// --- targetCamera() accepts the family (moderate uptilt, an observation machine)
{
	check('CAMERA_FAMILIES covers swarmNode', FAMILY in CAMERA_FAMILIES);
	const table = CAMERA_FAMILIES[FAMILY];
	for (let i = 0; i < 200; i++) {
		const c = targetCamera({ seed: `swarm-node-cam-${i}`, family: FAMILY });
		if (c.uptiltDeg < table.uptiltDeg[0] || c.uptiltDeg > table.uptiltDeg[1]) {
			fail++;
			console.log(`  FAIL  uptilt out of bounds — ${c.uptiltDeg}`);
			break;
		}
	}
	pass++;
	console.log('  ok  targetCamera(swarmNode) stays within its table over 200 draws');
	// Moderate: neither a race (25-45deg) nor a near-level cinewhoop (0-10deg).
	check('moderate uptilt (10-20deg, between cinewhoop and race)',
		table.uptiltDeg[0] >= 10 && table.uptiltDeg[1] <= 20);
}

console.log(`\n${pass} tests target-swarm-node OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
