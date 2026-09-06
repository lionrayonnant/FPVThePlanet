// Drones ambiants (issue #250) — le modèle PUR. Ni Three, ni Rapier, ni DOM :
// les rayons sont des fonctions injectées ({ groundBelow, obstructionBetween }
// duck-typé comme src/entry-state.js), le rendu vit dans src/drone-mesh.js et
// le son dans src/ambient-audio.js.
//
// Ce fichier tient : l'ensemble (qui vole), les routines (comment chaque
// famille vole), les courbes (où), la bulle (autour de qui), les ancres et
// leur validation, l'attitude (comment le corps se tient). Tout est
// déterministe sur la graine du scan, et update() n'alloue rien.
//
// La validation travaille sur DEUX grilles, et c'est délibéré : le sol se
// mesure fin (HEIGHT_SAMPLES), les murs se testent grossier (SAMPLES). Le
// pourquoi est au-dessus des deux constantes.

import { generateTargetScan } from '../tools/target-model.mjs';

export const G = 9.81;
export const MAX_DRONES = 4;
// v²/r ≤ TURN_MARGIN · a_max : un quad ne vire pas en butée de poussée.
export const TURN_MARGIN = 0.6;
// L'inclinaison maximale du corps, en degrés. L'invariant « jamais au-delà des
// 75° que la spec autorise » est IMPOSÉ dans attitudeFrom(), par construction,
// sur la poussée elle-même : pour TOUTE courbe, tout vent, tout drag.
// routineFor() garde son plafond en plus — il borne v²/r, donc les vitesses
// tirées restent celles d'un quad, pas celles d'un jet qui vire à plat.
//
// Borner l'accélération LATÉRALE ne suffisait pas : la composante VERTICALE
// des figures (plan incliné du loop, sinus du huit, jitter du micro à ~14 m/s²)
// n'est pas dans v²/r et faisait basculer le vecteur de poussée sous
// l'horizon — 157° mesurés sur un toothpick, 110° sur un race5.
export const TILT_MAX_DEG = 70;

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
// tools/target-model.mjs, src/entry-state.js et src/link.js).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

const lerp = (rand, [a, b]) => a + rand() * (b - a);

// Les candidats non pris, avec la graine d'exemplaire que resolveTarget()
// leur aurait donnée. Pur et déterministe : le même scan rend le même ciel.
export function ambientSet(scan) {
	const { candidates } = generateTargetScan({ seed: scan.seed, count: scan.count });
	const out = [];
	for (let i = 0; i < candidates.length; i++) {
		if (i === scan.index) continue;
		const c = candidates[i];
		out.push({
			i, id: c.id, family: c._family,
			buildSeed: `${scan.seed}::${i}`,
			rssiDbm: c.rssiDbm, mode: c._videoHint,
		});
		if (out.length === MAX_DRONES) break;
	}
	return out;
}

// Une routine par famille. Plages choisies à l'oreille de pilote, comme
// RANGES de l'entry state ; c'est le filet (validation) qui rend chaque
// tirage juste, pas la plage. `radius` du long range = rayon du demi-tour.
export const ROUTINES = {
	race5: { kind: 'loop', agl: [3, 10], speed: [15, 22], radius: [12, 20] },
	freestyle5: { kind: 'eight', agl: [10, 40], speed: [12, 18], radius: [18, 28], vertical: 8 },
	heavy5: { kind: 'eight', agl: [10, 30], speed: [9, 14], radius: [22, 30], vertical: 0 },
	cinewhoop: { kind: 'orbit', agl: [15, 30], speed: [3, 6], radius: [10, 25], faceAnchor: true },
	longrange: { kind: 'cruise', agl: [60, 120], speed: [18, 26], radius: [120, 120], leg: 400 },
	toothpick: { kind: 'orbit', agl: [1, 5], speed: [2, 5], radius: [4, 8], jitter: true },
};

// Accélération latérale maximale d'un quad de rapport poussée/poids twr :
// la poussée doit d'abord porter le poids, le reste vire.
export function lateralAccelMax(twr) {
	return twr > 1 ? G * Math.sqrt(twr * twr - 1) : 0;
}

