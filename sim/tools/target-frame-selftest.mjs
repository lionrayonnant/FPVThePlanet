// node tools/target-frame-selftest.mjs — le châssis d'un exemplaire (issue #285).
import { targetBuild, targetFrame } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { frameOf, armStart, plateOf, PATTERNS, PATTERN_ODDS, ARM_K, CAGE_K } from './target-frame.mjs';
import { shapeOf } from '../src/drone-shape.js';
import { FAMILIES, PROFILES } from '../src/drone-profiles.js';
import { motorsOf } from '../src/quad.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
console.log('target-frame');

// Déterminisme, flux à part, bornes.
{
	const a = targetBuild({ seed: 'fr::1', family: 'freestyle5' });
	check('même graine → même châssis', JSON.stringify(a.frame) === JSON.stringify(targetFrame({ seed: 'fr::1', family: 'freestyle5' })));
	check('le châssis est dans le build', !!a.frame?.pattern && PATTERNS[a.frame.pattern] !== undefined);
	check('armK et cageK bornés', a.frame.armK >= ARM_K[0] && a.frame.armK <= ARM_K[1] && a.frame.cageK >= CAGE_K[0] && a.frame.cageK <= CAGE_K[1]);
	let threw = false; try { targetFrame({ family: 'race5' }); } catch { threw = true; }
	check('sans graine : lève', threw);
}

// Les fréquences par famille tiennent, et chaque famille ne tire que SES patrons.
for (const family of FAMILIES) {
	const counts = {};
	const n = 500;
	for (let i = 0; i < n; i++) { const f = targetFrame({ seed: `odds::${i}`, family }); counts[f.pattern] = (counts[f.pattern] ?? 0) + 1; }
	const odds = Object.fromEntries(PATTERN_ODDS[family]);
	const onlyKnown = Object.keys(counts).every((k) => k in odds);
	const close = Object.entries(odds).every(([k, p]) => Math.abs((counts[k] ?? 0) / n - p) < 0.07);
	check(`${family}: patrons ${Object.keys(odds).join('/')} aux fréquences annoncées`, onlyKnown && close, JSON.stringify(counts));
}

// Un bras arrive TOUJOURS à son moteur, quel que soit le patron : la
// géométrie visible ne peut pas désynchroniser l'image de la physique.
for (const family of FAMILIES) {
	for (const pattern of Object.keys(PATTERNS)) {
		const seed = `arm::${family}::${pattern}`;
		const build = targetBuild({ seed, family });
		build.frame = { pattern, armK: 1.1, cageK: 1 };
		const shape = shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }), detail: 'portrait' });
		const arms = shape.parts.filter((p) => p.role === 'arm');
		const motors = motorsOf(build.profile);
		const ok = arms.length === 4 && arms.every((a) => {
			const m = motors[a.motor];
			const [sx, , sz] = armStart(build.frame, m, build.profile);
			// Le bras est centré entre son départ et son moteur, orienté vers lui.
			return Math.abs(a.at[0] - (m.x + sx) / 2) < 1e-9 && Math.abs(a.at[2] - (m.z + sz) / 2) < 1e-9
				&& Math.abs(a.size[2] - Math.hypot(m.x - sx, m.z - sz)) < 1e-9;
		});
		check(`${family}/${pattern}: quatre bras, chacun du départ du patron à son moteur`, ok);
	}
}

// La silhouette ne lit PAS le châssis : deux builds aux patrons différents
// donnent la même silhouette (hors ce qui varie déjà : masse, cellules).
{
	const seed = 'sil::x';
	const b = targetBuild({ seed, family: 'freestyle5' });
	const cam = targetCamera({ seed, family: 'freestyle5' });
	const sx = shapeOf({ profile: b.profile, build: { ...b, frame: { pattern: 'x', armK: 1, cageK: 1 } }, camera: cam });
	const sh = shapeOf({ profile: b.profile, build: { ...b, frame: { pattern: 'h', armK: 1.3, cageK: 1.2 } }, camera: cam });
	check('silhouette : identique quel que soit le châssis', JSON.stringify(sx) === JSON.stringify(sh));
	const px = shapeOf({ profile: b.profile, build: { ...b, frame: { pattern: 'x', armK: 1, cageK: 1 } }, camera: cam, detail: 'portrait' });
	const ph = shapeOf({ profile: b.profile, build: { ...b, frame: { pattern: 'h', armK: 1.3, cageK: 1.2 } }, camera: cam, detail: 'portrait' });
	check('portrait : le châssis change le dessin', JSON.stringify(px) !== JSON.stringify(ph));
	check('portrait H : un rail', ph.parts.filter((p) => p.role === 'rail').length === 1 && px.parts.filter((p) => p.role === 'rail').length === 0);
	check('la plaque suit le patron', plateOf({ pattern: 'h' }, PROFILES.freestyle5).width < plateOf({ pattern: 'unibody' }, PROFILES.freestyle5).width);
	check('un châssis inconnu : les bras partent du centre', armStart({ pattern: 'nope' }, { x: 1, z: 1 }, PROFILES.freestyle5).join() === '0,0,0');
}

// Le propriétaire dans la recette (#285) : ruban dès `onboard`, numéro et
// objectif GoPro au `portrait` seulement.
{
	const find = (family, pred, detail) => {
		for (let i = 0; i < 300; i++) { const seed = `own::${i}`; const b = targetBuild({ seed, family }); if (pred(b)) return shapeOf({ profile: b.profile, build: b, camera: targetCamera({ seed, family }), detail }); }
		return null;
	};
	const taped = find('freestyle5', (b) => b.livery.owner.tape, 'onboard');
	check('ruban : quatre manchons, un par bras, dès onboard', taped && taped.parts.filter((p) => p.role === 'tape').length === 4 && taped.parts.filter((p) => p.role === 'tape').every((p) => Number.isInteger(p.motor)));
	const untaped = find('freestyle5', (b) => !b.livery.owner.tape, 'portrait');
	check('sans ruban : aucun manchon', untaped && untaped.parts.every((p) => p.role !== 'tape'));
	const numbered = find('race5', (b) => b.livery.owner.number, 'portrait');
	check('numéro : un autocollant au portrait', numbered && numbered.parts.filter((p) => p.role === 'sticker').length === 1);
	const numberedOnboard = find('race5', (b) => b.livery.owner.number, 'onboard');
	check('numéro : rien dans le champ', numberedOnboard && numberedOnboard.parts.every((p) => p.role !== 'sticker'));
	const cine = find('cinewhoop', () => true, 'portrait');
	check('GoPro : un objectif au portrait', cine && cine.parts.filter((p) => p.role === 'goprolens').length === 1 && cine.parts.filter((p) => p.role === 'gopro').length === 1);
	const cineSil = find('cinewhoop', () => true, 'silhouette');
	check('GoPro : pas d\'objectif en silhouette', cineSil && cineSil.parts.every((p) => p.role !== 'goprolens'));
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
