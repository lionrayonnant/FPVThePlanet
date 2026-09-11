// Logique pure du modèle de session (PHASE 06). Aucune E/S : importée par le
// plugin de dev, le selftest et (via un bundle Vite) le client.
//
// Une session lie un opérateur, une zone de terrain, une cible, un instantané
// météo, un intervalle temporel, un verdict et une télémétrie agrégée.
//
//   terrain persistent, flights ephemeral
//
// `PENDING` → `CRASHED` (impact, sortie de zone ou lien coupé : drone détruit,
//                        session terminée)
import { randomBytes } from 'node:crypto';
import { slugify } from './operator-store.mjs';
import { asText, nameOf } from './lib/as-text.mjs';
import {
	TARGET_FAMILIES, HACK_TYPES,
	SWARM_FAMILY, SWARM_SIZE_MIN, SWARM_SIZE_MAX,
} from './target-model.mjs';

// v3 (issue #29) adds target.swarm and target.scan.swarmAt/swarmChance. No
// migration: a v2 session simply has no swarm, honestly, the way a v1 session
// has no ambients.
export const SESSION_SCHEMA_VERSION = 3;
// Les verdicts qu'un vol peut PRODUIRE. `LANDED` en est parti avec
// l'atterrissage (D9, 2026-09-08) : un vol ne se termine plus que par un crash,
// une sortie de zone ou une coupure du lien, et les trois sont `CRASHED`.
export const SESSION_RESULTS = ['PENDING', 'CRASHED'];
// Les verdicts qu'un fichier opérateur peut CONTENIR. Les états écrits avant la
// disparition de l'atterrissage portent `LANDED` : ils doivent continuer à se
// relire, s'afficher et se laisser annoter. Pas de migration, pas de bump de
// SESSION_SCHEMA_VERSION — un verdict passé reste vrai.
const STORED_RESULTS = [...SESSION_RESULTS, 'LANDED'];
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

// Le scan d'origine (issue #250). `null` pour une session v1, qui n'en a
// jamais eu : elle garde sa cible mais pas ses ambiants.
function sanitizeScan(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target.scan invalide');
	if (typeof raw.seed !== 'string' || raw.seed.length === 0) throw new Error('target.scan.seed invalide');
	if (!Number.isInteger(raw.count) || raw.count < 2 || raw.count > 5) throw new Error('target.scan.count invalide');
	if (!Number.isInteger(raw.index) || raw.index < 0 || raw.index >= raw.count) throw new Error('target.scan.index invalide');
	// v3 (issue #29). Absent on a v2 scan, which predates swarms: it replays as
	// `null` chance 0, i.e. swarmless, which is exactly what it was.
	const at = raw.swarmAt ?? null;
	if (at !== null && (!Number.isInteger(at) || at < 0 || at >= raw.count)) {
		throw new Error('target.scan.swarmAt invalide');
	}
	const chance = raw.swarmChance ?? 0;
	if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new Error('target.scan.swarmChance invalide');
	return { seed: raw.seed, count: raw.count, index: raw.index, swarmAt: at, swarmChance: chance };
}

// The mesh the node commands (issue #29). `null` on any ordinary target.
function sanitizeSwarm(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target.swarm invalide');
	if (!Number.isInteger(raw.size) || raw.size < SWARM_SIZE_MIN || raw.size > SWARM_SIZE_MAX) {
		throw new Error('target.swarm.size invalide');
	}
	if (typeof raw.doctrineSeed !== 'string' || raw.doctrineSeed.length === 0) {
		throw new Error('target.swarm.doctrineSeed invalide');
	}
	return { size: raw.size, doctrineSeed: raw.doctrineSeed };
}

// The families an operator file may CONTAIN. `swarmNode` is not in
// TARGET_FAMILIES and must not enter it — an ordinary scan could then draw it
// and the rarity would be gone (issue #29) — but a session that took a cluster
// carries it legitimately, so it is allowed here, explicitly.
const STORED_FAMILIES = [...TARGET_FAMILIES, SWARM_FAMILY];

