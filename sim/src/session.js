// Cycle de vie d'une session, côté client (PHASE 06). Aucun DOM, aucun Three.
//
// La session est tenue en mémoire pendant tout le vol : deux appels réseau
// seulement, un POST à l'ouverture (squelette PENDING sur disque, pour qu'un
// onglet mort laisse quand même une trace) et un PATCH à la clôture avec la
// télémétrie agrégée. Rien pendant le vol.
//
//   terrain persistent, flights ephemeral
import * as operator from './operator.js';
import { Coverage } from './coverage.js';

// La couverture (issue #245) s'échantillonne à 5 Hz, pas à la frame : à
// 42,72 m/s — la pire vitesse mesurée du dépôt — deux échantillons sont à
// 8,5 m, très en deçà des 30 m de l'empreinte. Aucun trou possible, et
// rien à faire entre deux échantillons.
export const SAMPLE_S = 0.2;

let live = null; // { id, session, tel, closed, cov, sinceSample }

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

export async function open({ area, weatherSnapshot, resume, target } = {}) {
	// `target = { seed, count, index }` : la cible choisie au TARGET SCAN. Le
	// serveur régénère la fiche complète depuis ces trois clés (PHASE 08).
	const body = resume
		? { resume }
		: { area, weatherSnapshot, targetSeed: target?.seed, targetCount: target?.count, targetIndex: target?.index };
	const session = await operator.postSession(body);
	live = { id: session.id, session, tel: zeroTel(), closed: false, cov: new Coverage(), sinceSample: 0 };
	return session;
}

// La couverture de la session en cours (issue #245), pour les bancs et le debug.
export function coverage() { return live?.cov ?? null; }

// Appelé une fois par frame. N'agrège durée et distance que quand le drone est
// armé — un drone posé et désarmé ne « vole » pas.
//
// `geo` (issue #245) : une FONCTION qui rend { lat, lon }, pas la valeur. Elle
// n'est appelée qu'aux échantillons (5 Hz), pour que la conversion ENU → lat/lon
// ne coûte rien entre deux. Un résultat non fini est ignoré : une position
// dégénérée (drone passé sous le terrain pendant une chute, #182) ne doit pas
// marquer une cellule au large de l'Afrique.
export function feed({ speed = 0, horizontalSpeed = 0, rateDps = 0, altitudeAboveSpawn = 0, dt = 0, armed = false, geo = null } = {}) {
	if (!live || live.closed) return;
	const t = live.tel;
	// Rien ne compte quand le drone est désarmé : ni la durée, ni la distance,
	// ni les pics — un drone posé qui rebondit sur sa sphère de collision n'est
	// pas en train de « voler à 2000 °/s ».
	if (!armed) return;
	if (dt > 0) {
		t.durationS += dt;
		t.distanceM += Math.max(0, horizontalSpeed) * dt;
		// dt = 0 quand la sim est gelée : on n'échantillonne pas en pause.
		live.sinceSample += dt;
		// `- 1e-9` : douze additions de 1/60 tombent à 0,19999999999999998.
		if (geo && live.sinceSample >= SAMPLE_S - 1e-9) {
			live.sinceSample = 0;
			const g = geo();
			if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) live.cov.mark(g.lat, g.lon);
		}
	}
	if (speed > t.maxSpeedMs) t.maxSpeedMs = speed;
	if (rateDps > t.maxRateDps) t.maxRateDps = rateDps;
	if (altitudeAboveSpawn > t.maxAltitudeM) t.maxAltitudeM = altitudeAboveSpawn;
}

// Nombre de captures prises pendant la session en cours (PHASE 16).
export function photoCount() { return live?.session?.photos?.length ?? 0; }

// Envoie une capture au serveur, qui fait autorité sur le compte final (rendu
// via la session mise à jour). Rend 0 sans rien envoyer si aucune session
// n'est ouverte ou déjà close — pas de photo orpheline.
export async function capturePhoto({ dataUrl, w, h }) {
	if (!live || live.closed) return 0;
	try {
		live.session = await operator.postPhoto(live.id, { dataUrl, w, h });
		return photoCount();
	} catch (e) {
		console.warn('[session] capture échouée', e);
		return photoCount();
	}
}

// `LANDED` ou `CRASHED`. Idempotent : le premier verdict gagne.
export async function end(result) {
	if (!live || live.closed) return null;
	live.closed = true;
	const { id, tel } = live;
	// La couverture s'écrit ICI et une seule fois (issue #245). operator.patch()
	// est débouncé mais réémet toute la valeur à chaque flush : patcher en vol
	// enverrait le blob entier plusieurs fois par seconde. Et c'est ce qui a du
	// sens : le monde retient ce qu'une session a FAIT, pas ce qu'elle fait.
	//
	// Le banc n'arrive jamais ici : il n'ouvre aucune session, donc `live` est
	// null et feed() ne marque rien. NOTHING LOGGED est acquis par construction,
	// sans garde à maintenir.
	//
	// Avant le PATCH de la session : si celui-ci échoue, la couverture est
	// quand même dans le cache client et partira au prochain flush — un vol
	// dont on perd la fiche ne doit pas aussi perdre sa trace sur la carte.
	flushCoverage();
	try {
		const session = await operator.patchSession(id, { result, telemetry: round(tel) });
		live.session = session;
		return session;
	} catch (e) {
		console.warn('[session] clôture échouée, réconciliation au prochain terminal', e);
		return null;
	}
}

// Fusionne la couverture de la session avec celle de l'opérateur, borne, et
// pose la clé dans le cache client via patch() — écrite au prochain flush
// (debounce, visibilitychange ou beforeunload). Une session qui n'a rien marqué
// n'écrit rien : pas de clé posée pour rien sur un opérateur qui n'en avait pas.
//
// La couverture opérateur est relue par fromStored(), qui rend une couverture
// vierge pour tout ce qui n'est pas exactement la forme attendue : un fichier
// corrompu repart de la session seule plutôt que de bloquer la clôture.
function flushCoverage() {
	if (!live || live.cov.size === 0) return;
	try {
		const before = Coverage.fromStored(operator.getOperator()?.coverage);
		const merged = before.merge(live.cov).cap();
		operator.patch('coverage', merged.toStored());
	} catch (e) {
		console.warn('[session] couverture non écrite (cosmétique)', e);
	}
}

// Best-effort quand l'onglet se ferme en plein vol : sendBeacon ne sait faire
// que POST, la route de clôture l'accepte pour ça. Si ça rate, la
// réconciliation serveur passe la session PENDING en CRASHED.
export function beacon(result = 'CRASHED') {
	if (!live || live.closed) return;
	live.closed = true;
	// sendBeacon ne fait que des POST, et la couverture voyage par un PATCH de
	// clé opérateur : la trace de CETTE session est perdue si l'onglet meurt.
	// Assumé (spec #245) — la fiche de session, elle, part bien.
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
