// node tools/ambient-selftest.mjs
//
// Le modèle PUR des drones ambiants (issue #250) : ensemble, routines,
// courbes, bulle, ancres, validation à rayons stubs, attitude. Rien de Three,
// rien de Rapier — les rayons sont des fonctions injectées, comme dans
// tools/entry-state-selftest.mjs.

import {
	rngFrom, ambientSet, ROUTINES, lateralAccelMax, routineFor,
	MAX_DRONES, G, TURN_MARGIN,
	curveLocal, curveHeights, curveAt, derive, SAMPLES,
	R_SPAWN, R_LEAVE, bubbleFor, insideBounds, outOfView, pickAnchor, validateCurve, AmbientModel,
	attitudeFrom, tiltOf,
} from '../src/ambient.js';
import { generateTargetScan, TARGET_FAMILIES } from './target-model.mjs';
import { targetBuild } from './target-build.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('ambient: ensemble');
{
	const scan = { seed: 'set-a', count: 5, index: 2 };
	const set = ambientSet(scan);
	const full = generateTargetScan({ seed: 'set-a', count: 5 }).candidates;
	check('n = count - 1', set.length === 4, `${set.length}`);
	check('le pris est absent', set.every((d) => d.i !== 2));
	check('familles = celles des candidats non pris',
		set.every((d) => d.family === full[d.i]._family));
	check('buildSeed = seed::i', set.every((d) => d.buildSeed === `set-a::${d.i}`));
	check('mode = le vrai mode vidéo', set.every((d) => d.mode === full[d.i]._videoHint));
	check('même scan → même ensemble',
		JSON.stringify(ambientSet(scan)) === JSON.stringify(set));
	check('count 2 → 1 ambiant', ambientSet({ seed: 'z', count: 2, index: 0 }).length === 1);
	check('jamais plus de MAX_DRONES', ambientSet({ seed: 'z', count: 5, index: 0 }).length <= MAX_DRONES);
}

