// Selftest du modèle de limites de zone (issue #139). Aucun DOM, aucun
// Rapier : une bbox synthétique et des points qu'on place à la main.
// Lancer : node tools/geofence-selftest.mjs
import assert from 'node:assert/strict';
import {
	Geofence, horizontalMargin, verticalMargin,
	NOMINAL, CAUTION, HOLD, LOST,
	R_CAUTION, R_HOLD, FLOOR_CAUTION, FLOOR_HOLD, FLOOR_EDGE, FLOOR_LOST,
	A_MAX, FENCE_SPAN, FENCE_WARN_DB,
} from '../src/geofence.js';
import { VideoLink } from '../src/link.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une bbox carrée et généreuse : 2000 m de côté, 300 m de haut, centrée sur
// l'origine en X/Z. Assez grande pour que les couloirs (dizaines de mètres)
// ne se touchent jamais au centre.
const BBOX = { min: [-1000, -30, -1000], max: [1000, 270, 1000] };
const at = (x, y, z) => ({ x, y, z });
// Un point franchement au milieu, à mi-hauteur : la référence « tout va bien ».
const MIDDLE = at(0, 100, 0);

t('la marge horizontale est la distance à la face la plus proche', () => {
	assert.equal(horizontalMargin(at(0, 100, 0), BBOX), 1000);
	assert.equal(horizontalMargin(at(900, 100, 0), BBOX), 100);
	assert.equal(horizontalMargin(at(0, 100, -950), BBOX), 50);
	// Dehors : négative, et c'est la vraie distance euclidienne au bord.
	assert.equal(horizontalMargin(at(1030, 100, 0), BBOX), -30);
	// Dehors par un coin : la diagonale, pas le min des deux axes.
	assert.ok(Math.abs(horizontalMargin(at(1030, 100, 1040), BBOX) - -50) < 1e-9);
});

t('la marge verticale se compte depuis le point le plus bas du maillage', () => {
	assert.equal(verticalMargin(at(0, -30, 0), BBOX), 0);
	assert.equal(verticalMargin(at(0, 100, 0), BBOX), 130);
	assert.equal(verticalMargin(at(0, -36, 0), BBOX), -6);
});

t('au milieu : rien du tout', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.zone, NOMINAL);
	assert.equal(f.out.warning, '');
	assert.equal(f.out.lossDb, 0);
	assert.deepEqual(f.out.push, { x: 0, y: 0, z: 0 });
});

t('les quatre zones horizontales, dans l ordre', () => {
	const f = new Geofence(BBOX);
	const zoneAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.zone; };
	assert.equal(zoneAtMargin(R_CAUTION + 10), NOMINAL);
	assert.equal(zoneAtMargin((R_CAUTION + R_HOLD) / 2), CAUTION);
	assert.equal(zoneAtMargin(R_HOLD / 2), HOLD);
	assert.equal(zoneAtMargin(-1), LOST);
});

t('les quatre zones verticales, toutes sous le minimum du maillage', () => {
	const f = new Geofence(BBOX);
	const zoneAtY = (y) => { f.update(at(0, y, 0)); return f.out.zone; };
	const FLOOR = BBOX.min[1];
	assert.equal(zoneAtY(FLOOR + 1), NOMINAL, 'posé sur le point le plus bas : normal');
	assert.equal(zoneAtY(FLOOR - (FLOOR_CAUTION + FLOOR_HOLD) / 2), CAUTION);
	assert.equal(zoneAtY(FLOOR - (FLOOR_HOLD + FLOOR_LOST) / 2), HOLD);
	assert.equal(zoneAtY(FLOOR - FLOOR_LOST - 1), LOST);
});

t('la pire des deux zones gagne', () => {
	const f = new Geofence(BBOX);
	// Horizontalement en CAUTION, verticalement en HOLD : c'est HOLD.
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, BBOX.min[1] - (FLOOR_HOLD + FLOOR_LOST) / 2, 0));
	assert.equal(f.out.zone, HOLD);
});

