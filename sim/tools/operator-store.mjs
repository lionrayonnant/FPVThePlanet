// Logique pure de l'état opérateur (PHASE 01). Aucune E/S : importable
// aussi bien par le plugin de dev que par le selftest.
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 3;

export function slugify(s) {
	return String(s ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function newId(name) {
	const base = slugify(name);
	if (!base) throw new Error('nom inutilisable');
	return `${base}-${randomBytes(2).toString('hex')}`;
}

export function validateName(raw) {
	const name = String(raw ?? '').trim();
	if (!name) throw new Error('NAME REQUIRED');
	if (name.length > 24) throw new Error('NAME TOO LONG');
	if (!slugify(name)) throw new Error('NAME UNUSABLE');
	return name;
}

export function freshState({ id, name }) {
	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		name,
		createdAt: new Date().toISOString(),
		settings: {},
		terrainCache: [],
		sessions: [],
		// Numéros d'affichage (PHASE 17, spec D2). Deux compteurs et non un : le
		// footer les compte séparément, et une session ouverte sans TARGET SCAN
		// (chemin dev `?scene=`) ne doit pas consommer un numéro de cible.
		// Attribués une fois, jamais recyclés — supprimer une session laisse un
		// trou, et c'est voulu.
		sessionSeq: 0,
		targetSeq: 0,
		worldState: {},
	};
}

// Attribue les numéros manquants dans l'ordre du tableau et rend les compteurs
// au maximum atteint. Idempotent : un état déjà numéroté ressort identique.
function backfillSeq(sessions) {
	let sessionSeq = 0;
	let targetSeq = 0;
	const out = (sessions ?? []).map((s) => {
		const seq = Number.isInteger(s.seq) && s.seq > 0 ? s.seq : sessionSeq + 1;
		sessionSeq = Math.max(sessionSeq, seq);
		if (!s.target) {
			// Une session sans cible ne porte pas de targetSeq du tout.
			const { targetSeq: _drop, ...rest } = s;
			return { ...rest, seq };
		}
		const ts = Number.isInteger(s.targetSeq) && s.targetSeq > 0 ? s.targetSeq : targetSeq + 1;
		targetSeq = Math.max(targetSeq, ts);
		return { ...s, seq, targetSeq: ts };
	});
	return { sessions: out, sessionSeq, targetSeq };
}

export function migrate(state) {
	if (!state || typeof state !== 'object') throw new Error('état opérateur illisible');
	const v = state?.schemaVersion ?? 0;
	if (v > SCHEMA_VERSION) throw new Error('schemaVersion trop récent');
	// v absent / 0 / 1 / 2 : on normalise vers la forme courante sans rien perdre.
	const base = freshState({ id: state.id, name: state.name });
	const merged = {
		...base,
		...state,
		schemaVersion: SCHEMA_VERSION,
		createdAt: state.createdAt ?? base.createdAt,
	};
	// v1 → v2 : `targetLog` n'a jamais été écrit (toujours vide) et le Target Log
	// est désormais dérivé des sessions (spec D1). On retire la clé morte plutôt
	// que de la traîner.
	delete merged.targetLog;
	// v2 → v3 : le CONTROL VECTOR a été retiré du jeu (#33). Même geste que
	// ci-dessus — on retire la clé morte plutôt que de la traîner, sans quoi le
	// spread `...state` la réinjecterait dans tout état déjà écrit sur disque.
	delete merged.controlVector;
	const filled = backfillSeq(merged.sessions);
	merged.sessions = filled.sessions;
	merged.sessionSeq = Math.max(filled.sessionSeq, merged.sessionSeq ?? 0);
	merged.targetSeq = Math.max(filled.targetSeq, merged.targetSeq ?? 0);
	return merged;
}