// Ne garde que la forme connue du descripteur de cible (PHASE 08). `null` est
// licite : une session peut s'ouvrir sans cible (chemin dev ?scene=).
export function sanitizeTarget(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target invalide');
	if (!STORED_FAMILIES.includes(raw.family)) throw new Error(`famille de cible inconnue : ${asText(raw.family, nameOf(raw.family))}`);
	if (raw.hackType != null && !HACK_TYPES.includes(raw.hackType)) {
		throw new Error(`hackType de cible inconnu : ${asText(raw.hackType, nameOf(raw.hackType))}`);
	}
	const sig = raw.signal;
	if (!sig || typeof sig !== 'object') throw new Error('target.signal manquant');
	if (!Number.isFinite(sig.rssiDbm) || sig.rssiDbm >= 0) throw new Error('target.signal.rssiDbm invalide');
	if (sig.mode !== 'ANALOG' && sig.mode !== 'DIGITAL') throw new Error('target.signal.mode invalide');
	if (!raw.intel || typeof raw.intel !== 'object') throw new Error('target.intel manquant');
	return {
		family: raw.family,
		classHint: raw.classHint ?? null,
		hackType: raw.hackType ?? null,
		signal: { rssiDbm: sig.rssiDbm, mode: sig.mode },
		scannedAt: raw.scannedAt ?? null,
		scan: sanitizeScan(raw.scan),
		swarm: sanitizeSwarm(raw.swarm),
		intel: { ...raw.intel },
	};
}

// Ne garde que la forme connue d'une capture (PHASE 16). `ts` est reposé par le
// serveur, jamais celui qu'envoie le client : l'horodatage de la photo n'a pas
// à dépendre de l'horloge du navigateur.
export function sanitizePhoto(raw) {
	if (!raw || typeof raw !== 'object') throw new Error('photo invalide');
	if (typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:image/')) {
		throw new Error('photo.dataUrl invalide');
	}
	if (!Number.isInteger(raw.w) || raw.w <= 0) throw new Error('photo.w invalide');
	if (!Number.isInteger(raw.h) || raw.h <= 0) throw new Error('photo.h invalide');
	return { dataUrl: raw.dataUrl, w: raw.w, h: raw.h, ts: new Date().toISOString() };
}

// Ajoute une capture sans muter la session existante : plusieurs captures par
// session, chacune un élément de plus dans `photos[]`.
export function addPhoto(session, raw) {
	if (!session || typeof session !== 'object') throw new Error('session illisible');
	const photo = sanitizePhoto(raw);
	return { ...session, photos: [...(session.photos ?? []), photo] };
}

export function openSession({ operatorId, area, weatherSnapshot, target, seq, targetSeq }) {
	if (!operatorId) throw new Error('operatorId requis');
	const areaSlug = slugify(area);
	if (!areaSlug) throw new Error('AREA UNUSABLE');
	const id = newSessionId(area);
	const resolved = sanitizeTarget(target);
	const session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		id,
		operatorId,
		area: areaSlug,
		// Numéro d'affichage (PHASE 17). Attribué par le serveur, qui seul connaît
		// le compteur de l'opérateur ; figé pour toujours.
		seq,
		target: resolved,
		weatherSnapshot: sanitizeWeatherSnapshot(weatherSnapshot),
		start: new Date().toISOString(),
		end: null,
		result: 'PENDING',
		flightTelemetry: freshTelemetry(),
		photos: [],
		comment: null,
	};
	// Sans cible, la clé n'est posée que si l'appelant a dit quelque chose : une
	// session ouverte sans TARGET SCAN n'a pas de `targetSeq` du tout, et un
	// `null` explicite reste un `null` (ce que `validateSession` accepte).
	if (resolved || targetSeq !== undefined) session.targetSeq = targetSeq;
	return session;
}

// Fusionne deux jeux d'agrégats : `max` sur les pics, `+` sur les cumuls.
// Associative — trois segments dans n'importe quel ordre donnent le même total.
export function mergeTelemetry(rawA = ZERO_TELEMETRY, rawB = ZERO_TELEMETRY) {
	// A default parameter only covers `undefined`. A stored session whose
	// `flightTelemetry` is null — JSON can hold that, and a file written by
	// hand does — reached this as `null` and closeSession died on it with a
	// TypeError instead of closing the flight.
	const a = rawA ?? ZERO_TELEMETRY;
	const b = rawB ?? ZERO_TELEMETRY;
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
	if (result !== 'CRASHED') throw new Error('verdict invalide');
	return {
		...session,
		end: new Date().toISOString(),
		result,
		flightTelemetry: mergeTelemetry(session.flightTelemetry, telemetry),
	};
}

// OPERATOR NOTE (PHASE 15, Bible §25) : texte libre, attaché à une session déjà
// close aussi bien qu'à une session PENDING — contrairement à closeSession, qui
// exige PENDING (un verdict ne se rouvre pas), une note s'ajoute à tout moment.
const COMMENT_MAX_LEN = 400;

