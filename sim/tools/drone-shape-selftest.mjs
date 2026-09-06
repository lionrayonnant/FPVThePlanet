// node tools/drone-shape-selftest.mjs — la recette PURE du quad (issue #250).
import { shapeOf } from '../src/drone-shape.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const roles = (s, role) => s.parts.filter((p) => p.role === role);
const make = (family, seed = `shape::${family}`) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }) });
};

console.log('drone-shape');
for (const family of FAMILIES) {
	const s = make(family);
	check(`${family}: 4 bras, 4 moteurs, 4 hélices`, roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
	check(`${family}: une plaque, une caméra, une batterie, une LED`, roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
	const prop = roles(s, 'prop')[0];
	check(`${family}: disque = propRadius`, Math.abs(prop.size[0] - PROFILES[family].propRadius) < 1e-9);
	const motors = roles(s, 'motor');
	check(`${family}: moteurs à (±armX, ±armZ)`, motors.every((m) => Math.abs(Math.abs(m.at[0]) - PROFILES[family].armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - PROFILES[family].armZ) < 1e-9));
	check(`${family}: rayon englobant > hypot(arm) + prop`, s.boundingRadius >= Math.hypot(PROFILES[family].armX, PROFILES[family].armZ) + PROFILES[family].propRadius);
	check(`${family}: toutes les pièces sous le rayon englobant`, s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
	check(`${family}: caméra inclinée du uptilt`, Math.abs(roles(s, 'camera')[0].rotX - targetCamera({ seed: `shape::${family}`, family }).uptiltDeg * Math.PI / 180) < 1e-9);
	check(`${family}: LED à l'arrière (+Z)`, roles(s, 'led')[0].at[2] > 0);
	check(`${family}: caméra à l'avant (−Z)`, roles(s, 'camera')[0].at[2] < 0);
}
check('long range : disques de 88,9 mm', Math.abs(roles(make('longrange'), 'prop')[0].size[0] - 0.0889) < 1e-4);
check('micro : deux pales', roles(make('toothpick'), 'prop')[0].blades === 2);
check('micro : empattement 76 mm', Math.abs(2 * PROFILES.toothpick.armX - 0.076) < 1e-3);
check('cinewhoop : 4 conduits', roles(make('cinewhoop'), 'duct').length === 4);
check('micro : 4 conduits', roles(make('toothpick'), 'duct').length === 4);
check('race : pas de conduit', roles(make('race5'), 'duct').length === 0);
check('cinewhoop : une GoPro', roles(make('cinewhoop'), 'gopro').length === 1);
check('long range : deux antennes', roles(make('longrange'), 'antenna').length === 2);
check('race : une antenne', roles(make('race5'), 'antenna').length === 1);
check('heavy : plaque de 10 mm', Math.abs(roles(make('heavy5'), 'plate')[0].size[1] - 0.010) < 1e-9);
check('freestyle : plaque de 6 mm', Math.abs(roles(make('freestyle5'), 'plate')[0].size[1] - 0.006) < 1e-9);
{
	// Batterie : longueur = 20 mm · cells.
	const s = make('longrange');
	check('batterie 6S = 120 mm', Math.abs(roles(s, 'battery')[0].size[2] - 0.12) < 1e-9);
}
{
	// Un build lourd de freestyle porte une GoPro ; un léger non. On cherche
	// deux graines : la variation de masse est ±12 %.
	let heavy = null, light = null;
	for (let i = 0; i < 200 && !(heavy && light); i++) {
		const b = targetBuild({ seed: `gp::${i}`, family: 'freestyle5' });
		const ratio = b.profile.mass / PROFILES.freestyle5.mass;
		if (ratio > 1.05 && !heavy) heavy = `gp::${i}`;
		if (ratio < 1.0 && !light) light = `gp::${i}`;
	}
	check('freestyle lourd : GoPro', roles(make('freestyle5', heavy), 'gopro').length === 1, heavy);
	check('freestyle léger : pas de GoPro', roles(make('freestyle5', light), 'gopro').length === 0, light);
}
check('même build → même recette', JSON.stringify(make('race5', 'same')) === JSON.stringify(make('race5', 'same')));

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
