// Logique pure du Session Log et du Target Log (PHASE 17, Bible §28).
// Aucune E/S, aucun DOM, aucun `node:` — importable tel quel par le client
// (bundlé par Vite) comme par le selftest.
//
// Le Target Log est DÉRIVÉ des sessions (spec D1) : il n'y a pas de stock à
// tenir à jour, seulement une lecture de `state.sessions`. Une session
// supprimée emporte donc la trace de sa cible, ce qui est le comportement
// voulu — le log ne conserve que la trace d'une session.
import { formatVisibility, windLabel } from './lib/weather.mjs';
import { PROFILES } from '../src/drone-profiles.js';

// `LANDED` est parti avec l'atterrissage (D9, 2026-09-08) : aucun vol ne peut
// plus produire ce verdict. Les vieilles sessions qui le portent restent
// listées et affichées sous `ALL`, telles qu'elles ont été écrites.
export const SESSION_FILTERS = ['ALL', 'CRASHED', 'WITH PHOTOS'];

// L'identifiant de zone d'un vol EN DIRECT (#218). Une zone streamée n'existe
// pas sur le disque : elle n'a donc pas de slug, et il faut lui en forger un
// pour que la session ait un nom au journal — `openSession()` refuse une zone
// qui ne se slugifie pas.
//
// Le préfixe `live-` n'est pas décoratif. `terminal.js` conditionne REVISIT à
// `model.areas.some((a) => a.slug === area)` : sans préfixe, un vol en direct
// au-dessus d'un quartier qui porte le nom d'une zone acquise proposerait de
// « revisiter » un terrain qui n'est pas celui qu'on a survolé.
// Le préfixe rend la collision impossible plutôt qu'improbable.
//
// Les coordonnées servent de repli quand Nominatim n'a rien rendu : une zone
// sans nom reste identifiable, et deux vols au même endroit portent le même
// identifiant.
export function liveAreaId(place, lat, lon) {
	const named = String(place ?? '').trim();
	if (named) return `live-${named}`;
	const n = (v) => (Number.isFinite(v) ? v.toFixed(4) : '0');
	return `live-${n(lat)}-${n(lon)}`;
}

export function pad(n, width = 5) {
	const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	return String(v).padStart(width, '0');
}

// `tour-eiffel` → `TOUR EIFFEL`. Dérivé du slug porté par la session, jamais de
// `scenes.json` ni du `terrainCache` : une session doit rester lisible après la
// suppression de son terrain (Bible §29, « supprimer le terrain ne supprime pas
// le souvenir »).
// Une colonne de largeur fixe : complétée à droite, et COUPÉE si elle déborde.
// `padEnd` seul ne coupe pas — une zone au nom long (CONSERVATOIRE NATIONAL DES
// ARTS ET METIERS, 41 signes pour une colonne de 26) poussait alors toutes les
// colonnes suivantes vers la droite, et la table cessait d'être une table :
// chaque ligne s'alignait sur le nom de SA zone. L'ellipse dit que c'est coupé,
// plutôt que de laisser croire à un nom qui finit là.
export function fit(s, width) {
	const v = String(s ?? '');
	if (v.length <= width) return v.padEnd(width);
	return width <= 1 ? '…' : `${v.slice(0, width - 1)}…`;
}

export function areaLabel(slug) {
	const s = String(slug ?? '').trim();
	return s ? s.replace(/-+/g, ' ').toUpperCase() : 'UNKNOWN AREA';
}

