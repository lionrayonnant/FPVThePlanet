// Logique pure de l'état opérateur (PHASE 01). Aucune E/S : importable
// aussi bien par le plugin de dev que par le selftest.
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;

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

const DIRS = new Set(['up', 'right', 'down', 'left']);

export function validateControlVector(v) {
	if (!Array.isArray(v) || v.length < 4 || v.length > 8 || !v.every((d) => DIRS.has(d))) {
		throw new Error('control vector invalide');
	}
	return v.slice();
}

export function freshState({ id, name }) {
	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		name,
		createdAt: new Date().toISOString(),
		controlVector: [],
		settings: {},
		terrainCache: [],
		sessions: [],
		targetLog: [],
		worldState: {},
	};
}

export function migrate(state) {
	if (!state || typeof state !== 'object') throw new Error('état opérateur illisible');
	const v = state?.schemaVersion ?? 0;
	if (v > SCHEMA_VERSION) throw new Error('schemaVersion trop récent');
	// v absent / 0 / 1 : on normalise vers la forme courante sans rien perdre.
	const base = freshState({ id: state.id, name: state.name });
	return {
		...base,
		...state,
		schemaVersion: SCHEMA_VERSION,
		createdAt: state.createdAt ?? base.createdAt,
	};
}