export function routineFor({ family, twr, rand }) {
	const spec = ROUTINES[family];
	if (!spec) throw new Error(`famille sans routine : ${family}`);
	const radius = lerp(rand, spec.radius);
	const agl = lerp(rand, spec.agl);
	let speed = lerp(rand, spec.speed);
	// Le TWR borne le virage, et g·tan(TILT_MAX) le borne encore : ce second
	// plafond ne GARANTIT pas l'inclinaison (c'est attitudeFrom qui l'impose,
	// verticale comprise), il garde les vitesses tirées dans le domaine d'un
	// quad — un rayon de 20 m ne se prend pas à 40 m/s.
	const vMax = Math.sqrt(Math.min(TURN_MARGIN * lateralAccelMax(twr), G * Math.tan(TILT_MAX_DEG * Math.PI / 180)) * radius);
	if (speed > vMax) speed = vMax;
	const dir = rand() < 0.5 ? -1 : 1;
	const phase = rand() * Math.PI * 2;
	// Plan de la boucle du race : incliné de 10 à 35° pour que la boucle ne
	// soit pas un cercle plat — un race prend de la hauteur en sortie de virage.
	const tiltPlane = spec.kind === 'loop' ? (10 + rand() * 25) * Math.PI / 180 : 0;
	// Lemniscate de Gerono (huit) : pas à vitesse constante en w — on reparamètre
	// par abscisse curviligne. 64 segments, longueurs cumulées dans arc[1..64],
	// arc[0] = 0 ; la période est la vraie longueur du parcours / speed (et non
	// l'approximation "deux tours de cercle") pour que |v| ≈ speed tienne.
	// arcSlope[k] = dw/ds au nœud k (1/|dp/dw|) : l'inversion s → w se fait en
	// Hermite cubique (C1) sur chaque segment, pas en linéaire (C0 seulement),
	// sinon chaque nœud casse la dérivée de w(t) et l'accélération y pique.
	// arc[] s'intègre par Simpson (pas par corde) : une corde sous-estime la
	// vraie longueur d'arc là où la courbure est là plus forte, ce qui la rend
	// incohérente avec la pente ANALYTIQUE d'arcSlope — Hermite doit alors
	// « rattraper » l'écart en milieu de segment et la vitesse y dépasse la
	// cible de 25+ % (mesuré) quel que soit le pas de dérivation. Simpson (1
	// point milieu par segment, même fonction speedW que pour arcSlope) rend
	// arc[] fidèle à la vraie longueur : voir le rapport pour les chiffres.
	let arc = null, arcSlope = null;
	if (spec.kind === 'eight') {
		arc = new Float64Array(65);
		arcSlope = new Float64Array(65);
		const V = spec.vertical ?? 0;
		const speedW = (w) => {
			const dxdw = -2 * radius * Math.sin(w);
			const dzdw = 2 * radius * Math.cos(2 * w);
			const dydw = 2 * V * Math.cos(2 * w + 1);
			return Math.hypot(dxdw, dzdw, dydw);
		};
		arcSlope[0] = 1 / speedW(0);
		for (let k = 1; k <= 64; k++) {
			const w0 = (Math.PI * 2 * (k - 1)) / 64, w1 = (Math.PI * 2 * k) / 64, wm = (w0 + w1) / 2;
			const dw = w1 - w0;
			arc[k] = arc[k - 1] + (dw / 6) * (speedW(w0) + 4 * speedW(wm) + speedW(w1));
			arcSlope[k] = 1 / speedW(w1);
		}
	}
	let period;
	if (spec.kind === 'cruise') period = (2 * spec.leg + Math.PI * radius) / speed;
	else if (spec.kind === 'eight') period = arc[64] / speed;
	else period = (2 * Math.PI * radius) / speed;
	// Jitter du micro : les fréquences nominales (Hz) sont arrondies au nombre
	// entier d'harmoniques le plus proche sur la période de la routine, sinon
	// curveLocal(0) ≠ curveLocal(period) (le jitter ne boucle pas avec le reste).
	// amp à 0,15 (et non 0,3) : à 0,3, la dérivée du jitter (jusqu'à 2,1 Hz)
	// dépasse à elle seule 12 % de la vitesse nominale d'un micro lent —
	// le budget de rayon (±0,9 m annoncé au test) reste très large à 0,15.
	const jitter = spec.jitter
		? [0.7, 1.3, 2.1].map((hz) => ({
			amp: 0.15,
			nx: Math.max(1, Math.round(hz * period)),
			nz: Math.max(1, Math.round(hz * period * 0.7)),
			phase: rand() * Math.PI * 2,
		}))
		: [];
	return {
		kind: spec.kind, family, aglMin: spec.agl[0], agl, speed, radius, dir, phase,
		tiltPlane, vertical: spec.vertical ?? 0, leg: spec.leg ?? 0,
		faceAnchor: !!spec.faceAnchor, jitter, period, arc, arcSlope,
	};
}

// Deux grilles, deux métiers.
//
// SAMPLES : le nombre de SEGMENTS sur lesquels on teste l'obstruction. Un
// segment est une corde, `obstructionBetween` la traverse d'un rayon : la
// densifier ne révèle rien de neuf, elle rejoue le même mur.
//
// HEIGHT_SAMPLES : le nombre de RAYONS DE SOL du profil de hauteur. Le sol,
// lui, n'est pas une corde : c'est une nappe continue sous la courbe, et
// entre deux nœuds elle peut monter sans jamais couper le segment. À 16
// nœuds, deux rayons voisins sont distants de 22 m sur un huit et de 74 m
// sur un cruise (leg 400 m) — mesuré sur `havre` (tools/selftest.mjs) : un
// immeuble de +37 m se cachait entre deux nœuds sous un long range (AGL réel
// 45,8 m pour un plancher de 60), et un heavy5 passait à 1,06 m d'un quai
// pour un plancher de 10. La règle du mur ne pouvait rien y voir — la courbe
// passe AU-DESSUS du toit, aucun segment ne le coupe. 64 rayons ramènent le
// pas à 5,5 m (huit) / 18 m (cruise), sous la taille d'un bâtiment.
export const SAMPLES = 16;
export const HEIGHT_SAMPLES = 64;
const TWO_PI = Math.PI * 2;