// `28.08.26 / 21:42`, en heure LOCALE : c'est l'heure qu'il était pour
// l'opérateur, pas UTC.
export function stamp(iso) {
	const d = new Date(iso ?? NaN);
	if (Number.isNaN(d.getTime())) return '—';
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)}`
		+ ` / ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function duration(seconds) {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
	const m = Math.floor(s / 60);
	return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function filterSessions(sessions, filter) {
	const list = Array.isArray(sessions) ? sessions.slice() : [];
	switch (filter) {
		case 'CRASHED': return list.filter((s) => s.result === 'CRASHED');
		case 'WITH PHOTOS': return list.filter((s) => (s.photos?.length ?? 0) > 0);
		// `ALL` — et tout filtre inconnu, plutôt qu'une liste vide inexplicable.
		default: return list;
	}
}

function familyLabel(family) {
	return PROFILES[family]?.label ?? String(family ?? 'UNKNOWN');
}

export function sessionRow(s) {
	const target = s?.targetSeq ? `TARGET ${pad(s.targetSeq, 3)}` : 'NO TARGET';
	return [
		fit(`SESSION ${pad(s?.seq)}`, 14),
		fit(areaLabel(s?.area), 26),
		fit(target, 11),
		fit(String(s?.result ?? 'UNKNOWN'), 8),
		duration(s?.flightTelemetry?.durationS),
	].join(' ');
}

// Chaque bloc rend `null` quand sa donnée manque : un bloc absent est omis du
// détail, jamais rempli d'une valeur inventée.
function targetBlock(s) {
	const t = s?.target;
	if (!t) return null;
	const lines = [`TARGET ${pad(s.targetSeq, 3)}`, familyLabel(t.family)];
	if (t.signal) lines[1] += `  ${t.signal.rssiDbm} dBm ${t.signal.mode}`;
	if (t.hackType) lines.push(t.hackType);
	return lines;
}

function weatherBlock(snapshot) {
	const d = snapshot?.day0;
	if (!d) return null;
	const lines = ['WEATHER', snapshot.regime ?? d.regime ?? 'UNKNOWN'];
	if (Number.isFinite(d.windSpeed)) {
		lines.push(`WIND ${d.windSpeed.toFixed(1)} m/s  ${windLabel(d.windSpeed)}`);
	}
	if (Number.isFinite(d.rateMmH) && d.rateMmH >= 0.05) {
		lines.push(`RAIN ${d.rateMmH.toFixed(1)} mm/h`);
	}
	if (Number.isFinite(d.visibilityM)) lines.push(`VIS ${formatVisibility(d.visibilityM)}`);
	return lines;
}

function flightBlock(s) {
	const tel = s?.flightTelemetry ?? {};
	return [
		'FLIGHT',
		duration(tel.durationS),
		`MAX SPEED ${(tel.maxSpeedMs ?? 0).toFixed(1)} m/s`
			+ ` · MAX ALT ${Math.round(tel.maxAltitudeM ?? 0)} m`
			+ ` · DISTANCE ${Math.round(tel.distanceM ?? 0)} m`,
		`RESULT ${s?.result ?? 'UNKNOWN'}`,
	];
}

export function sessionDetail(s) {
	const blocks = [
		[`SESSION ${pad(s?.seq)}`],
		[areaLabel(s?.area), stamp(s?.start)],
		targetBlock(s),
		s?.randomart ? ['RANDOMART', s.randomart] : null,
		weatherBlock(s?.weatherSnapshot),
		flightBlock(s),
		// Zéro capture reste affiché : « aucune photo » est une information.
		['CAPTURES', pad(s?.photos?.length ?? 0, 2)],
		s?.comment ? ['OPERATOR NOTE', `"${s.comment}"`] : null,
	];
	return blocks.filter(Boolean).map((b) => b.join('\n')).join('\n\n');
}

export function targetLogEntries(sessions) {
	return (Array.isArray(sessions) ? sessions : [])
		.filter((s) => s?.target && s?.targetSeq)
		.map((s) => ({
			targetSeq: s.targetSeq,
			sessionId: s.id,
			family: s.target.family,
			label: familyLabel(s.target.family),
			rssiDbm: s.target.signal?.rssiDbm ?? null,
			mode: s.target.signal?.mode ?? null,
			hackType: s.target.hackType ?? null,
			area: s.area,
			at: s.start,
			result: s.result,
		}))
		.sort((a, b) => b.targetSeq - a.targetSeq);
}

export function targetRow(e) {
	const signal = e.rssiDbm == null ? 'NO SIGNAL' : `${String(e.rssiDbm).padStart(4)} dBm ${e.mode}`;
	return [
		fit(`TARGET ${pad(e.targetSeq, 3)}`, 11),
		fit(e.label, 14),
		fit(signal, 17),
		fit(areaLabel(e.area), 26),
		fit(stamp(e.at), 17),
		String(e.result ?? 'UNKNOWN'),
	].join(' ');
}