t('l hystérésis : aucun aller-retour ne double une transition', () => {
	const f = new Geofence(BBOX);
	// On oscille autour de la frontière NOMINAL/CAUTION avec une amplitude
	// plus petite que l'hystérésis : la zone ne doit changer qu'une fois.
	const seen = [];
	let prev = null;
	for (let i = 0; i < 200; i++) {
		const m = R_CAUTION - 0.02 * (i % 2 === 0 ? 1 : -1);
		f.update(at(1000 - m, 100, 0));
		if (f.out.zone !== prev) { seen.push(f.out.zone); prev = f.out.zone; }
	}
	assert.equal(seen.length, 1, `strobe : ${seen.join(' → ')}`);
});

t('l avertissement suit la zone', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.warning, '');
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
	f.update(at(1000 - R_HOLD / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
});

t('over : vrai seulement une fois la session perdue', () => {
	const f = new Geofence(BBOX);
	f.update(at(1000 - 1, 100, 0));
	assert.equal(f.out.over, false);
	f.update(at(1000 + R_HOLD * 0.5, 100, 0));
	assert.equal(f.out.over, false, 'dehors mais pas encore au bout du couloir');
	f.update(at(1000 + R_HOLD + 1, 100, 0));
	assert.equal(f.out.over, true);
});

// --- Couverture ajoutée en revue : out.push, out.lossDb, out.marginM, out.t
// (constats du relecteur sur task-1-report.md). Toujours par rapport aux
// constantes exportées, jamais à leurs valeurs littérales : R_HOLD, R_CAUTION
// sont provisoires (remplacées tâche 4), et FLOOR_*/A_MAX/FENCE_* le sont
// tout autant pour ce fichier.

t('la poussée horizontale : nulle en entrée de HOLD, pleine au bord et au-delà', () => {
	const f = new Geofence(BBOX);
	const pushXAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.push.x; };
	assert.equal(pushXAtMargin(R_HOLD), 0);
	assert.equal(pushXAtMargin(0), -A_MAX);
	assert.equal(pushXAtMargin(-R_HOLD), -A_MAX);   // au-delà du bord : toujours pleine
});

t('la poussée horizontale croît sans à-coup entre l entrée de HOLD et le bord', () => {
	const f = new Geofence(BBOX);
	// Magnitude positive : sur la face +X la poussée pointe vers -X (voir le
	// test de direction ci-dessous), donc on prend la valeur absolue ici pour
	// raisonner sur une grandeur qui croît (un simple `-x` renverrait -0 au
	// lieu de 0 à l'entrée de HOLD, et -0 !== 0 pour assert.equal strict).
	const magAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return Math.abs(f.out.push.x); };
	const steps = 20;
	const dm = R_HOLD / steps;
	const maxSlope = A_MAX / R_HOLD;   // pente exacte de la rampe linéaire hold→edge
	let prev = magAtMargin(R_HOLD);
	assert.equal(prev, 0);
	for (let i = 1; i <= steps; i++) {
		const cur = magAtMargin(R_HOLD - i * dm);
		assert.ok(cur >= prev - 1e-9, `pas monotone autour de i=${i}`);
		assert.ok(cur - prev <= maxSlope * dm + 1e-9, `à-coup autour de i=${i}`);
		prev = cur;
	}
	assert.ok(Math.abs(prev - A_MAX) < 1e-9);   // le balayage finit pile au bord
});

t('la poussée horizontale rentre toujours, sur les quatre faces', () => {
	const f = new Geofence(BBOX);
	const m = R_HOLD / 2;   // au milieu du couloir HOLD : ni nulle ni pleine
	f.update(at(1000 - m, 100, 0));                     // face +X
	assert.ok(f.out.push.x < 0, '+X : la poussée doit rentrer, donc pointer vers -X');
	assert.equal(f.out.push.z, 0);
	f.update(at(-1000 + m, 100, 0));                    // face -X
	assert.ok(f.out.push.x > 0, '-X : la poussée doit rentrer, donc pointer vers +X');
	assert.equal(f.out.push.z, 0);
	f.update(at(0, 100, 1000 - m));                     // face +Z
	assert.ok(f.out.push.z < 0, '+Z : la poussée doit rentrer, donc pointer vers -Z');
	assert.equal(f.out.push.x, 0);
	f.update(at(0, 100, -1000 + m));                    // face -Z
	assert.ok(f.out.push.z > 0, '-Z : la poussée doit rentrer, donc pointer vers +Z');
	assert.equal(f.out.push.x, 0);
});