// Offset par rapport à l'ancre, à l'instant t, dans le plan de la routine.
// `y` est l'offset VERTICAL de la figure seule (plan incliné du race, sinus
// du huit, jitter du micro) — l'AGL et le relief sont ajoutés par curveAt().
// Non négatif pour le loop et le huit : la figure grimpe hors du virage,
// elle ne plonge jamais sous l'AGL tiré pour la routine.
export function curveLocal(r, t, out) {
	const u = (t / r.period) * TWO_PI * r.dir + r.phase;
	switch (r.kind) {
		case 'loop': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			// Plan incliné : la hauteur suit une des deux composantes, jamais négative —
			// le race grimpe hors du virage, il ne plonge pas sous son AGL.
			out.y = Math.sin(r.tiltPlane) * r.radius * (1 + Math.sin(u));
			break;
		}
		case 'orbit': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			out.y = 0;
			break;
		}
		case 'eight': {
			// Lemniscate de Gerono, deux lobes de rayon ~r, reparamétrée par
			// abscisse curviligne (r.arc, précalculée dans routineFor) pour une
			// vitesse constante : w n'avance pas linéairement avec t, mais avec
			// la longueur déjà parcourue, retrouvée par interpolation dans arc[].
			// Inversion s → w en Hermite cubique (C1, valeur ET pente dw/ds
			// raccordées à chaque nœud) — une interpolation linéaire de w serait
			// C0 seulement et ferait piquer l'accélération à chaque nœud (64
			// pics par tour), voir r.arcSlope dans routineFor.
			const frac = (((t / r.period) * r.dir + r.phase / (Math.PI * 2)) % 1 + 1) % 1;
			const target = frac * r.arc[64];
			let k = 0;
			while (k < 64 && r.arc[k + 1] < target) k++;
			if (k >= 64) k = 63;
			const s0 = r.arc[k], s1 = r.arc[k + 1];
			const segLen = s1 - s0;
			const tau = segLen > 1e-9 ? (target - s0) / segLen : 0;
			const w0 = (Math.PI * 2 * k) / 64, w1 = (Math.PI * 2 * (k + 1)) / 64;
			const m0 = r.arcSlope[k] * segLen, m1 = r.arcSlope[k + 1] * segLen;
			const tau2 = tau * tau, tau3 = tau2 * tau;
			const h00 = 2 * tau3 - 3 * tau2 + 1;
			const h10 = tau3 - 2 * tau2 + tau;
			const h01 = -2 * tau3 + 3 * tau2;
			const h11 = tau3 - tau2;
			const w = h00 * w0 + h10 * m0 + h01 * w1 + h11 * m1;
			out.x = 2 * r.radius * Math.cos(w);
			out.z = r.radius * Math.sin(2 * w);
			// Jamais négatif, même raison que le loop.
			out.y = r.vertical * (1 + Math.sin(w * 2 + 1));
			break;
		}
		case 'cruise': {
			// Stade : deux segments de `leg`, deux demi-tours de rayon `radius`.
			const L = r.leg, R = r.radius;
			const total = 2 * L + Math.PI * R;
			let s = ((t * r.speed * r.dir) % total + total) % total;
			out.y = 0;
			if (s < L) { out.x = -L / 2 + s; out.z = -R / 2; }
			else if (s < L + Math.PI * R / 2) {
				// Demi-tour de rayon R/2 : a va de 0 à π sur tout le budget d'arc
				// (piR/2), donc da/ds = 2/R, pas 1/R.
				const a = 2 * (s - L) / R;
				out.x = L / 2 + R / 2 * Math.sin(a); out.z = -R / 2 + R / 2 * (1 - Math.cos(a));
			} else if (s < 2 * L + Math.PI * R / 2) { s -= L + Math.PI * R / 2; out.x = L / 2 - s; out.z = R / 2; }
			else {
				const a = 2 * (s - 2 * L - Math.PI * R / 2) / R;
				out.x = -L / 2 - R / 2 * Math.sin(a); out.z = R / 2 - R / 2 * (1 - Math.cos(a));
			}
			break;
		}
		default: throw new Error(`routine inconnue : ${r.kind}`);
	}
	for (let k = 0; k < r.jitter.length; k++) {
		const j = r.jitter[k];
		// Harmoniques entières de la période (j.nx, j.nz précalculées dans
		// routineFor) : le jitter boucle exactement avec le reste de la figure.
		const ux = (t / r.period) * TWO_PI * j.nx + j.phase;
		const uz = (t / r.period) * TWO_PI * j.nz + j.phase;
		const s = Math.sin(ux);
		out.x += j.amp * s; out.z += j.amp * Math.cos(uz); out.y += j.amp * 0.5 * s;
	}
	return out;
}