export function sanitizeComment(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'string') throw new Error('comment invalide');
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.length > COMMENT_MAX_LEN) throw new Error(`COMMENT TOO LONG (max ${COMMENT_MAX_LEN})`);
	return trimmed;
}

export function annotateSession(session, comment) {
	if (!session || typeof session !== 'object') throw new Error('session illisible');
	return { ...session, comment: sanitizeComment(comment) };
}

// PHASE 17, spec D4 : les captures sont stockées en base64 DANS la session, et
// le terminal recharge l'opérateur entier à chaque retour au menu. On élide les
// `dataUrl` de toutes les réponses sauf celle de la route dédiée
// `GET .../sessions/:sid`, seule à les rendre — et seule appelée par l'écran
// VIEW SESSION. `w`/`h`/`ts` restent : ils suffisent au compte et au filtre
// WITH PHOTOS.
//
// Le résultat est un FORMAT DE FIL, pas un état persistable : il ne repasse
// jamais par `validateSession` (qui exige à raison une `dataUrl` par capture),
// et l'élision n'a lieu qu'au moment de répondre, après l'écriture disque.
export function stripPhotoData(session) {
	if (!session || typeof session !== 'object') return session;
	return {
		...session,
		photos: (session.photos ?? []).map(({ dataUrl, ...rest }) => rest),
	};
}

export function stripOperatorPhotoData(state) {
	if (!state || typeof state !== 'object') return state;
	return { ...state, sessions: (state.sessions ?? []).map(stripPhotoData) };
}

// PHASE 17, spec D3 : suppression franche. L'entrée quitte `state.sessions`,
// captures comprises ; le terrain n'est JAMAIS touché — symétrique de
// « supprimer le terrain ne supprime pas le souvenir » (Bible §29).
// Les compteurs ne reculent pas : un numéro ne se recycle pas, la suppression
// laisse un trou visible dans le journal.
export function deleteSession(state, sid) {
	const sessions = state?.sessions ?? [];
	const i = sessions.findIndex((s) => s.id === sid);
	if (i < 0) {
		const e = new Error(`aucune session "${sid}"`);
		e.status = 404;
		throw e;
	}
	if (sessions[i].result === 'PENDING') {
		// Peut-être encore en vol dans un autre onglet : on ne supprime pas sous
		// les pieds d'une session ouverte.
		const e = new Error(`session "${sid}" encore en vol`);
		e.status = 409;
		throw e;
	}
	return { ...state, sessions: [...sessions.slice(0, i), ...sessions.slice(i + 1)] };
}

// Garde-fou serveur : rejette tout ce qui n'a pas la forme attendue.
export function validateSession(s) {
	if (!s || typeof s !== 'object') throw new Error('session illisible');
	if (!SESSION_ID_RE.test(asText(s.id))) throw new Error('id de session invalide');
	if (!STORED_RESULTS.includes(s.result)) throw new Error(`result inconnu : ${asText(s.result, nameOf(s.result))}`);
	if (!s.operatorId) throw new Error('operatorId requis');
	if (!slugify(s.area)) throw new Error('area invalide');
	sanitizeWeatherSnapshot(s.weatherSnapshot); // throw si malformé
	// sanitizeTarget holds ALL of the target's shape validation, the v3 swarm
	// included: validating it a second time here would mean two rules to keep.
	if (s.target != null) sanitizeTarget(s.target); // throw si malformé
	// Numéros d'affichage (PHASE 17). Contrôlés APRÈS la forme de la cible : une
	// cible malformée est une erreur plus fondamentale que sa numérotation, et
	// c'est elle que l'appelant doit voir en premier.
	if (!Number.isInteger(s.seq) || s.seq < 1) throw new Error('seq de session invalide');
	if (s.target != null) {
		if (!Number.isInteger(s.targetSeq) || s.targetSeq < 1) {
			throw new Error('targetSeq requis pour une session avec cible');
		}
	} else if (s.targetSeq != null) {
		throw new Error('targetSeq sans cible');
	}
	const t = s.flightTelemetry ?? {};
	for (const k of Object.keys(ZERO_TELEMETRY)) {
		const v = t[k];
		if (!Number.isFinite(v) || v < 0) throw new Error(`télémétrie.${k} invalide`);
	}
	if (s.result !== 'PENDING' && !s.end) throw new Error('session fermée sans end');
	if (!Array.isArray(s.photos)) throw new Error('photos invalide');
	for (const p of s.photos) sanitizePhoto(p); // throw si une capture est malformée
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