t('la poussée verticale : nulle au-dessus du seuil, positive et jamais négative en dessous', () => {
	const f = new Geofence(BBOX);
	const FLOOR = BBOX.min[1];
	f.update(at(0, FLOOR, 0));
	assert.equal(f.out.push.y, 0, 'posé sur le point le plus bas : pas encore de rappel');
	f.update(at(0, FLOOR - FLOOR_HOLD / 2, 0));
	assert.equal(f.out.push.y, 0, 'encore au-dessus du seuil HOLD : pas de rappel');
	f.update(at(0, FLOOR - (FLOOR_HOLD + FLOOR_EDGE) / 2, 0));
	assert.ok(f.out.push.y > 0 && f.out.push.y < A_MAX, 'entre HOLD et EDGE : rappel partiel');
	f.update(at(0, FLOOR - FLOOR_LOST * 10, 0));
	assert.equal(f.out.push.y, A_MAX, 'bien au-delà : rappel plein, jamais plus');
	assert.ok(f.out.push.y >= 0, 'jamais de rappel vers le bas');
});

t('la perte horizontale : nulle jusqu à R_CAUTION, FENCE_WARN_DB au bord, FENCE_SPAN en fin de couloir', () => {
	const f = new Geofence(BBOX);
	const lossAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.lossDb; };
	assert.equal(lossAtMargin(R_CAUTION), 0);
	assert.equal(lossAtMargin(R_CAUTION + 20), 0);
	assert.equal(lossAtMargin(0), FENCE_WARN_DB);
	assert.equal(lossAtMargin(-R_HOLD), FENCE_SPAN);
});

t('la perte horizontale croît de façon monotone tout au long du couloir', () => {
	const f = new Geofence(BBOX);
	const lossAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.lossDb; };
	const steps = 40;
	let prev = -Infinity;
	for (let i = 0; i <= steps; i++) {
		const m = R_CAUTION - ((R_CAUTION + R_HOLD) * i) / steps;   // de R_CAUTION à -R_HOLD
		const loss = lossAtMargin(m);
		assert.ok(loss >= prev - 1e-9, `perte non monotone à marge=${m}`);
		prev = loss;
	}
	assert.ok(Math.abs(prev - FENCE_SPAN) < 1e-9);
});

t('la perte verticale a ses propres seuils : nulle au-dessus, FENCE_WARN_DB à FLOOR_EDGE, FENCE_SPAN à FLOOR_LOST', () => {
	const f = new Geofence(BBOX);
	const FLOOR = BBOX.min[1];
	const lossAtY = (y) => { f.update(at(0, y, 0)); return f.out.lossDb; };
	assert.equal(lossAtY(FLOOR - FLOOR_CAUTION), 0);
	assert.equal(lossAtY(FLOOR + 50), 0);
	assert.equal(lossAtY(FLOOR - FLOOR_EDGE), FENCE_WARN_DB);
	assert.equal(lossAtY(FLOOR - FLOOR_LOST), FENCE_SPAN);
});

t('la perte verticale croît de façon monotone tout au long de son couloir', () => {
	const f = new Geofence(BBOX);
	const FLOOR = BBOX.min[1];
	const lossAtY = (y) => { f.update(at(0, y, 0)); return f.out.lossDb; };
	const steps = 40;
	let prev = -Infinity;
	for (let i = 0; i <= steps; i++) {
		// de FLOOR-FLOOR_CAUTION (entrée du couloir) à FLOOR-FLOOR_LOST (fin)
		const y = FLOOR - FLOOR_CAUTION - ((FLOOR_LOST - FLOOR_CAUTION) * i) / steps;
		const loss = lossAtY(y);
		assert.ok(loss >= prev - 1e-9, `perte non monotone à y=${y}`);
		prev = loss;
	}
	assert.ok(Math.abs(prev - FENCE_SPAN) < 1e-9);
});