const _c = { x: 0, y: 0, z: 0 };

// Hauteur absolue de la courbe à chacun des HEIGHT_SAMPLES échantillons :
// sol + agl. `groundBelow(x, z)` rend la hauteur du sol ou null (pas de
// terrain). `heights` fait HEIGHT_SAMPLES de long.
export function curveHeights(r, anchor, groundBelow, heights) {
	for (let i = 0; i < HEIGHT_SAMPLES; i++) {
		curveLocal(r, r.period * i / HEIGHT_SAMPLES, _c);
		const g = groundBelow(anchor.x + _c.x, anchor.z + _c.z);
		if (g == null) return false;
		heights[i] = g + r.agl;
	}
	return true;
}

// Position absolue : XZ de la courbe, Y interpolé entre les hauteurs
// échantillonnées (le micro épouse le relief) plus l'offset de la figure.
export function curveAt(r, anchor, heights, t, out) {
	curveLocal(r, t, out);
	const f = ((t / r.period) % 1 + 1) % 1 * HEIGHT_SAMPLES;
	const i = Math.floor(f) % HEIGHT_SAMPLES, j = (i + 1) % HEIGHT_SAMPLES, a = f - Math.floor(f);
	const y = heights[i] * (1 - a) + heights[j] * a;
	out.x += anchor.x; out.z += anchor.z; out.y += y;
	return out;
}

const _pm = { x: 0, y: 0, z: 0 }, _pp = { x: 0, y: 0, z: 0 };

// Position, vitesse et accélération par différences centrées de pas h.
export function derive(r, anchor, heights, t, h, pos, vel, acc) {
	curveAt(r, anchor, heights, t, pos);
	curveAt(r, anchor, heights, t - h, _pm);
	curveAt(r, anchor, heights, t + h, _pp);
	vel.x = (_pp.x - _pm.x) / (2 * h); vel.y = (_pp.y - _pm.y) / (2 * h); vel.z = (_pp.z - _pm.z) / (2 * h);
	acc.x = (_pp.x - 2 * pos.x + _pm.x) / (h * h);
	acc.y = (_pp.y - 2 * pos.y + _pm.y) / (h * h);
	acc.z = (_pp.z - 2 * pos.z + _pm.z) / (h * h);
}

export const ATTITUDE_TAU = 0.08;

// Base orthonormée → quaternion (x,y,z,w). Colonnes : X = droite, Y = haut,
// Z = arrière (le nez est −Z, comme la caméra Three du joueur).
function quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz, out, o) {
	const tr = xx + yy + zz;
	let x, y, z, w;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s; x = (yz - zy) / s; y = (zx - xz) / s; z = (xy - yx) / s;
	} else if (xx > yy && xx > zz) {
		const s = Math.sqrt(1 + xx - yy - zz) * 2;
		w = (yz - zy) / s; x = 0.25 * s; y = (xy + yx) / s; z = (xz + zx) / s;
	} else if (yy > zz) {
		const s = Math.sqrt(1 + yy - xx - zz) * 2;
		w = (zx - xz) / s; x = (xy + yx) / s; y = 0.25 * s; z = (yz + zy) / s;
	} else {
		const s = Math.sqrt(1 + zz - xx - yy) * 2;
		w = (xy - yx) / s; x = (xz + zx) / s; y = (yz + zy) / s; z = 0.25 * s;
	}
	out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

const TILT_MAX_RAD = TILT_MAX_DEG * Math.PI / 180;
const TILT_MAX_TAN = Math.tan(TILT_MAX_RAD);
const TILT_MAX_COS = Math.cos(TILT_MAX_RAD);
const TILT_MAX_SIN = Math.sin(TILT_MAX_RAD);
const _u = { x: 0, y: 0, z: 0 };

// Rabat une direction UNITAIRE sur le cône de TILT_MAX autour de la verticale,
// en gardant sa direction horizontale : le drone penche du bon côté, il penche
// juste moins. Rend `out` (unitaire).
function clampToCone(x, y, z, out) {
	const h = Math.hypot(x, z);
	if (y <= 0) {
		// Sous l'horizon : rien à interpoler, on se pose PILE sur le cône.
		// Sans direction horizontale (pile vers le bas), il n'y a pas de « bon
		// côté » : à plat, plutôt qu'une division par zéro.
		if (h > 1e-9) { out.x = x / h * TILT_MAX_SIN; out.z = z / h * TILT_MAX_SIN; out.y = TILT_MAX_COS; }
		else { out.x = 0; out.z = 0; out.y = 1; }
		return out;
	}
	if (h <= TILT_MAX_TAN * y) { out.x = x; out.y = y; out.z = z; return out; }
	const k = TILT_MAX_TAN * y / h;
	const cx = x * k, cz = z * k;
	const n = Math.hypot(cx, y, cz) || 1;
	out.x = cx / n; out.y = y / n; out.z = cz / n;
	return out;
}