console.log('\nambient: routines');
{
	check('une routine par famille', TARGET_FAMILIES.every((f) => ROUTINES[f]));
	check('a_max(twr=2) = g·√3', Math.abs(lateralAccelMax(2) - G * Math.sqrt(3)) < 1e-9);
	check('a_max(twr≤1) = 0', lateralAccelMax(1) === 0 && lateralAccelMax(0.5) === 0);

	for (const family of TARGET_FAMILIES) {
		const build = targetBuild({ seed: `r::${family}`, family });
		const r = routineFor({ family, twr: build.spec.twr, rand: rngFrom(`rt::${family}`) });
		const spec = ROUTINES[family];
		check(`${family}: vitesse dans la plage`, r.speed >= spec.speed[0] - 1e-9 && r.speed <= spec.speed[1] + 1e-9, `${r.speed.toFixed(1)}`);
		check(`${family}: rayon dans la plage`, r.radius >= spec.radius[0] && r.radius <= spec.radius[1]);
		check(`${family}: AGL dans la plage`, r.agl >= spec.agl[0] && r.agl <= spec.agl[1]);
		check(`${family}: v²/r ≤ 0,6·a_max`, r.speed * r.speed / r.radius <= TURN_MARGIN * lateralAccelMax(build.spec.twr) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(TURN_MARGIN * lateralAccelMax(build.spec.twr)).toFixed(1)}`);
		check(`${family}: période > 0`, r.period > 0);
	}
	const a = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	const b = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	check('même graine → même routine', JSON.stringify(a) === JSON.stringify(b));
	check('le micro a du jitter', routineFor({ family: 'toothpick', twr: 3, rand: rngFrom('j') }).jitter.length === 3);
	check('le cinewhoop n\'en a pas', routineFor({ family: 'cinewhoop', twr: 2.8, rand: rngFrom('j') }).jitter.length === 0);
	// Un TWR faible ramène la vitesse : à twr 1,5 sur 15 m de rayon, v ≤ √(0,6·g·√1,25·15)
	const slow = routineFor({ family: 'race5', twr: 1.5, rand: rngFrom('slow') });
	check('TWR faible plafonne la vitesse', slow.speed * slow.speed / slow.radius <= TURN_MARGIN * lateralAccelMax(1.5) + 1e-9);
	const veryLowTWR = routineFor({ family: 'race5', twr: 1.01, rand: rngFrom('twr-1.01') });
	check('twr 1.01: invariant v²/r ≤ 0,6·a_max tient', veryLowTWR.speed * veryLowTWR.speed / veryLowTWR.radius <= TURN_MARGIN * lateralAccelMax(1.01) + 1e-9);
}

console.log('\nambient: courbes');
{
	const out = { x: 0, y: 0, z: 0 };
	const anchor = { x: 100, y: 0, z: -50 };
	const flat = { groundBelow: () => 20 };
	for (const family of TARGET_FAMILIES) {
		const r = routineFor({ family, twr: 6, rand: rngFrom(`c::${family}`) });
		// Fermée : p(0) = p(period).
		curveLocal(r, 0, out); const p0 = { ...out };
		curveLocal(r, r.period, out);
		check(`${family}: courbe fermée`, Math.hypot(out.x - p0.x, out.y - p0.y, out.z - p0.z) < 1e-6);
		// Rayon respecté (hors jitter : ±0,9 m max pour 3 sinus de 0,3).
		let maxR = 0;
		for (let i = 0; i < 200; i++) { curveLocal(r, r.period * i / 200, out); maxR = Math.max(maxR, Math.hypot(out.x, out.z)); }
		const bound = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
		check(`${family}: rayon horizontal ≤ borne`, maxR <= bound + 1.0, `${maxR.toFixed(1)} vs ${bound.toFixed(1)}`);
		// Hauteurs : sol plat à 20 → courbe à 20 + agl partout (± sinus vertical).
		const heights = new Float64Array(SAMPLES);
		check(`${family}: hauteurs calculées`, curveHeights(r, anchor, flat.groundBelow, heights));
		check(`${family}: hauteur = sol + agl`, Array.from(heights).every((h) => Math.abs(h - (20 + r.agl)) < 1e-9));
		curveAt(r, anchor, heights, r.period * 0.37, out);
		check(`${family}: curveAt au-dessus du sol`, out.y >= 20 + r.aglMin - r.vertical - 1e-9);
		// Vitesse dérivée ≈ vitesse tirée (à 10 % : les huit et le jitter déforment).
		const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, acc = { x: 0, y: 0, z: 0 };
		let vAvg = 0; const N = 100;
		for (let i = 0; i < N; i++) { derive(r, anchor, heights, r.period * i / N, 1 / 60, pos, vel, acc); vAvg += Math.hypot(vel.x, vel.z) / N; }
		check(`${family}: |v| dérivée ≈ speed`, Math.abs(vAvg - r.speed) / r.speed < 0.12, `${vAvg.toFixed(1)} vs ${r.speed.toFixed(1)}`);
		check(`${family}: accélération finie`, Number.isFinite(acc.x) && Number.isFinite(acc.y) && Number.isFinite(acc.z));
	}
	// Le huit reparamétré par abscisse curviligne (arc[], 64 cordes) ne doit pas
	// piquer d'accélération à chaque nœud, ni dépendre du taux de rafraîchissement
	// (dt de la dérivation, pas dt de la boucle de jeu — DERIVE_H est fixe).
	{
		const flatGround = () => 0;
		const anchor0 = { x: 0, y: 0, z: 0 };
		for (const [family] of [['freestyle5'], ['heavy5']]) {
			const r = routineFor({ family, twr: 6, rand: rngFrom('v') });
			const heights = new Float64Array(SAMPLES);
			curveHeights(r, anchor0, flatGround, heights);
			const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, acc = { x: 0, y: 0, z: 0 };
			const scan = (h) => {
				let maxA = 0;
				for (let i = 0; i < 600; i++) {
					derive(r, anchor0, heights, r.period * i / 600, h, pos, vel, acc);
					maxA = Math.max(maxA, Math.hypot(acc.x, acc.y, acc.z));
				}
				return maxA;
			};
			const a60 = scan(1 / 60), a240 = scan(1 / 240);
			check(`${family}: accélération sans pic de corde`, a60 <= 3 * G, `${a60.toFixed(1)} vs 3G=${(3 * G).toFixed(1)}`);
			check(`${family}: accélération indépendante du pas`, Math.abs(a240 - a60) / a60 < 0.25, `${a60.toFixed(1)} (1/60) vs ${a240.toFixed(1)} (1/240)`);
		}
	}
	// Un sol manquant fait échouer les hauteurs.
	const r = routineFor({ family: 'race5', twr: 6, rand: rngFrom('hole') });
	const heights = new Float64Array(SAMPLES);
	check('sol null → false', curveHeights(r, anchor, (x) => (x > 100 ? null : 0), heights) === false);
	// Le relief est suivi : sol en pente → hauteurs différentes aux deux bouts.
	const slope = (x) => x * 0.1;
	curveHeights(r, anchor, slope, heights);
	check('le relief est suivi', Math.max(...heights) - Math.min(...heights) > 1);
}

console.log('\nambient: bulle, ancres, validation');
{
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const smallRect = { bbox: { min: [-90, 0, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const live = { center: { x: 0, z: 0 }, trusted: 180 };
	const noLive = { center: null, trusted: 180 };
	const player = { x: 0, y: 30, z: 0 };
	const cam = { fx: 0, fy: 0, fz: -1 };   // regarde vers −Z (nord)
	const flat = (x, z) => 0;
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const wallRays = { groundBelow: () => 0, obstructionBetween: (ax, ay, az, bx) => ({ blocked: bx > 50, span: bx > 50 ? 6 : 0 }) };

	const b = bubbleFor(bigRect, player);
	check('grande carte : couronne nominale', b.rMin === R_SPAWN[0] && b.rMax === R_SPAWN[1] && b.rLeave === R_LEAVE);
	const s = bubbleFor(smallRect, player);
	check('petite carte : couronne resserrée', s.rMax === 80 && s.rMin <= s.rMax);
	check('petite carte : jamais de départ', s.rLeave === Infinity);
	const l = bubbleFor(live, player);
	check('direct : rMax = rayon de confiance', l.rMax === 180 && l.rLeave === 250);

	check('outOfView : derrière', outOfView(0, 100, 0, cam, 120) === true);
	check('outOfView : devant', outOfView(0, -100, 0, cam, 120) === false);
	check('outOfView : sur le bord + marge', outOfView(Math.sin(70 * Math.PI / 180) * 100, -Math.cos(70 * Math.PI / 180) * 100, 0, cam, 120) === false);
	check('outOfView : au-delà de la marge', outOfView(Math.sin(80 * Math.PI / 180) * 100, -Math.cos(80 * Math.PI / 180) * 100, 0, cam, 120) === true);

	check('insideBounds rect : dedans', insideBounds(bigRect, 0, 0, 10, 30));
	check('insideBounds rect : bord', !insideBounds(bigRect, 1990, 0, 10, 30));
	check('insideBounds rect : sous le plancher', !insideBounds(bigRect, 0, 0, 2, 30));
	check('insideBounds live : dedans', insideBounds(live, 100, 0, 10, 30));
	check('insideBounds live : dehors', !insideBounds(live, 170, 0, 10, 30));
	check('insideBounds live sans centre : jamais', !insideBounds(noLive, 0, 0, 10, 30));

	// 200 ancres tirées : toutes dans la couronne, hors champ ou > 220 m, dans la clôture.
	const rand = rngFrom('anchors');
	let ok = 0, n = 0;
	for (let i = 0; i < 200; i++) {
		const a = pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays, top: 250, span: 400, agl: 10 });
		if (!a) continue;
		n++;
		const d = Math.hypot(a.x - player.x, a.z - player.z);
		const inRing = d >= R_SPAWN[0] - 1e-9 && d <= R_SPAWN[1] + 1e-9;
		const hidden = outOfView(a.x - player.x, a.z - player.z, a.y - player.y, cam, 120) || d >= 220;
		if (inRect(a) && inRing && hidden) ok++;
	}
	function inRect(a) { return insideBounds(bigRect, a.x, a.z, a.y + 10, 20); }
	// E[n] : P(d<220)=100/130≈0,769, P(visible)=150°/360°≈0,417 (fovDeg=120, marge=15)
	// ⇒ P(rejet)≈0,320 ⇒ E[n]≈136, σ=√(200·0,68·0,32)≈6,6. Un outOfView cassé (signe
	// de fz) rejette presque tout : n tombe à ≤ 46. Seuil à 110, large sous E[n]-σ.
	check('200 ancres : toutes conformes', n > 110 && ok === n, `${ok}/${n}`);
	check('pas de sol → pas d\'ancre', pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400, agl: 10 }) === null);

	// Validation : plat → ok ; mur → rejet ; sol trop haut sous un point → rejet.
	const r = routineFor({ family: 'freestyle5', twr: 6, rand: rngFrom('v') });
	const heights = new Float64Array(SAMPLES);
	check('courbe sur du plat : valide', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays, heights, top: 250, span: 400 }));
	check('courbe contre un mur : rejetée', !validateCurve({ routine: r, anchor: { x: 40, y: 0, z: 0 }, rays: wallRays, heights, top: 250, span: 400 }));
	const bump = { groundBelow: (x) => (x > 10 ? 200 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('courbe dont un point est sous le relief : rejetée', !validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: bump, heights, top: 250, span: 400 }));
	// Un toit frôlé (span ≤ 2) passe.
	const roof = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: true, span: 1.5 }) };
	check('toit frôlé : accepté', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: roof, heights, top: 250, span: 400 }));
}

console.log('\nambient: modèle');
{
	// min[1] = -50 : le stub de sol plat à 0 se tient 50 m au-dessus du plancher,
	// comme une vraie carte dont bbox.min[1] est son plus bas sommet de maillage.
	const bigRect = { bbox: { min: [-2000, -50, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const scan = { seed: 'model-a', count: 5, index: 0 };
	const set = ambientSet(scan);
	const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
	const mk = () => new AmbientModel({ set, builds, bounds: bigRect, seed: scan.seed });
	const cam = { fx: 0, fy: 0, fz: -1 };
	const wind = { x: 0, y: 0, z: 0 };
	const player = { x: 0, y: 30, z: 0 };
	const frame = (m, p, dt = 1 / 60) => m.update({ dt, player: p, cam, fovDeg: 120, rays, top: 250, span: 400, wind });

	const m = mk();
	check('vide au départ', m.count === 0);
	frame(m, player);
	check('une naissance par frame', m.count === 1);
	for (let i = 0; i < 3; i++) frame(m, player);
	check('quatre après quatre frames', m.count === 4, `${m.count}`);
	frame(m, player);
	check('jamais plus que l\'ensemble', m.count === 4);
	check('familles = ensemble', m.families.join() === set.map((d) => d.family).join());

	// Déterminisme.
	const m2 = mk();
	for (let i = 0; i < 4; i++) frame(m2, player);
	check('même graine → mêmes ancres', Array.from(m.anchors).every((v, i) => v === m2.anchors[i]));

	// dt 0 : rien ne bouge, rien ne naît.
	const before = Array.from(m.pos);
	m.update({ dt: 0, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
	check('dt 0 : immobile', Array.from(m.pos).every((v, i) => v === before[i]));

	// Zéro allocation : mêmes références.
	const refs = [m.pos, m.vel, m.acc, m.quat, m.anchors];
	for (let i = 0; i < 1000; i++) frame(m, player);
	check('update n\'alloue pas', refs.every((r, i) => r === [m.pos, m.vel, m.acc, m.quat, m.anchors][i]));
	check('positions finies', Array.from(m.pos).every(Number.isFinite));

	// Relocalisation : joueur déplacé de 400 m → toutes les ancres renaissent.
	const far = { x: 400, y: 30, z: 0 };
	const anchorsBefore = Array.from(m.anchors);
	for (let i = 0; i < 5; i++) frame(m, far);
	check('400 m : toutes relocalisées', m.stats.relocations >= 4, `${m.stats.relocations}`);
	check('400 m : nouvelles ancres dans la couronne autour du joueur',
		[0, 1, 2, 3].every((k) => { const d = Math.hypot(m.anchors[3 * k] - far.x, m.anchors[3 * k + 2] - far.z); return d >= R_SPAWN[0] && d <= R_SPAWN[1]; }));
	check('400 m : ancres différentes', anchorsBefore.some((v, i) => v !== m.anchors[i]));
	// 60 m : aucune.
	const before60 = m.stats.relocations;
	for (let i = 0; i < 5; i++) frame(m, { x: 460, y: 30, z: 0 });
	check('60 m : aucune relocalisation', m.stats.relocations === before60);

	// Petite carte : tout dedans, jamais de départ.
	// Même raison qu'au-dessus : le sol plat à 0 doit rester au-dessus du plancher.
	const small = { bbox: { min: [-90, -50, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const ms = new AmbientModel({ set, builds, bounds: small, seed: 's' });
	for (let i = 0; i < 6; i++) frame(ms, player);
	check('petite carte : des drones naissent', ms.count >= 1);
	for (let i = 0; i < 60; i++) frame(ms, { x: 80, y: 30, z: 80 });
	check('petite carte : jamais de départ', ms.stats.relocations === 0);
	check('petite carte : positions dans la clôture', [...Array(ms.count).keys()].every((k) => Math.abs(ms.pos[3 * k]) < 90 && Math.abs(ms.pos[3 * k + 2]) < 90));

	// Sol absent (direct pas chargé) : rien ne naît, échecs comptés, pas d'exception.
	const mh = new AmbientModel({ set, builds, bounds: { center: { x: 0, z: 0 }, trusted: 180 }, seed: 'h' });
	for (let i = 0; i < 20; i++) mh.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400, wind });
	check('sans sol : aucune naissance', mh.count === 0 && mh.stats.spawnFailures > 0);
	check('rayons comptés', mh.stats.raysCast > 0);

	// reset : recommence à zéro autour du joueur.
	m.reset();
	check('reset : vide', m.count === 0);
}

console.log('\nambient: attitude');
{
	const q = new Float64Array(4);
	const still = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: { x: 0, y: 0, z: 0 }, drag: { x: 0.01, y: 0.028, z: 0.01 }, mass: 0.65, yawX: 0, yawZ: -1 };
	attitudeFrom(still, q, 0);
	check('immobile : à plat', tiltOf(q, 0) < 1e-6);
	check('immobile : quaternion unitaire', Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
	// Accélération latérale g → 45°.
	attitudeFrom({ ...still, ax: G }, q, 0);
	check('a = g → 45°', Math.abs(tiltOf(q, 0) - Math.PI / 4) < 1e-6, `${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	// Vent de face à 10 m/s : penché dans le vent (drag), donc tilt > 0 même immobile.
	attitudeFrom({ ...still, wind: { x: 10, y: 0, z: 0 } }, q, 0);
	check('vent : penché', tiltOf(q, 0) > 0.01);
	// Le nez suit le lacet : yaw vers +X → l'axe −Z du corps pointe vers +X.
	attitudeFrom({ ...still, yawX: 1, yawZ: 0 }, q, 0);
	const fx = 2 * (q[0] * q[2] + q[3] * q[1]);   // composante X de R·(0,0,-1)… (voir impl)
	check('lacet : nez vers +X', Math.abs(fx - 1) < 1e-6 || Math.abs(fx + 1) < 1e-6);

	// Sur les courbes : race couché, cinewhoop à plat, jamais > 75°.
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const scan = { seed: 'att3', count: 5, index: 4 };
	const set = ambientSet(scan).filter((d) => d.family === 'race5' || d.family === 'cinewhoop');
	if (set.length < 2) console.log('  SKIP  graine sans race5+cinewhoop — changer la graine');
	const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
	const m = new AmbientModel({ set, builds, bounds: bigRect, seed: 'att3' });
	const cam = { fx: 0, fy: 0, fz: -1 }, player = { x: 0, y: 30, z: 0 }, wind = { x: 0, y: 0, z: 0 };
	let maxTilt = new Float64Array(set.length), sumTilt = new Float64Array(set.length), N = 0;
	for (let i = 0; i < 600; i++) {
		m.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
		if (i < 10) continue;
		N++;
		for (let k = 0; k < set.length; k++) { const t = tiltOf(m.quat, 4 * k); maxTilt[k] = Math.max(maxTilt[k], t); sumTilt[k] += t; }
	}
	for (let k = 0; k < set.length; k++) {
		const deg = sumTilt[k] / N * 180 / Math.PI;
		check(`${set[k].family}: tilt max ≤ 75°`, maxTilt[k] <= 75 * Math.PI / 180, `${(maxTilt[k] * 180 / Math.PI).toFixed(0)}°`);
		if (set[k].family === 'race5') check('race5 : couché (> 35° en moyenne)', deg > 35, `${deg.toFixed(0)}°`);
		if (set[k].family === 'cinewhoop') check('cinewhoop : à plat (< 12°)', deg < 12, `${deg.toFixed(0)}°`);
	}
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
