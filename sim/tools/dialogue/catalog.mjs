// Catalogue du moteur de dialogue (PHASE 21, Bible §9-10). SOURCE DE VÉRITÉ :
// les ids d'événements, les cadences, les poids de silence, la table des slots.
// Aucun état, aucune E/S, aucun DOM. Ajouter un événement ici suffit à le rendre
// utilisable — c'est le critère d'acceptation 10 de l'issue #58.

export const CREW = ['root', 'jensen', 'mikhail', 'cron'];

// Poids de tirage. Valeurs verbatim de la spec — le selftest les fige.
export const RARITY = { COMMON: 100, UNCOMMON: 30, RARE: 8, VERY_RARE: 2 };

// jensen ne peut pas parler plus d'une fois toutes les 12 répliques (D5) : son
// mystère vient de sa rareté, et la rareté ne se garantit pas par un prompt.
export const JENSEN_COOLDOWN = 12;

// Exclusion dure sur les 256 derniers ids ; pénalité douce sur les 512 derniers
// (une entrée déjà vue mais ancienne redevient possible, jamais prioritaire).
export const MEMORY_RING = 256;
export const MEMORY_SEEN = 512;

// `gapMs` : écart entre deux échanges. `beatMs` : battement entre deux répliques
// d'un même échange — c'est ce qui fait « quelqu'un qui tape » plutôt qu'un collage.
const acq = { gapMs: [7000, 16000], beatMs: [800, 1900] };
const quick = { gapMs: [4000, 9000], beatMs: [600, 1400] };

export const EVENTS = {
	// --- câblés en v1 -------------------------------------------------------
	AREA_SEARCH:      { shard: 'area_search',      silenceWeight: 60, ...quick },
	PROBE_AREA:       { shard: 'probe_area',       silenceWeight: 45, ...quick },
	ACQUIRE_AREA:     { shard: 'acquire_area',     silenceWeight: 30, ...acq },
	TERRAIN_PROGRESS: { shard: 'terrain_progress', silenceWeight: 35, ...acq },
	TARGET_SCAN:      { shard: 'target_scan',      silenceWeight: 40, ...quick },
	TARGET_SELECTED:  { shard: 'target_selected',  silenceWeight: 35, ...quick },
	TARGET_ANALYSIS:  { shard: 'target_analysis',  silenceWeight: 40, ...quick },
	HACK:             { shard: 'hack',             silenceWeight: 45, ...quick },
	MANUAL_OVERRIDE:  { shard: 'manual_override',  silenceWeight: 55, ...quick },
	JACK_IN:          { shard: 'jack_in',          silenceWeight: 60, ...quick },
	WEATHER:          { shard: 'weather',          silenceWeight: 40, ...quick },
	// --- déclarés, sans point d'appel en v1 (critère 10) ---------------------
	BOOTSTRAP:        { shard: 'bootstrap',        silenceWeight: 50, ...quick },
	SYSTEM:           { shard: 'system',           silenceWeight: 70, ...quick },
	FLIGHT:           { shard: 'flight',           silenceWeight: 85, ...quick },
	LINK_DEGRADED:    { shard: 'link_degraded',    silenceWeight: 60, ...quick },
	LINK_RESTORED:    { shard: 'link_restored',    silenceWeight: 60, ...quick },
	CRASH:            { shard: 'crash',            silenceWeight: 35, ...quick },
	SESSION_COMPLETE: { shard: 'session_complete', silenceWeight: 30, ...quick },
	REVISIT:          { shard: 'revisit',          silenceWeight: 45, ...quick },
};

const upper = (v) => String(v).toUpperCase();
const asIs = (v) => String(v);
const round0 = (v) => String(Math.round(v));

// Chaque slot dit DE QUOI il dépend (`path`) et COMMENT il s'affiche (`format`).
// C'est ce couplage qui rend un placeholder cassé impossible : validate.mjs
// exige que le chemin de tout slot utilisé figure dans le `requires` de l'entrée.
export const SLOTS = {
	location:         { path: 'area.name',          format: upper },
	operator_name:    { path: 'operator.name',      format: upper },
	weather_summary:  { path: 'weather.summary',    format: asIs },
	wind:             { path: 'weather.windMs',     format: round0 },
	rain:             { path: 'weather.rain',       format: asIs },
	visibility:       { path: 'weather.visibility', format: asIs },
	drone_type:       { path: 'drone.label',        format: (v) => String(v).toLowerCase() },
	video_type:       { path: 'target.video',       format: upper },
	signal:           { path: 'target.rssiDbm',     format: (v) => `${Math.round(v)} dBm` },
	hack_type:        { path: 'target.hackType',    format: upper },
	target_count:     { path: 'scan.count',         format: round0 },
	terrain_size:     { path: 'terrain.tiles',      format: round0 },
	terrain_mb:       { path: 'terrain.megabytes',  format: (v) => `${Math.round(v)} MB` },
	session_duration: { path: 'session.durationS',  format: (v) => `${Math.round(v / 60)} min` },
	gpu:              { path: 'machine.gpu',        format: asIs },
	display:          { path: 'machine.display',    format: asIs },
};

// Un chemin absent, nul, NaN ou vide vaut null : c'est ce que teste l'éligibilité.
// Un contexte pauvre rétrécit le bassin de candidats, il ne casse jamais un rendu.
export function resolvePath(ctx, path) {
	let v = ctx;
	for (const key of String(path).split('.')) {
		if (v == null || typeof v !== 'object') return null;
		v = v[key];
	}
	if (v == null) return null;
	if (typeof v === 'number' && !Number.isFinite(v)) return null;
	if (typeof v === 'string' && v.trim() === '') return null;
	return v;
}

const SLOT_RE = /\{([a-z_]+)\}/g;

export function slotsUsed(entry) {
	const found = new Set();
	for (const line of entry?.lines ?? []) {
		for (const m of String(line.text ?? '').matchAll(SLOT_RE)) found.add(m[1]);
	}
	return [...found];
}

export function pathsForSlots(names) {
	return [...new Set(names.map((n) => SLOTS[n]?.path).filter(Boolean))];
}
