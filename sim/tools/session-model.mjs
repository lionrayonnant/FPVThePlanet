// Logique pure du modèle de session (PHASE 06). Aucune E/S : importée par le
// plugin de dev, le selftest et (via un bundle Vite) le client.
//
// Une session lie un opérateur, une zone de terrain, une cible, un instantané
// météo, un intervalle temporel, un verdict et une télémétrie agrégée.
//
//   terrain persistent, flights ephemeral
//
// `PENDING` → `LANDED` (pose + désarmement, drone conservé, session ré-ouvrable)
//           → `CRASHED` (impact, drone détruit, session terminée)
import { randomBytes } from 'node:crypto';
import { slugify } from './operator-store.mjs';
import { randomart } from './randomart.mjs';
import { TARGET_FAMILIES } from './target-model.mjs';

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_RESULTS = ['PENDING', 'LANDED', 'CRASHED'];
export const SESSION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;

// Une session qui traîne en `PENDING` plus longtemps que ça au moment d'un
// rechargement du terminal n'a pas été fermée proprement : l'onglet est mort en
// vol. C'est un crash. Large exprès — mieux vaut rattraper un crash tard que
// marquer CRASHED une session encore en vol dont on a rouvert le terminal dans
// un autre onglet.
const STALE_MS = 30 * 60 * 1000;

const ZERO_TELEMETRY = {
	durationS: 0,
	maxSpeedMs: 0,
	maxRateDps: 0,
	maxAltitudeM: 0,
	distanceM: 0,
};

export function freshTelemetry() {
	return { ...ZERO_TELEMETRY };
}

export function newSessionId(area) {
	const base = slugify(area);
	if (!base) throw new Error('AREA UNUSABLE');
	return `${base}-${randomBytes(2).toString('hex')}`;
}

// Ne garde que la forme connue de l'instantané météo. `null` est licite : la
// météo est du décor, elle n'a pas le droit d'empêcher un vol — donc pas non
// plus d'empêcher une session de s'ouvrir.
export function sanitizeWeatherSnapshot(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('weatherSnapshot invalide');
	const day0 = raw.day0 ?? raw.days?.[0] ?? null;
	if (!day0 || typeof day0 !== 'object') throw new Error('weatherSnapshot sans jour');
	const num = (v) => (Number.isFinite(v) ? v : null);
	return {
		zone: raw.zone ?? null,
		day: raw.day ?? null,
		source: raw.source ?? null,
		regime: day0.regime ?? null,
		confidence: num(day0.confidence),
		day0,
	};
}

// Ne garde que la forme connue du descripteur de cible (PHASE 08). `null` est
// licite : une session peut s'ouvrir sans cible (chemin dev ?scene=).
export function sanitizeTarget(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target invalide');
	if (!TARGET_FAMILIES.includes(raw.family)) throw new Error(`famille de cible inconnue : ${raw.family}`);
	const sig = raw.signal;
	if (!sig || typeof sig !== 'object') throw new Error('target.signal manquant');
	if (!Number.isFinite(sig.rssiDbm) || sig.rssiDbm >= 0) throw new Error('target.signal.rssiDbm invalide');
	if (sig.mode !== 'ANALOG' && sig.mode !== 'DIGITAL') throw new Error('target.signal.mode invalide');
	if (!raw.intel || typeof raw.intel !== 'object') throw new Error('target.intel manquant');
	return {
		family: raw.family,
		classHint: raw.classHint ?? null,
		signal: { rssiDbm: sig.rssiDbm, mode: sig.mode },
		scannedAt: raw.scannedAt ?? null,
		intel: { ...raw.intel },
	};
}

export function openSession({ operatorId, area, weatherSnapshot, target }) {
	if (!operatorId) throw new Error('operatorId requis');
	const areaSlug = slugify(area);
	if (!areaSlug) throw new Error('AREA UNUSABLE');
	const id = newSessionId(area);
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		id,
		operatorId,
		area: areaSlug,
		target: sanitizeTarget(target),
		weatherSnapshot: sanitizeWeatherSnapshot(weatherSnapshot),
		start: new Date().toISOString(),
		end: null,
		result: 'PENDING',
		flightTelemetry: freshTelemetry(),
		randomart: randomart(id, { tag: id.slice(-4) }),
		photos: [],
		comment: null,
		resumeCount: 0,
	};
}

// Ré-ouvre une session `LANDED` : on garde tout ce qui fait son identité
// (id, start, randomart, télémétrie déjà accumulée) et on repart en vol.
export function resumeSession(existing) {
	if (!existing || typeof existing !== 'object') throw new Error('session illisible');
	if (existing.result !== 'LANDED') throw new Error('SESSION NOT RESUMABLE');
	return {
		...existing,
		result: 'PENDING',
		end: null,
		resumeCount: (existing.resumeCount ?? 0) + 1,
	};
}

// Fusionne deux jeux d'agrégats : `max` sur les pics, `+` sur les cumuls.
// Associative — trois segments dans n'importe quel ordre donnent le même total.
export function mergeTelemetry(a = ZERO_TELEMETRY, b = ZERO_TELEMETRY) {
	const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
	return {
		durationS: n(a.durationS) + n(b.durationS),
		distanceM: n(a.distanceM) + n(b.distanceM),
		maxSpeedMs: Math.max(n(a.maxSpeedMs), n(b.maxSpeedMs)),
		maxRateDps: Math.max(n(a.maxRateDps), n(b.maxRateDps)),
		maxAltitudeM: Math.max(n(a.maxAltitudeM), n(b.maxAltitudeM)),
	};
}

export function closeSession(session, { result, telemetry } = {}) {
	if (!session || typeof session !== 'object') throw new Error('session illisible');
	if (result !== 'LANDED' && result !== 'CRASHED') throw new Error('verdict invalide');
	return {
		...session,
		end: new Date().toISOString(),
		result,
		flightTelemetry: mergeTelemetry(session.flightTelemetry, telemetry),
	};
}

// Garde-fou serveur : rejette tout ce qui n'a pas la forme attendue.
export function validateSession(s) {
	if (!s || typeof s !== 'object') throw new Error('session illisible');
	if (!SESSION_ID_RE.test(String(s.id ?? ''))) throw new Error('id de session invalide');
	if (!SESSION_RESULTS.includes(s.result)) throw new Error(`result inconnu : ${s.result}`);
	if (!s.operatorId) throw new Error('operatorId requis');
	if (!slugify(s.area)) throw new Error('area invalide');
	sanitizeWeatherSnapshot(s.weatherSnapshot); // throw si malformé
	if (s.target != null) sanitizeTarget(s.target); // throw si malformé
	const t = s.flightTelemetry ?? {};
	for (const k of Object.keys(ZERO_TELEMETRY)) {
		const v = t[k];
		if (!Number.isFinite(v) || v < 0) throw new Error(`télémétrie.${k} invalide`);
	}
	if (s.result !== 'PENDING' && !s.end) throw new Error('session fermée sans end');
	return s;
}

// Passe en `CRASHED` toute session restée `PENDING` au-delà du seuil : l'onglet
// est mort en vol. Renvoie `{ state, changed }` — l'appelant réécrit si besoin.
export function reconcileStaleSessions(state, now = Date.now()) {
	let changed = false;
	const sessions = (state.sessions ?? []).map((s) => {
		if (s.result !== 'PENDING') return s;
		const age = now - Date.parse(s.start ?? 0);
		if (!(age > STALE_MS)) return s;
		changed = true;
		return { ...s, result: 'CRASHED', end: new Date(now).toISOString() };
	});
	return { state: changed ? { ...state, sessions } : state, changed };
}