// Un quad incline sa poussée dans a + g − a_drag. Y corps = poussée
// normalisée ; le nez (−Z) suit le lacet demandé projeté sur le plan du corps.
//
// La poussée est ENSUITE ramenée sous TILT_MAX_DEG : c'est là, et nulle part
// ailleurs, que l'invariant d'inclinaison se tient. Une figure ne demande pas
// l'attitude, elle demande une accélération ; si celle-ci coucherait le corps
// au-delà du plafond, on garde sa DIRECTION horizontale (le drone penche du
// bon côté) et on relève simplement l'assiette. Un quad réel fait pareil : il
// ne suit pas la trajectoire, il fait ce que sa poussée permet.
export function attitudeFrom({ ax, ay, az, vx, vy, vz, wind, drag, mass, yawX, yawZ }, out, o) {
	const rx = vx - wind.x, ry = vy - wind.y, rz = vz - wind.z;
	const s = Math.hypot(rx, ry, rz);
	// F_drag = −c·|v_air|·v_air par axe (le modèle de quad.js), a = F/m.
	const dx = drag.x * s * rx / mass, dy = drag.y * s * ry / mass, dz = drag.z * s * rz / mass;
	let ux = ax + dx, uy = ay + G + dy, uz = az + dz;
	const n = Math.hypot(ux, uy, uz) || 1;
	ux /= n; uy /= n; uz /= n;
	// Plafond d'inclinaison, sur le vecteur unitaire.
	clampToCone(ux, uy, uz, _u);
	ux = _u.x; uy = _u.y; uz = _u.z;
	// Nez : la direction de lacet, orthogonalisée contre Y.
	let fx = yawX, fy = 0, fz = yawZ;
	const fn = Math.hypot(fx, fz) || 1; fx /= fn; fz /= fn;
	const dot = fx * ux + fy * uy + fz * uz;
	fx -= dot * ux; fy -= dot * uy; fz -= dot * uz;
	const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
	// Z corps = −nez ; X = Y × Z.
	const zx = -fx, zy = -fy, zz = -fz;
	const xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
	quatFromBasis(xx, xy, xz, ux, uy, uz, zx, zy, zz, out, o);
}

// Rabat un quaternion DÉJÀ FORMÉ sous TILT_MAX, en place.
//
// attitudeFrom() borne la poussée qu'elle reçoit, mais le lissage de
// _attitude() interpole ENTRE deux attitudes (nlerp, qui suit le plus court
// chemin en rotation) — et ce chemin-là sort du cône. L'ensemble des
// attitudes sous 70° n'est pas convexe en rotation : deux cibles penchées de
// 70° dans des directions différentes se rejoignent en passant PLUS penché.
// Mesuré sur un toothpick, dont le jitter renverse la direction du penché
// plusieurs fois par seconde : 83,9° entre deux cibles à 70° pile.
// L'invariant se tient donc là où il se voit : sur le quaternion RENDU.
export function clampTilt(q, o) {
	const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
	// Y du corps dans le monde (colonne 1 de la matrice de rotation).
	const uy = 1 - 2 * (x * x + z * z);
	const ux = 2 * (x * y - w * z), uz = 2 * (y * z + w * x);
	if (uy > 0 && Math.hypot(ux, uz) <= TILT_MAX_TAN * uy) return false;
	clampToCone(ux, uy, uz, _u);
	// Le nez (−Z du corps), réorthogonalisé contre la nouvelle verticale : le
	// cap survit au redressement, seule l'assiette bouge.
	let fx = -2 * (x * z + w * y), fy = -2 * (y * z - w * x), fz = -(1 - 2 * (x * x + y * y));
	const dot = fx * _u.x + fy * _u.y + fz * _u.z;
	fx -= dot * _u.x; fy -= dot * _u.y; fz -= dot * _u.z;
	const fl = Math.hypot(fx, fy, fz);
	if (fl < 1e-9) {
		// Nez devenu parallèle à la nouvelle verticale : on en prend un
		// horizontal, orthogonal à elle par construction (u × ŷ).
		const cx = -_u.z, cz = _u.x, cl = Math.hypot(cx, cz);
		if (cl > 1e-9) { fx = cx / cl; fy = 0; fz = cz / cl; }
		else { fx = 0; fy = 0; fz = -1; }
	} else { fx /= fl; fy /= fl; fz /= fl; }
	const zx = -fx, zy = -fy, zz = -fz;
	const xx = _u.y * zz - _u.z * zy, xy = _u.z * zx - _u.x * zz, xz = _u.x * zy - _u.y * zx;
	quatFromBasis(xx, xy, xz, _u.x, _u.y, _u.z, zx, zy, zz, q, o);
	return true;
}

// Angle entre le Y du corps et le Y du monde.
export function tiltOf(q, o) {
	const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
	const upY = 1 - 2 * (x * x + z * z);   // composante Y de R·(0,1,0)
	return Math.acos(Math.max(-1, Math.min(1, upY)));
}

