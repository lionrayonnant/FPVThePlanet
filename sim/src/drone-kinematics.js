// Modèle cinématique pur d'un drone (attitude, RNG déterministe). Ni Three,
// ni Rapier, ni DOM : partagé entre src/ambient.js (drones ambiants) et,
// à terme, le pilotage du nœud de l'essaim (issue #29).

export const G = 9.81;
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

// Accélération latérale maximale d'un quad de rapport poussée/poids twr :
// la poussée doit d'abord porter le poids, le reste vire.
export function lateralAccelMax(twr) {
	return twr > 1 ? G * Math.sqrt(twr * twr - 1) : 0;
}

export const ATTITUDE_TAU = 0.08;

// Base orthonormée → quaternion (x,y,z,w). Colonnes : X = droite, Y = haut,
// Z = arrière (le nez est −Z, comme la caméra Three du joueur).
export function quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz, out, o) {
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
export function clampToCone(x, y, z, out) {
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
