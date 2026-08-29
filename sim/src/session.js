// Cycle de vie d'une session, côté client (PHASE 06). Aucun DOM, aucun Three.
//
// La session est tenue en mémoire pendant tout le vol : deux appels réseau
// seulement, un POST à l'ouverture (squelette PENDING sur disque, pour qu'un
// onglet mort laisse quand même une trace) et un PATCH à la clôture avec la
// télémétrie agrégée. Rien pendant le vol.
//
//   terrain persistent, flights ephemeral
import * as operator from './operator.js';

let live = null; // { id, session, tel, closed }

// Forme minimale de l'instantané météo, sans dépendre du modèle serveur (qui
// tire node:crypto). Le serveur re-filtre de toute façon.
export function snapshotWeather(weather) {
	if (!weather) return null;
	const day0 = weather.days?.[0] ?? null;
	if (!day0) return null;
	return {
		zone: weather.zone ?? null,
		day: weather.day ?? null,
		source: weather.source ?? null,
		regime: day0.regime ?? null,
		confidence: Number.isFinite(day0.confidence) ? day0.confidence : null,
		day0,
	};
}

function zeroTel() {
	return { durationS: 0, maxSpeedMs: 0, maxRateDps: 0, maxAltitudeM: 0, distanceM: 0 };
}

export function current() { return live?.session ?? null; }

export async function open({ area, weatherSnapshot, resume } = {}) {
	const body = resume ? { resume } : { area, weatherSnapshot };
	const session = await operator.postSession(body);
	live = { id: session.id, session, tel: zeroTel(), closed: false };
	return session;
}

// Appelé une fois par frame. N'agrège durée et distance que quand le drone est
// armé — un drone posé et désarmé ne « vole » pas.
export function feed({ speed = 0, horizontalSpeed = 0, rateDps = 0, altitudeAboveSpawn = 0, dt = 0, armed = false } = {}) {
	if (!live || live.closed) return;
	const t = live.tel;
	if (armed && dt > 0) {
		t.durationS += dt;
		t.distanceM += Math.max(0, horizontalSpeed) * dt;
	}
	if (speed > t.maxSpeedMs) t.maxSpeedMs = speed;
	if (rateDps > t.maxRateDps) t.maxRateDps = rateDps;
	if (altitudeAboveSpawn > t.maxAltitudeM) t.maxAltitudeM = altitudeAboveSpawn;
}

// `LANDED` ou `CRASHED`. Idempotent : le premier verdict gagne.
export async function end(result) {
	if (!live || live.closed) return null;
	live.closed = true;
	const { id, tel } = live;
	try {
		const session = await operator.patchSession(id, { result, telemetry: round(tel) });
		live.session = session;
		return session;
	} catch (e) {
		console.warn('[session] clôture échouée, réconciliation au prochain terminal', e);
		return null;
	}
}

// Best-effort quand l'onglet se ferme en plein vol : sendBeacon ne sait faire
// que POST, la route de clôture l'accepte pour ça. Si ça rate, la
// réconciliation serveur passe la session PENDING en CRASHED.
export function beacon(result = 'CRASHED') {
	if (!live || live.closed) return;
	live.closed = true;
	try {
		const op = operator.getOperator();
		if (!op || !navigator.sendBeacon) return;
		const url = `${operator.operatorBase()}/${op.id}/sessions/${live.id}`;
		const blob = new Blob([JSON.stringify({ result, telemetry: round(live.tel) })],
			{ type: 'application/json' });
		navigator.sendBeacon(url, blob);
	} catch { /* l'onglet meurt, la réconciliation couvre */ }
}

function round(t) {
	return {
		durationS: +t.durationS.toFixed(1),
		distanceM: Math.round(t.distanceM),
		maxSpeedMs: +t.maxSpeedMs.toFixed(1),
		maxRateDps: Math.round(t.maxRateDps),
		maxAltitudeM: +t.maxAltitudeM.toFixed(1),
	};
}

// Pour les tests.
export function _reset() { live = null; }