export const R_SPAWN = [120, 250];
export const R_LEAVE = 320;
export const R_LEAVE_GAP = 70;      // rLeave = rMax + gap quand la couronne se resserre
export const IN_VIEW_MIN_M = 220;   // dans le champ, on ne naît qu'au-delà
export const VIEW_MARGIN_DEG = 15;
export const BLOCK_SPAN_M = 2;      // règle de geometrySafe : un mur, pas un toit frôlé
export const FLOOR_MARGIN_M = 5;    // au-dessus de FLOOR_HOLD de la clôture
const SPAWN_TRIES_PER_FRAME = 3;
// Pas de dérivation fixe : l'attitude ne doit pas dépendre du taux de rafraîchissement.
const DERIVE_H = 1 / 60;
// Attitude initiale au spawn : sans vent (voir spawnOne).
const NO_WIND = { x: 0, y: 0, z: 0 };

// La couronne, bornée par la clôture. Rect : `halfMin - hold` ; direct : le
// rayon de confiance (180 m par défaut, sous les 250 nominaux). Une carte qui
// ne loge pas la couronne minimale garde ses drones pour toujours.
// `out`, si fourni, est muté et rendu (update() y passe son scratch : zéro
// allocation par frame). Sans `out`, alloue un littéral (chemin des tests).
export function bubbleFor(bounds, player, out) {
	const o = out || { rMin: 0, rMax: 0, rLeave: 0 };
	let rMax = R_SPAWN[1];
	if (bounds.bbox) {
		const halfMin = Math.min(
			(bounds.bbox.max[0] - bounds.bbox.min[0]) / 2,
			(bounds.bbox.max[2] - bounds.bbox.min[2]) / 2,
		);
		rMax = Math.min(rMax, halfMin - bounds.corridor.hold);
	} else {
		rMax = Math.min(rMax, bounds.trusted);
	}
	if (rMax < R_SPAWN[0]) { o.rMin = 0; o.rMax = Math.max(rMax, 10); o.rLeave = Infinity; return o; }
	o.rMin = R_SPAWN[0]; o.rMax = rMax; o.rLeave = rMax < R_SPAWN[1] ? rMax + R_LEAVE_GAP : R_LEAVE;
	return o;
}

// Un point tient-il dans la clôture, avec `margin` (rayon de routine) en plus ?
export function insideBounds(bounds, x, z, y, margin) {
	if (bounds.bbox) {
		const b = bounds.bbox;
		const m = bounds.corridor.hold + margin;
		return x >= b.min[0] + m && x <= b.max[0] - m
			&& z >= b.min[2] + m && z <= b.max[2] - m
			&& y >= b.min[1] + FLOOR_MARGIN_M;
	}
	if (!bounds.center) return false;
	return Math.hypot(x - bounds.center.x, z - bounds.center.z) + margin <= bounds.trusted;
}

// Hors du cône caméra (FOV + marge) ?
export function outOfView(dx, dz, dy, cam, fovDeg) {
	const d = Math.hypot(dx, dy, dz);
	if (d === 0) return false;
	const cosA = (dx * cam.fx + dy * cam.fy + dz * cam.fz) / d;
	return cosA < Math.cos((fovDeg / 2 + VIEW_MARGIN_DEG) * Math.PI / 180);
}

// Une ancre dans la couronne, hors champ, dans la clôture, sur du sol. Un
// rayon. `top`/`span` : d'où et sur quelle longueur lancer vers le bas
// (haut de bbox + 50 et hauteur + 100, comme groundAt de l'entry state).
// Le plancher se vérifie à la hauteur de VOL (sol + agl) : l'ancre elle-même
// reste au sol (`y = g`), seule la clôture est testée à `g + agl`.
export function pickAnchor({ rand, player, cam, fovDeg, bounds, radius, rays, top, span, agl, stats }) {
	const { rMin, rMax } = bubbleFor(bounds, player);
	const d = rMin + rand() * (rMax - rMin);
	const a = rand() * TWO_PI;
	const x = player.x + d * Math.cos(a), z = player.z + d * Math.sin(a);
	if (stats) stats.raysCast++;
	const g = rays.groundBelow(x, top, z, span);
	if (g == null) return null;
	const y = g;
	if (!insideBounds(bounds, x, z, y + agl, radius)) return null;
	if (d < IN_VIEW_MIN_M && !outOfView(x - player.x, z - player.z, y - player.y, cam, fovDeg)) return null;
	return { x, y, z };
}

const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 };