t('marginM : la verticale gagne au milieu, décalée du bord de son couloir', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	// mH = 1000 (voir le premier test) ; mV = 100 − bbox.min.y = 130, décalée
	// du bord du couloir vertical (v.edge = −FLOOR_EDGE) : 130 + FLOOR_EDGE.
	// Très inférieure à mH : c'est elle qui gagne au Math.min.
	assert.equal(f.out.marginM, 100 - BBOX.min[1] + FLOOR_EDGE);
});

t('t : 0 à l entrée de caution, 1 en fin de couloir (horizontal)', () => {
	const f = new Geofence(BBOX);
	f.update(at(1000 - R_CAUTION, 100, 0));
	assert.equal(f.out.t, 0);
	f.update(at(1000 + R_HOLD, 100, 0));   // marge = -R_HOLD = h.lost
	assert.equal(f.out.t, 1);
});

// --- La borne du couloir à la taille de la carte ---------------------------

// R_CAUTION et R_HOLD sont mesurés sur une grande carte ; Geofence borne le
// couloir horizontal au tiers du plus petit demi-côté de la scène, les deux
// seuils par le même facteur. Toujours par rapport aux constantes exportées :
// ces tests doivent survivre à une re-mesure.

// Le tiers du demi-côté SOUS lequel la borne mord : en dessous, scale < 1.
const BOUND_HALF = 3 * R_CAUTION;
// Une bbox carrée de demi-côté `h`, hauteur généreuse et sans rapport.
const square = (h) => ({ min: [-h, -30, -h], max: [h, 270, h] });

t('carte assez grande : le couloir est la valeur mesurée, à l identique', () => {
	const f = new Geofence(BBOX);   // demi-côté 1000 m, bien au-dessus de la borne
	assert.equal(f.effectiveCorridor.scale, 1);
	assert.equal(f.effectiveCorridor.caution, R_CAUTION);
	assert.equal(f.effectiveCorridor.hold, R_HOLD);
	// Non-régression : les frontières tombent exactement là où elles tombaient
	// avant que la borne existe.
	const zoneAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.zone; };
	assert.equal(zoneAtMargin(R_CAUTION + 10), NOMINAL);
	assert.equal(zoneAtMargin((R_CAUTION + R_HOLD) / 2), CAUTION);
	assert.equal(zoneAtMargin(R_HOLD / 2), HOLD);
	assert.equal(zoneAtMargin(-1), LOST);
	// Et la poussée aussi : pleine au bord, nulle à l entrée de HOLD.
	f.update(at(1000 - R_HOLD, 100, 0));
	assert.equal(f.out.push.x, 0);
	f.update(at(1000, 100, 0));
	assert.equal(f.out.push.x, -A_MAX);
});

t('carte étroite : le couloir rétrécit, le rapport des deux seuils survit', () => {
	// Un demi-côté franchement sous la borne (elle mord à 3 x R_CAUTION).
	const h = BOUND_HALF / 4;
	const f = new Geofence(square(h));
	const e = f.effectiveCorridor;
	assert.ok(e.scale < 1, `la borne devrait mordre à un demi-côté de ${h}`);
	assert.ok(Math.abs(e.caution - h / 3) < 1e-9, 'caution vaut le tiers du demi-côté');
	// LE point : le rapport, donc le temps d avertissement, est préservé.
	assert.ok(Math.abs(e.caution / e.hold - R_CAUTION / R_HOLD) < 1e-9);
	// Le cœur sans avertissement fait bien les deux tiers du côté.
	const side = 2 * h;
	const core = side - 2 * e.caution;
	assert.ok(Math.abs(core / side - 2 / 3) < 1e-9, `cœur ${(100 * core / side).toFixed(1)} % du côté`);
	// Et les zones suivent le couloir effectif, pas la constante.
	const zoneAtMargin = (m) => { f.update(at(h - m, 100, 0)); return f.out.zone; };
	assert.equal(zoneAtMargin(e.caution + 10), NOMINAL);
	assert.equal(zoneAtMargin((e.caution + e.hold) / 2), CAUTION);
	assert.equal(zoneAtMargin(e.hold / 2), HOLD);
	assert.equal(zoneAtMargin(-1), LOST);
	// La constante brute, elle, est hors de la carte : la câbler sans borne
	// aurait mis TOUTE la scène en avertissement.
	assert.ok(R_CAUTION > h, 'le test ne prouve rien si la constante tient dans la carte');
});

