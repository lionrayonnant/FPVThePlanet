// node tools/drone-shape-selftest.mjs — the PURE geometric recipe of the quad (issue #250).
import { shapeOf, RECIPE_PROFILES, eyeOf } from '../src/drone-shape.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { motorsOf } from '../src/quad.js';
import { createHash } from 'node:crypto';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const roles = (s, role) => s.parts.filter((p) => p.role === role);
const make = (family, seed = `shape::${family}`, detail = undefined) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }), detail });
};

console.log('drone-shape');
for (const family of FAMILIES) {
	const s = make(family);
	check(`${family}: 4 arms, 4 motors, 4 props`, roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
	check(`${family}: one plate, one camera, one battery, one LED`, roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
	const prop = roles(s, 'prop')[0];
	check(`${family}: disc = propRadius`, Math.abs(prop.size[0] - PROFILES[family].propRadius) < 1e-9);
	const motors = roles(s, 'motor');
	check(`${family}: motors at (+-armX, +-armZ)`, motors.every((m) => Math.abs(Math.abs(m.at[0]) - PROFILES[family].armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - PROFILES[family].armZ) < 1e-9));
	check(`${family}: bounding radius > hypot(arm) + prop`, s.boundingRadius >= Math.hypot(PROFILES[family].armX, PROFILES[family].armZ) + PROFILES[family].propRadius);
	check(`${family}: every part inside the bounding radius`, s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
	check(`${family}: camera tilted by the uptilt`, Math.abs(roles(s, 'camera')[0].rotX - targetCamera({ seed: `shape::${family}`, family }).uptiltDeg * Math.PI / 180) < 1e-9);
	check(`${family}: LED at the back (+Z)`, roles(s, 'led')[0].at[2] > 0);
	check(`${family}: camera at the front (-Z)`, roles(s, 'camera')[0].at[2] < 0);
}

// Issue #264: the visible geometry and the mixer read the SAME table.
// quad.js:64-71 — 1 rear-right spin +1, 2 front-right spin -1,
// 3 rear-left spin -1, 4 front-left spin +1.
for (const family of FAMILIES) {
	const s = make(family);
	const props = roles(s, 'prop');
	const motors = motorsOf(PROFILES[family]);
	check(`${family}: every prop carries its motor index`,
		props.every((p, i) => p.motor === i) && props.length === 4,
		props.map((p) => p.motor).join(','));
	check(`${family}: prop k sits at motor k's position`,
		props.every((p) => {
			const m = motors[p.motor];
			return Math.abs(p.at[0] - m.x) < 1e-9 && Math.abs(p.at[2] - m.z) < 1e-9;
		}));
	check(`${family}: prop k carries motor k's spin`,
		props.every((p) => p.spin === motors[p.motor].spin));
	// The two props IN FRAME are the front ones: motors 1 and 3.
	const front = props.filter((p) => p.at[2] < 0).map((p) => p.motor).sort();
	check(`${family}: the two front props are motors 1 and 3`,
		front.join(',') === '1,3', front.join(','));
	check(`${family}: the two front props turn opposite ways`,
		props[1].spin === -props[3].spin);
	// Arms, motors and ducts carry the same index as their prop.
	for (const role of ['arm', 'motor', 'duct']) {
		const r = roles(s, role);
		if (!r.length) continue;
		check(`${family}: every ${role} carries its motor index`,
			r.every((p, i) => p.motor === i) && r.length === 4,
			r.map((p) => p.motor).join(','));
	}
}
// Issue #264: non-regression. shapeOf() WITHOUT `detail` must return exactly
// the same geometry from one session to the next — same primitives, same
// positions, same sizes — or the ambient drones would quietly change shape. The
// fingerprint is insensitive to the ORDER of the parts (props now come out of
// motorsOf(), which enumerates them in Betaflight order) and ignores the added
// fields (`motor`, `spin`): what is frozen is the shape, not the recipe.
//
// They were recomputed a second time when tools/tune-mount.mjs re-measured the
// mount: its height rule went from "the tallest the bound allows" to "the one
// that makes the props most present under the bound" (the two say the same
// thing at the edge of the plate, the second stays right if the lens moves
// forward), which shifted four families by 0.1 to 0.2 mm.
//
// The six fingerprints were recomputed a first time when the camera part moved
// ABOVE the prop plane — the measured MOUNT block (#264, see the header of
// tools/tune-mount.mjs) raised it by a few millimetres, its forward offset
// staying the recipe's. Nothing else moved, and the ambients are not rendered
// any differently for it: src/drone-mesh.js treats the `camera` part like every
// other one, it is a 19x19x10 mm box that changed height.
//
// The toothpick's fingerprint was recomputed a third time when the four
// families extrapolated from freestyle5 took up catalogue parts: its prop went
// from 0.0318 to 0.03175 m, which is exactly 2.5 inches. The mesh moved by
// 0.05 mm, and the number is now a fact rather than a rounding.
//
// The longrange's fingerprint was recomputed a fourth time when the last
// extrapolated family took up catalogue parts too: its phantom 7x4x3 became the
// catalogue's `7037` AS A BI-BLADE (see src/drone-profiles.js, which says why:
// as a tri-blade the same prop makes 14.5 N an arm, 5.4:1 on any honest bill of
// materials, which is no longer a cruiser). `propRadius` and the arms did not
// move — 88.9 mm and 0.105 m are still there — so the only thing that changed
// in the geometry is the `blades` field of the four discs, and the blades of
// the detail levels, going from 3 to 2. Any other drift of these fingerprints
// is a regression.
{
	const GOLDEN = {
		freestyle5: '7060140541d230dd',
		race5: 'd8da56b6dd4c251f',
		cinewhoop: 'e8adbcc42d131eb3',
		longrange: '7630c7839b672e41',
		heavy5: '962cbf465e9905b9',
		toothpick: 'c69c69ba7694ef60',
	};
	for (const family of FAMILIES) {
		const rows = make(family).parts
			.map((p) => JSON.stringify({ kind: p.kind, role: p.role, at: p.at, size: p.size, rotX: p.rotX ?? 0, rotY: p.rotY ?? 0, blades: p.blades ?? 0 }))
			.sort();
		const digest = createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
		check(`${family}: default geometry unchanged`, digest === GOLDEN[family], digest);
	}
}
check('long range: 88.9 mm discs', Math.abs(roles(make('longrange'), 'prop')[0].size[0] - 0.0889) < 1e-4);
check('micro: two blades', roles(make('toothpick'), 'prop')[0].blades === 2);
check('micro: 76 mm wheelbase', Math.abs(2 * PROFILES.toothpick.armX - 0.076) < 1e-3);
check('cinewhoop: 4 ducts', roles(make('cinewhoop'), 'duct').length === 4);
check('micro: 4 ducts', roles(make('toothpick'), 'duct').length === 4);
check('race: no duct', roles(make('race5'), 'duct').length === 0);
check('cinewhoop: one GoPro', roles(make('cinewhoop'), 'gopro').length === 1);
check('long range: two antennas', roles(make('longrange'), 'antenna').length === 2);
check('race: one antenna', roles(make('race5'), 'antenna').length === 1);
check('heavy: 10 mm plate', Math.abs(roles(make('heavy5'), 'plate')[0].size[1] - 0.010) < 1e-9);
check('freestyle: 6 mm plate', Math.abs(roles(make('freestyle5'), 'plate')[0].size[1] - 0.006) < 1e-9);
{
	// Battery: length = 20 mm * cells.
	const s = make('longrange');
	check('6S battery = 120 mm', Math.abs(roles(s, 'battery')[0].size[2] - 0.12) < 1e-9);
}
{
	// A heavy freestyle build carries a GoPro; a light one does not. Two seeds
	// are searched for: the mass variation is +-12%.
	let heavy = null, light = null;
	for (let i = 0; i < 200 && !(heavy && light); i++) {
		const b = targetBuild({ seed: `gp::${i}`, family: 'freestyle5' });
		const ratio = b.profile.mass / PROFILES.freestyle5.mass;
		if (ratio > 1.05 && !heavy) heavy = `gp::${i}`;
		if (ratio < 1.0 && !light) light = `gp::${i}`;
	}
	check('heavy freestyle: GoPro', roles(make('freestyle5', heavy), 'gopro').length === 1, heavy);
	check('light freestyle: no GoPro', roles(make('freestyle5', light), 'gopro').length === 0, light);
}
check('same build -> same recipe', JSON.stringify(make('race5', 'same')) === JSON.stringify(make('race5', 'same')));

// Issue #264: three detail levels, and the default does NOT move.
{
	const seed = 'lod::freestyle5';
	const build = targetBuild({ seed, family: 'freestyle5' });
	const camera = targetCamera({ seed, family: 'freestyle5' });
	const base = shapeOf({ profile: build.profile, build, camera });
	const silhouette = shapeOf({ profile: build.profile, build, camera, detail: 'silhouette' });
	const onboard = shapeOf({ profile: build.profile, build, camera, detail: 'onboard' });
	const portrait = shapeOf({ profile: build.profile, build, camera, detail: 'portrait' });

	check('no detail === silhouette', JSON.stringify(base) === JSON.stringify(silhouette));
	check('silhouette: no blade', silhouette.parts.every((p) => p.role !== 'blade'));
	check('onboard: 3 blades per prop (freestyle)', onboard.parts.filter((p) => p.role === 'blade').length === 12);
	check('onboard: the swept disc is kept', onboard.parts.filter((p) => p.role === 'prop').length === 4);
	// The swept disc is what tools/prop-coverage.mjs measures and what the shader
	// blurs: if a level removed it, the art-direction bound would go blind. The
	// blades ADD to the disc, they do not replace it.
	check('the swept disc survives all three levels',
		[silhouette, onboard, portrait].every((s) => s.parts.filter((p) => p.role === 'prop').length === 4));
	// `onboard` deliberately REMOVES the bodywork — the lens does not film its own
	// housing — and adds only the blades. What it must never remove is a rotor:
	// without them the onboard view has no subject left. The ARMS do change with
	// the frame (#285): where they start depends on the pattern. What never moves
	// is the motor at the end.
	const ROTOR = new Set(['motor', 'prop', 'duct']);
	check('onboard keeps every rotor of the silhouette',
		silhouette.parts.filter((p) => ROTOR.has(p.role))
			.every((p) => onboard.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('onboard: four arms, each reaching its motor',
		onboard.parts.filter((p) => p.role === 'arm').length === 4);
	check('onboard removes the bodywork',
		onboard.parts.every((p) => ROTOR.has(p.role) || ['arm', 'blade', 'tape', 'bell'].includes(p.role)));
	check('portrait adds to the silhouette, removes nothing (plate and arms follow the frame)',
		silhouette.parts.filter((p) => !['plate', 'arm'].includes(p.role)).every((p) => portrait.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('portrait adds, removes nothing',
		onboard.parts.every((p) => portrait.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('portrait superset of onboard', onboard.parts.length < portrait.parts.length);
	check('portrait: motor bells', portrait.parts.filter((p) => p.role === 'bell').length === 4);
	check('bounding radius identical at all three levels',
		silhouette.boundingRadius === onboard.boundingRadius && onboard.boundingRadius === portrait.boundingRadius);
	check('every blade carries the motor and spin of its prop',
		onboard.parts.filter((p) => p.role === 'blade').every((p) => Number.isInteger(p.motor) && Math.abs(p.spin) === 1));
	check('micro: 2 blades per prop', shapeOf({
		profile: targetBuild({ seed: 'lod::tp', family: 'toothpick' }).profile,
		build: targetBuild({ seed: 'lod::tp', family: 'toothpick' }),
		camera: targetCamera({ seed: 'lod::tp', family: 'toothpick' }),
		detail: 'onboard',
	}).parts.filter((p) => p.role === 'blade').length === 8);
	// An unknown level is a typo, not a silent silhouette.
	let threw = false;
	try { shapeOf({ profile: build.profile, build, camera, detail: 'moyen' }); } catch { threw = true; }
	check('an unknown level throws', threw);
	// Every part of all three levels stays inside the bounding radius.
	check('blades and bells fit inside the bounding radius',
		portrait.parts.every((p) => Math.hypot(...p.at) <= portrait.boundingRadius + 1e-9));
}

// Issue #264: what the lens can see. The `onboard` level carries ONLY the
// rotors — a lens does not film its own housing (the `camera` part is centred on
// the eye: rendered, it covers the whole frame), nor the pack, the GoPro and the
// antennas, which live behind it. `portrait` shows the whole machine instead:
// it is a data sheet, not a first-person view.
{
	const ROTORS = new Set(['arm', 'motor', 'prop', 'duct', 'blade', 'tape', 'bell']);
	for (const family of FAMILIES) {
		const onboardRoles = new Set(make(family, `shape::${family}`, 'onboard').parts.map((p) => p.role));
		check(`${family}: the onboard view carries only the rotors`,
			[...onboardRoles].every((r) => ROTORS.has(r)), [...onboardRoles].join(' '));
		check(`${family}: the onboard view does carry its props and blades`,
			onboardRoles.has('prop') && onboardRoles.has('blade'));
		const portrait = new Set(make(family, `shape::${family}`, 'portrait').parts.map((p) => p.role));
		check(`${family}: the portrait keeps the whole machine`,
			portrait.has('camera') && portrait.has('battery') && portrait.has('plate') && portrait.has('led'),
			[...portrait].join(' '));
	}
}

// ----------------------------------------------------------- the swarm (#29)
//
// Two more machines, and only one of them is a family: the node lives in
// PROFILES (it gets flown), the unit exists only as a recipe (it is never
// flown, so it has neither PID nor tune). This selftest treats them exactly
// alike, because shapeOf() treats them exactly alike: it takes a PROFILE, not a
// family name.
console.log('\ndrone-shape: swarm (#29)');
{
	const node = make('swarmNode', 'shape::swarmNode');
	const unitProfile = RECIPE_PROFILES.swarmUnit;
	const unit = shapeOf({ profile: unitProfile, build: {}, camera: targetCamera({ seed: 'shape::swarmUnit', family: 'swarmUnit' }) });

	for (const [name, s, profile] of [['swarmNode', node, PROFILES.swarmNode], ['swarmUnit', unit, unitProfile]]) {
		check(`${name}: 4 arms, 4 motors, 4 discs`,
			roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
		check(`${name}: one plate, one camera, one battery, one LED`,
			roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
		check(`${name}: disc = propRadius`, Math.abs(roles(s, 'prop')[0].size[0] - profile.propRadius) < 1e-9);
		check(`${name}: three blades`, roles(s, 'prop').every((p) => p.blades === 3));
		check(`${name}: motors at (+-armX, +-armZ)`,
			roles(s, 'motor').every((m) => Math.abs(Math.abs(m.at[0]) - profile.armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - profile.armZ) < 1e-9));
		// FINITE geometry: no NaN, no Infinity, no zero size. A recipe reading a
		// field the profile does not carry would surface right here.
		check(`${name}: every dimension finite and positive`,
			s.parts.every((p) => p.at.every(Number.isFinite) && p.size.every((v) => Number.isFinite(v) && v > 0))
			&& Number.isFinite(s.boundingRadius) && s.boundingRadius > 0);
		check(`${name}: every part inside the bounding radius`,
			s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
		check(`${name}: camera at the front, LED at the back`,
			roles(s, 'camera')[0].at[2] < 0 && roles(s, 'led')[0].at[2] > 0);
		check(`${name}: the eye is at the front edge of the plate`,
			Math.abs(eyeOf(profile)[2] + 0.55 * profile.armZ) < 1e-9, `${eyeOf(profile)[2]}`);
	}

	check('swarmUnit: ducts, like the cinewhoop', roles(unit, 'duct').length === 4);
	check('swarmUnit: ring r = 1.12 * propRadius',
		Math.abs(roles(unit, 'duct')[0].size[0] - 1.12 * unitProfile.propRadius) < 1e-9);
	check('swarmUnit: a single antenna', roles(unit, 'antenna').length === 1);
	check('swarmUnit: 3S battery = 60 mm', Math.abs(roles(unit, 'battery')[0].size[2] - 0.060) < 1e-9);
	check('swarmUnit: no GoPro, no dome',
		roles(unit, 'gopro').length === 0 && roles(unit, 'dome').length === 0);
	check('swarmUnit: a stronger LED than an ordinary ambient',
		roles(unit, 'led')[0].size[0] > roles(make('freestyle5'), 'led')[0].size[0]);

	check('swarmNode: a dome on top', roles(node, 'dome').length === 3
		&& roles(node, 'dome').every((d) => d.at[1] > roles(node, 'battery')[0].at[1]));
	check('swarmNode: the dome narrows as it rises',
		roles(node, 'dome').every((d, i, a) => i === 0 || d.size[0] < a[i - 1].size[0]));
	check('swarmNode: two antennas', roles(node, 'antenna').length === 2);
	check('swarmNode: no duct, no GoPro',
		roles(node, 'duct').length === 0 && roles(node, 'gopro').length === 0);
	check('swarmNode: 6S battery = 120 mm', Math.abs(roles(node, 'battery')[0].size[2] - 0.12) < 1e-9);

	// The triangle count, in the ORDER the spec announces (~300 for the unit).
	// What src/drone-mesh.js would build is counted without building anything:
	// the primitive and its segment count are enough. A disc has 12 sides, a
	// cylinder 8, an open ring 12.
	const tris = (s) => s.parts.reduce((n, p) => n + ({
		box: 12, cylinder: 8 * 2 + 2 * 8, ring: 12 * 2, disc: 12, point: 0,
	}[p.kind] ?? 0), 0);
	const tUnit = tris(unit), tNode = tris(node);
	const RING = 12 * 2, CYL = 8 * 2 + 2 * 8;
	check('swarmUnit: ~300 triangles (< 500)', tUnit > 150 && tUnit < 500, `${tUnit}`);
	// The node is the unit MINUS its four ducts, PLUS the three dome stages and a
	// second antenna. To the triangle: if a part appears or disappears on one
	// side and not the other, this equality falls.
	check('swarmNode: exactly unit - 4 ducts + 3 dome stages + 1 antenna',
		tNode === tUnit - 4 * RING + 3 * CYL + CYL, `${tNode} vs ${tUnit - 4 * RING + 4 * CYL}`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