// 64 rayons vers le bas (le profil de sol, et le plancher testé dessus), puis
// 16 obstructions entre segments voisins. Les deux grilles sont volontairement
// différentes — voir SAMPLES / HEIGHT_SAMPLES plus haut.
export function validateCurve({ routine, anchor, rays, heights, top, span, stats }) {
	const ground = (x, z) => { if (stats) stats.raysCast++; return rays.groundBelow(x, top, z, span); };
	if (!curveHeights(routine, anchor, ground, heights)) return false;
	// Le plancher, sur la grille FINE : c'est là que se cachait le relief.
	for (let i = 0; i < HEIGHT_SAMPLES; i++) {
		// La figure peut descendre sous l'AGL tiré (sinus, plan incliné) :
		// c'est l'AGL MINIMAL de la famille qui compte, au point le plus bas.
		curveAt(routine, anchor, heights, routine.period * i / HEIGHT_SAMPLES, _a);
		// À l'échantillon i pile, heights[i] EST le sol sous _a (curveHeights l'y a
		// mis) : `_a.y - (heights[i] - agl)` retombe donc toujours exactement sur
		// `curveLocal.y + agl`, quel que soit le relief — une tautologie qui ne
		// verrait jamais un point sous le relief. On compare plutôt au pire des
		// deux sols voisins (i et i+1) : si le relief grimpe fort entre les deux,
		// c'est entre eux (où la courbe interpole linéairement) que ça râcle.
		const j = (i + 1) % HEIGHT_SAMPLES;
		const g = Math.max(heights[i], heights[j]) - routine.agl;
		if (_a.y - g < routine.aglMin) return false;
	}
	// Les murs, sur la grille GROSSIÈRE : un segment est une corde, la
	// densifier rejouerait le même rayon sur la même géométrie.
	for (let i = 0; i < SAMPLES; i++) {
		curveAt(routine, anchor, heights, routine.period * i / SAMPLES, _a);
		curveAt(routine, anchor, heights, routine.period * (i + 1) / SAMPLES, _b);
		if (stats) stats.raysCast += 2;
		const o = rays.obstructionBetween(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
		if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	}
	return true;
}

export class AmbientModel {
	constructor({ set, builds, bounds, seed }) {
		if (set.length > MAX_DRONES) throw new Error('trop d\'ambiants');
		this.set = set;
		this.builds = builds;
		this.bounds = bounds;
		this.seed = seed;
		this.families = set.map((d) => d.family);
		this.n = set.length;
		// Un slot par ambiant possible ; `alive[k]` dit s'il vole.
		this.alive = new Uint8Array(MAX_DRONES);
		this.pos = new Float64Array(3 * MAX_DRONES);
		this.vel = new Float64Array(3 * MAX_DRONES);
		this.acc = new Float64Array(3 * MAX_DRONES);
		this.quat = new Float64Array(4 * MAX_DRONES);
		this.anchors = new Float64Array(3 * MAX_DRONES);
		this.heights = Array.from({ length: MAX_DRONES }, () => new Float64Array(HEIGHT_SAMPLES));
		this.routines = new Array(MAX_DRONES).fill(null);
		this.t = new Float64Array(MAX_DRONES);
		this.stats = { relocations: 0, raysCast: 0, spawnFailures: 0 };
		this._pos = { x: 0, y: 0, z: 0 }; this._vel = { x: 0, y: 0, z: 0 }; this._acc = { x: 0, y: 0, z: 0 };
		this._anchor = { x: 0, y: 0, z: 0 };
		this._att = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: null, drag: null, mass: 1, yawX: 0, yawZ: -1 };
		this._q = new Float64Array(4);
		this._bubble = { rMin: 0, rMax: 0, rLeave: 0 };
		this._spawnArgs = { player: null, cam: null, fovDeg: 0, rays: null, top: 0, span: 0 };
		// Le slot par lequel spawnOne() commence son balayage. Il TOURNE — voir
		// spawnOne().
		this._spawnCursor = 0;
		this.reset();
	}

	get count() { let c = 0; for (let k = 0; k < this.n; k++) c += this.alive[k]; return c; }

	reset() {
		this.alive.fill(0);
		this.t.fill(0);
		this._spawnCursor = 0;
		this.rand = rngFrom(`${this.seed}::ambient`);
		for (let k = 0; k < this.n; k++) {
			this.routines[k] = routineFor({
				family: this.set[k].family, twr: this.builds[k].spec.twr,
				rand: rngFrom(`${this.set[k].buildSeed}::ambient::routine`),
			});
			this.quat[4 * k + 3] = 1;
		}
	}

	// Fait naître UN slot mort — un seul par frame, réussi ou non. Le balayage
	// commence à `_spawnCursor`, qui avance après chaque slot TENTÉ : sans
	// cette rotation, le premier slot mort était toujours le même, et un slot
	// impossible gelait tout le ciel derrière lui. C'est exactement ce qui
	// arrivait à un long range (rayon leg/2 + radius = 320 m) sur une carte
	// qui ne peut pas le loger : 0 naissance sur 4, pour toujours.
	// Rend true si un drone est né.
	spawnOne({ player, cam, fovDeg, rays, top, span }) {
		for (let j = 0; j < this.n; j++) {
			const k = (this._spawnCursor + j) % this.n;
			if (this.alive[k]) continue;
			this._spawnCursor = (k + 1) % this.n;
			const r = this.routines[k];
			const radius = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
			for (let tries = 0; tries < SPAWN_TRIES_PER_FRAME; tries++) {
				const a = pickAnchor({ rand: this.rand, player, cam, fovDeg, bounds: this.bounds, radius, rays, top, span, agl: r.agl, stats: this.stats });
				if (!a) { this.stats.spawnFailures++; continue; }
				if (!validateCurve({ routine: r, anchor: a, rays, heights: this.heights[k], top, span, stats: this.stats })) {
					this.stats.spawnFailures++; continue;
				}
				this.anchors[3 * k] = a.x; this.anchors[3 * k + 1] = a.y; this.anchors[3 * k + 2] = a.z;
				this.t[k] = this.rand() * r.period;
				this.alive[k] = 1;
				this._place(k, DERIVE_H);
				this._attitude(k, 10, NO_WIND);
				return true;
			}
			return false;   // un slot par frame, réussi ou non
		}
		return false;
	}

	_place(k, h) {
		const r = this.routines[k];
		this._anchor.x = this.anchors[3 * k]; this._anchor.y = this.anchors[3 * k + 1]; this._anchor.z = this.anchors[3 * k + 2];
		derive(r, this._anchor, this.heights[k], this.t[k], h, this._pos, this._vel, this._acc);
		this.pos[3 * k] = this._pos.x; this.pos[3 * k + 1] = this._pos.y; this.pos[3 * k + 2] = this._pos.z;
		this.vel[3 * k] = this._vel.x; this.vel[3 * k + 1] = this._vel.y; this.vel[3 * k + 2] = this._vel.z;
		this.acc[3 * k] = this._acc.x; this.acc[3 * k + 1] = this._acc.y; this.acc[3 * k + 2] = this._acc.z;
	}

	update({ dt, player, cam, fovDeg, rays, top, span, wind }) {
		if (dt <= 0) return;
		bubbleFor(this.bounds, player, this._bubble);
		const rLeave = this._bubble.rLeave;
		// Départs : l'ancre a quitté la bulle.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			const d = Math.hypot(this.anchors[3 * k] - player.x, this.anchors[3 * k + 2] - player.z);
			if (d > rLeave) { this.alive[k] = 0; this.stats.relocations++; }
		}
		// Une naissance au plus par frame. Args dans un scratch réutilisé : pas
		// de littéral alloué ici, même quand tous les slots volent déjà.
		const sa = this._spawnArgs;
		sa.player = player; sa.cam = cam; sa.fovDeg = fovDeg; sa.rays = rays; sa.top = top; sa.span = span;
		this.spawnOne(sa);
		// Avance et pose. Pas fixe (DERIVE_H) : l'attitude ne dépend pas du dt réel.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			this.t[k] += dt;
			this._place(k, DERIVE_H);
			this._attitude(k, dt, wind);
		}
	}

	_attitude(k, dt, wind) {
		const r = this.routines[k];
		const b = this.builds[k].profile;
		let yawX = this.vel[3 * k], yawZ = this.vel[3 * k + 2];
		if (r.faceAnchor) { yawX = this.anchors[3 * k] - this.pos[3 * k]; yawZ = this.anchors[3 * k + 2] - this.pos[3 * k + 2]; }
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = 0; yawZ = -1; }
		this._att.ax = this.acc[3 * k]; this._att.ay = this.acc[3 * k + 1]; this._att.az = this.acc[3 * k + 2];
		this._att.vx = this.vel[3 * k]; this._att.vy = this.vel[3 * k + 1]; this._att.vz = this.vel[3 * k + 2];
		this._att.wind = wind; this._att.drag = b.bodyDrag; this._att.mass = b.mass;
		this._att.yawX = yawX; this._att.yawZ = yawZ;
		attitudeFrom(this._att, this._q, 0);
		// Lissage exponentiel (nlerp) : les changements de segment ne sautent pas.
		const o = 4 * k, a = 1 - Math.exp(-dt / ATTITUDE_TAU);
		let d = this.quat[o] * this._q[0] + this.quat[o + 1] * this._q[1] + this.quat[o + 2] * this._q[2] + this.quat[o + 3] * this._q[3];
		const sgn = d < 0 ? -1 : 1;
		let nx = this.quat[o] + a * (sgn * this._q[0] - this.quat[o]);
		let ny = this.quat[o + 1] + a * (sgn * this._q[1] - this.quat[o + 1]);
		let nz = this.quat[o + 2] + a * (sgn * this._q[2] - this.quat[o + 2]);
		let nw = this.quat[o + 3] + a * (sgn * this._q[3] - this.quat[o + 3]);
		const n = Math.hypot(nx, ny, nz, nw) || 1;
		this.quat[o] = nx / n; this.quat[o + 1] = ny / n; this.quat[o + 2] = nz / n; this.quat[o + 3] = nw / n;
		// Le nlerp peut sortir du cône même entre deux cibles qui y sont : voir
		// clampTilt(). C'est ce quaternion-ci qui est rendu, c'est donc lui qui
		// doit tenir l'invariant.
		clampTilt(this.quat, o);
	}
}