t('bbox rectangulaire : c est le PLUS PETIT demi-côté qui gouverne, sur les deux axes', () => {
	const wide = 4 * BOUND_HALF, narrow = BOUND_HALF / 4;
	// Étroite en Z, large en X.
	const f = new Geofence({ min: [-wide, -30, -narrow], max: [wide, 270, narrow] });
	const e = f.effectiveCorridor;
	assert.ok(Math.abs(e.halfMinM - narrow) < 1e-9);
	assert.ok(Math.abs(e.caution - narrow / 3) < 1e-9);
	// L axe LARGE hérite du même couloir rétréci : un seul couloir, pas un par
	// axe — sinon la marge euclidienne des coins parlerait de deux échelles.
	f.update(at(wide - (e.caution + e.hold) / 2, 100, 0));
	assert.equal(f.out.zone, CAUTION, 'axe large : le couloir rétréci s applique aussi');
	f.update(at(wide - e.caution - 10, 100, 0));
	assert.equal(f.out.zone, NOMINAL);
	// Et l inverse (étroite en X) donne le même couloir : min sur les deux.
	const g = new Geofence({ min: [-narrow, -30, -wide], max: [narrow, 270, wide] });
	assert.deepEqual(g.effectiveCorridor, e);
});

t('la borne ne touche PAS le couloir vertical', () => {
	const wide = new Geofence(BBOX);
	const tight = new Geofence(square(BOUND_HALF / 4));
	assert.ok(tight.effectiveCorridor.scale < 1);
	assert.deepEqual(tight.v, wide.v);
	// Et les zones verticales tombent aux mêmes hauteurs sous le maillage.
	const FLOOR = -30;   // bbox.min.y, commun aux deux
	const zoneAtY = (f, y) => { f.update(at(0, y, 0)); return f.out.zone; };
	for (const dy of [1, -(FLOOR_CAUTION + FLOOR_HOLD) / 2, -(FLOOR_HOLD + FLOOR_LOST) / 2, -FLOOR_LOST - 1]) {
		assert.equal(zoneAtY(tight, FLOOR + dy), zoneAtY(wide, FLOOR + dy), `dy=${dy}`);
	}
});

// --- Le canal terminal de link.js -----------------------------------------

// Une frame de lien parfait : à dix mètres, rien dans le chemin.
const CLEAR = { distance: 10, blocked: false, span: 0, dt: 1 / 60 };

t('sans perte terminale, link.js est intact', () => {
	const l = new VideoLink();
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('la perte terminale tue l image', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
});

t('la borne de jouabilité #79 ne relève JAMAIS une perte terminale', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	// 30 s : bien au-delà de BLACKOUT_MAX_S (2 s), donc la borne a eu tout le
	// temps de s'armer et de replaquer la qualité à COOLDOWN_FLOOR_Q.
	let worst = 0;
	for (let i = 0; i < 30 * 60; i++) {
		l.update(CLEAR);
		worst = Math.max(worst, l.out.quality);
	}
	assert.equal(worst, 0, `la borne #79 a relevé l image à ${worst}`);
});

t('la perte terminale se retire', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
	l.setTerminalLoss(0);
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('reset() efface la perte terminale', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	l.reset();
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('FENCE_SPAN vaut bien LOSS_DEAD − LOSS_CLEAN de link.js', () => {
	// Le lien est propre ; on lui ajoute exactement FENCE_SPAN. Si la constante
	// dupliquée dans geofence.js a dérivé de celle de link.js, la qualité ne
	// tombe pas pile à zéro.
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
	const m = new VideoLink();
	m.setTerminalLoss(FENCE_SPAN - 0.5);
	m.update(CLEAR);
	assert.ok(m.out.quality > 0, 'un demi-dB de moins doit laisser une image');
});

console.log(`\n${n} vérifications OK`);
