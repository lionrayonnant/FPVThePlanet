// node tools/ambient-selftest.mjs
//
// Le modèle PUR des drones ambiants (issue #250) : ensemble, routines,
// courbes, bulle, ancres, validation à rayons stubs, attitude. Rien de Three,
// rien de Rapier — les rayons sont des fonctions injectées, comme dans
// tools/entry-state-selftest.mjs.

import {
	rngFrom, ambientSet, ROUTINES, lateralAccelMax, routineFor,
	MAX_DRONES, G, TURN_MARGIN, TILT_MAX_DEG,
	curveLocal, curveHeights, curveAt, derive, SAMPLES, HEIGHT_SAMPLES,
	R_SPAWN, R_LEAVE, bubbleFor, insideBounds, outOfView, pickAnchor, validateCurve, AmbientModel,
	attitudeFrom, tiltOf, clampTilt,
	SWARM_UNIT_FAMILY, SWARM_UNIT_BUILD_FAMILY,
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
	// swarmChance 0 des deux côtés : un descripteur de scan sans clé d'essaim
	// (session v2, scan de dev) se rejoue sans essaim, c'est ce qu'on compare.
	const scan = { seed: 'set-a', count: 5, index: 2 };
	const set = ambientSet(scan);
	const full = generateTargetScan({ seed: 'set-a', count: 5, swarmChance: 0 }).candidates;
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

console.log('\nambient: le cluster laissé de côté (issue #29)');
{
	// Le joueur a pris un autre signal : le cluster reste au ciel, mais comme
	// UNE unité sur une routine ordinaire, pas comme une nuée de douze.
	const scan = { seed: 'swarm-amb', count: 4, index: 1, swarmAt: 0, swarmChance: 1 };
	const set = ambientSet(scan);
	const left = set.find((d) => d.i === 0);
	check('le cluster non pris devient un swarmUnit', left?.family === SWARM_UNIT_FAMILY, left?.family);
	check('il emprunte un airframe existant tant que sa recette n\'existe pas',
		left?.buildFamily === SWARM_UNIT_BUILD_FAMILY, left?.buildFamily);
	check('cet airframe se construit vraiment',
		!!targetBuild({ seed: left.buildSeed, family: left.buildFamily }).profile);
	check('les autres ambiants gardent leur famille',
		set.filter((d) => d.i !== 0).every((d) => d.family === d.buildFamily));
	// Et quand c'est LUI qu'on a pris, il n'y a pas d'unité au ciel.
	const taken = ambientSet({ ...scan, index: 0 });
	check('cluster pris → aucun swarmUnit ambiant',
		taken.every((d) => d.family !== SWARM_UNIT_FAMILY));
	// Sans les clés (session v2, scan de dev), aucun cluster n'est réinventé.
	check('scan sans clé d\'essaim → aucun swarmUnit',
		ambientSet({ seed: 'swarm-amb', count: 4, index: 1 }).every((d) => d.family !== SWARM_UNIT_FAMILY));
}

console.log('\nambient: routines');
{
	check('une routine par famille', TARGET_FAMILIES.every((f) => ROUTINES[f]));
	// Le cluster laissé de côté (issue #29) : UNE unité, sur une routine
	// ordinaire — orbite basse rapide, pas une nuée au loin.
	check('une routine pour swarmUnit', !!ROUTINES[SWARM_UNIT_FAMILY]);
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
		check(`${family}: v²/r ≤ g·tan(TILT_MAX)`, r.speed * r.speed / r.radius <= G * Math.tan(TILT_MAX_DEG * Math.PI / 180) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(G * Math.tan(TILT_MAX_DEG * Math.PI / 180)).toFixed(1)}`);
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
		const heights = new Float64Array(HEIGHT_SAMPLES);
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
			const heights = new Float64Array(HEIGHT_SAMPLES);
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
	const heights = new Float64Array(HEIGHT_SAMPLES);
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
		// À la hauteur de VOL (y + agl), comme pickAnchor : une ancre au sol
		// serait jugée cachée pour une raison qu'elle ne vivra jamais.
		const hidden = outOfView(a.x - player.x, a.z - player.z, (a.y + 10) - player.y, cam, 120) || d >= 220;
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
	const heights = new Float64Array(HEIGHT_SAMPLES);
	check('courbe sur du plat : valide', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays, heights, top: 250, span: 400 }));
	check('courbe contre un mur : rejetée', !validateCurve({ routine: r, anchor: { x: 40, y: 0, z: 0 }, rays: wallRays, heights, top: 250, span: 400 }));
	const bump = { groundBelow: (x) => (x > 10 ? 200 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('courbe dont un point est sous le relief : rejetée', !validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: bump, heights, top: 250, span: 400 }));
	// Un toit frôlé (span ≤ 2) passe.
	const roof = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: true, span: 1.5 }) };
	check('toit frôlé : accepté', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: roof, heights, top: 250, span: 400 }));

	// LE mode d'échec de `havre` (rapport Task 9) : un bâtiment ENTRE deux
	// nœuds de la grille grossière. Le huit 'v' ci-dessus passe par x = 7,51
	// puis x = 14,08 aux nœuds 16-ièmes ; la fenêtre 9 < x < 12 ne contient
	// donc AUCUN nœud grossier, mais deux nœuds fins (x = 10,31 et 11,29).
	// Un immeuble de 30 m posé là était invisible à 16 rayons et se voit à 64.
	// Aucun segment ne le coupe non plus : la courbe passe 14 m au-dessus du
	// sol plat et 16 m AU-DESSUS du toit — la règle du mur ne peut rien voir.
	const _o = { x: 0, y: 0, z: 0 };
	const inWindow = (x) => x > 9 && x < 12;
	let coarseHits = 0, fineHits = 0;
	for (let i = 0; i < SAMPLES; i++) { curveLocal(r, r.period * i / SAMPLES, _o); if (inWindow(_o.x)) coarseHits++; }
	for (let i = 0; i < HEIGHT_SAMPLES; i++) { curveLocal(r, r.period * i / HEIGHT_SAMPLES, _o); if (inWindow(_o.x)) fineHits++; }
	check('prémisse : la bosse tombe entre deux nœuds grossiers, sur des nœuds fins',
		coarseHits === 0 && fineHits > 0, `${coarseHits} nœud(s)/${SAMPLES} vs ${fineHits} nœud(s)/${HEIGHT_SAMPLES}`);
	const hidden = { groundBelow: (x) => (inWindow(x) ? 30 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('bâtiment caché entre deux nœuds grossiers : rejeté',
		!validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: hidden, heights, top: 250, span: 400 }));
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

	// Un slot IMPOSSIBLE ne bloque plus les autres. Sur cette même petite carte
	// (demi-côté 90, hold 10), un long range demande `leg/2 + radius = 320 m`
	// de marge : il ne peut JAMAIS naître ici. Avant la rotation du curseur,
	// spawnOne() repartait toujours du slot 0 — un long range en tête gelait
	// tout le ciel derrière lui, pour toujours (0/4 mesuré sur `paristest`).
	{
		// La graine se CHERCHE plutôt qu'elle ne se recopie : la table des
		// familles peut bouger, l'invariant qu'on veut est « le premier
		// candidat non pris est un long range, et c'est le seul ».
		let found = null;
		for (let i = 0; i < 200 && !found; i++) {
			const sc = { seed: `cursor${i}`, count: 5, index: 0 };
			const st = ambientSet(sc);
			if (st.length >= 2 && st[0].family === 'longrange' && !st.slice(1).some((d) => d.family === 'longrange')) {
				found = { scan: sc, set: st };
			}
		}
		check('graine à long range en tête trouvée', found !== null, found && `${found.scan.seed} : ${found.set.map((d) => d.family).join(',')}`);
		if (found) {
			const bs = found.set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
			const mc = new AmbientModel({ set: found.set, builds: bs, bounds: small, seed: found.scan.seed });
			for (let i = 0; i < 12; i++) frame(mc, player);
			check('slot impossible : les autres naissent quand même',
				mc.count >= 1 && mc.count === found.set.length - 1, `${mc.count}/${found.set.length - 1}`);
			check('slot impossible : c\'est bien le long range qui manque', mc.alive[0] === 0);
			check('slot impossible : les échecs sont comptés', mc.stats.spawnFailures > 0, `${mc.stats.spawnFailures}`);
			// … et il ne coûte plus de RAYONS non plus. La clôture HORIZONTALE
			// se tranche AVANT le rayon de sol : un long range qui demande 320 m
			// de marge sur une carte qui en offre 80 est rejeté sans lancer un
			// seul rayon. Avant le réordonnancement, c'étaient 3 rayons de
			// maillage complet par frame — 180 par seconde, pour toujours.
			//
			// Borne à 3 rayons/s : le slot impossible en coûte 0, et rien
			// d'autre ne tente de naître (les trois autres volent). La veille
			// (10 échecs consécutifs → 1 s de pause) borne de toute façon un
			// slot qui échouerait APRÈS son rayon à ~10 rayons/s, très loin
			// des 180 d'avant.
			for (let i = 0; i < 60; i++) frame(mc, player);   // 1 s : régime établi
			const raysAt1s = mc.stats.raysCast;
			for (let i = 0; i < 600; i++) frame(mc, player);  // 10 s de plus
			const perSecond = (mc.stats.raysCast - raysAt1s) / 10;
			check('slot impossible : ≤ 3 rayons/s en régime établi', perSecond <= 3, `${perSecond.toFixed(1)} rayons/s`);
			check('slot impossible : les autres volent toujours', mc.count === found.set.length - 1, `${mc.count}`);
		}
	}

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

	// Le plafond d'inclinaison lui-même : la poussée demandée est rabattue sur
	// le cône de TILT_MAX_DEG, quelle que soit l'accélération demandée.
	attitudeFrom({ ...still, ax: 100 * G }, q, 0);
	check('a latérale énorme → plafonnée à TILT_MAX', Math.abs(tiltOf(q, 0) - TILT_MAX_DEG * Math.PI / 180) < 1e-9,
		`${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	// Le cas qui cassait tout : une accélération VERTICALE vers le bas plus
	// forte que g renverse la poussée sous l'horizon. C'est le sinus du huit,
	// le plan incliné du loop, le jitter du micro — rien dans v²/r ne la borne.
	attitudeFrom({ ...still, ay: -3 * G, ax: G }, q, 0);
	check('a verticale sous −g → toujours ≤ TILT_MAX', tiltOf(q, 0) <= TILT_MAX_DEG * Math.PI / 180 + 1e-9,
		`${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	check('a verticale sous −g → quaternion unitaire', Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
	// Poussée exactement à la verticale vers le bas : aucune direction
	// horizontale à garder, on se remet à plat plutôt que de diviser par zéro.
	attitudeFrom({ ...still, ay: -3 * G }, q, 0);
	check('poussée pile vers le bas → à plat, pas de NaN', tiltOf(q, 0) < 1e-9 && Number.isFinite(q[3]));

	// clampTilt : le filet posé sur le quaternion RENDU (le nlerp du lissage
	// sort du cône même entre deux cibles qui y sont).
	{
		// Roulis de 120° autour de X : q = (sin60, 0, 0, cos60).
		const r = new Float64Array([Math.sin(Math.PI / 3), 0, 0, Math.cos(Math.PI / 3)]);
		check('clampTilt : prémisse à 120°', Math.abs(tiltOf(r, 0) - 2 * Math.PI / 3) < 1e-9, `${(tiltOf(r, 0) * 180 / Math.PI).toFixed(1)}°`);
		check('clampTilt : rabat et le dit', clampTilt(r, 0) === true);
		check('clampTilt : pile sur le cône', Math.abs(tiltOf(r, 0) - TILT_MAX_DEG * Math.PI / 180) < 1e-9, `${(tiltOf(r, 0) * 180 / Math.PI).toFixed(1)}°`);
		check('clampTilt : quaternion unitaire', Math.abs(Math.hypot(r[0], r[1], r[2], r[3]) - 1) < 1e-9);
		// Déjà dans le cône : ne touche à rien, et le dit.
		attitudeFrom({ ...still, ax: G }, q, 0);
		const before = Array.from(q);
		check('clampTilt : à 45°, ne touche à rien', clampTilt(q, 0) === false && Array.from(q).every((v, i) => v === before[i]));
	}

	// Sur les courbes, BALAYAGE par famille : 50 graines, 600 frames chacune.
	// Une seule graine ne prouvait rien — elle tirait un rayon et une vitesse,
	// pas la famille. À 50, on voit les cas extrêmes : c'est ce balayage qui a
	// mesuré 157° sur un toothpick et 110° sur un race5 quand le plafond ne
	// bornait que l'accélération LATÉRALE (v²/r), la verticale des figures
	// passant tout droit.
	//
	// min[1] = −50 : le sol plat à 0 se tient au-dessus du plancher de la
	// clôture, sinon un micro à 1 m d'AGL ne naîtrait jamais (FLOOR_MARGIN_M).
	const bigRect = { bbox: { min: [-4000, -50, -4000], max: [4000, 200, 4000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const cam = { fx: 0, fy: 0, fz: -1 }, player = { x: 0, y: 30, z: 0 }, wind = { x: 0, y: 0, z: 0 };
	const SEEDS = 50, FRAMES = 600, WARMUP = 10;
	// swarmUnit (issue #29) est balayée comme les autres : elle n'est jamais
	// pilotée, mais elle VOLE, et une routine invalide s'y verrait pareil.
	for (const family of [...TARGET_FAMILIES, SWARM_UNIT_FAMILY]) {
		const buildFamily = family === SWARM_UNIT_FAMILY ? SWARM_UNIT_BUILD_FAMILY : family;
		let maxTilt = 0, sumTilt = 0, n = 0, born = 0;
		for (let i = 0; i < SEEDS; i++) {
			// Un ensemble d'UN SEUL drone de la famille : le balayage exerce la
			// famille, pas la table des candidats d'un scan.
			const buildSeed = `sweep::${family}::${i}`;
			const set = [{ i: 0, id: 'x', family, buildFamily, buildSeed, rssiDbm: -60, mode: 'analog' }];
			const builds = [targetBuild({ seed: buildSeed, family: buildFamily })];
			const m = new AmbientModel({ set, builds, bounds: bigRect, seed: buildSeed });
			for (let f = 0; f < FRAMES; f++) {
				m.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
				if (f < WARMUP || !m.alive[0]) continue;
				const t = tiltOf(m.quat, 0);
				maxTilt = Math.max(maxTilt, t); sumTilt += t; n++;
			}
			if (m.alive[0]) born++;
		}
		const maxDeg = maxTilt * 180 / Math.PI, meanDeg = n ? sumTilt / n * 180 / Math.PI : 0;
		check(`${family}: ${born}/${SEEDS} graines volent`, born > SEEDS / 2, `${born}`);
		check(`${family}: tilt max ≤ 75° sur ${SEEDS} graines`, maxDeg <= 75 + 1e-9, `${maxDeg.toFixed(1)}°`);
		if (family === 'race5') check('race5 : couché (> 35° en moyenne)', meanDeg > 35, `${meanDeg.toFixed(1)}°`);
		if (family === 'cinewhoop') check('cinewhoop : à plat (< 12°)', meanDeg < 12, `${meanDeg.toFixed(1)}°`);
	}
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
