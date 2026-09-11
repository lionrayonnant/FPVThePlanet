// The dev-only query flags of src/main.js that carry a RULE rather than a
// value (issue #29). They live here, pure and importable, for one reason: a
// rule that only exists inside main.js is a rule nobody can test, and the
// swarm flag has already shipped two silent defects — `?swarm=0` giving a
// swarm of six, and `?swarm=<n>` giving something other than `n`.
//
// The principle these two share: a dev flag REFUSES what it cannot honour. It
// never quietly produces something the caller did not ask for. Loudly wrong at
// load time beats subtly wrong for an hour.
import { SWARM_SIZE_MIN, SWARM_SIZE_MAX, SWARM_FAMILY } from './target-model.mjs';
import { DOCTRINE_NAMES, doctrineFor } from '../src/swarm.js';

// A seed search that never finds a match would spin forever instead of
// refusing loudly — the one thing this whole file exists to prevent. It
// can't happen in practice (doctrineFor() draws uniformly over 4 names, so
// the expected hit count is 4), but the cap turns a hang into a thrown error.
const DOCTRINE_SEED_SEARCH_LIMIT = 10000;

// `?swarm=<n>` or `?swarm=<n>:<doctrine>` — the swarm descriptor a dev scan
// carries, or null when the flag is absent. Same shape as the one
// resolveTarget() persists, so whatever reads it does not care where the
// scan came from.
//
// `raw` is the raw query value (`params.get('swarm')`), or null/undefined when
// the parameter is absent. Anything that is not an integer in 6..12 throws:
// the game itself can only ever draw a swarm in that range, so a dev path that
// silently clamped would be showing a swarm the game cannot produce.
//
// The optional `:<doctrine>` suffix picks the formation explicitly instead of
// leaving it to the size-derived seed — over the useful 6..12 range that seed
// draws `cloud` six times out of seven and never draws `wedge` or `screen`,
// so without this a dev could not look at two of the four doctrines at all.
// The name is checked against DOCTRINE_NAMES (imported from src/swarm.js, the
// single place the doctrine table lives) rather than a copy kept here, and an
// unknown name refuses with the valid list rather than falling back to the
// size-derived draw.
export function parseSwarmFlag(raw) {
	if (raw === null || raw === undefined) return null;
	const [sizeRaw, doctrineRaw] = String(raw).split(':');
	const n = Number(sizeRaw);
	if (!Number.isInteger(n) || n < SWARM_SIZE_MIN || n > SWARM_SIZE_MAX) {
		throw new Error(`?swarm= attend un entier de ${SWARM_SIZE_MIN} à ${SWARM_SIZE_MAX} — reçu "${raw}"`);
	}
	if (doctrineRaw === undefined) {
		return { size: n, doctrineSeed: `dev::swarm::${n}` };
	}
	if (!DOCTRINE_NAMES.includes(doctrineRaw)) {
		throw new Error(`?swarm=${n}:<doctrine> attend une doctrine parmi ${DOCTRINE_NAMES.join(', ')} — reçu "${doctrineRaw}"`);
	}
	// doctrineFor() derives the doctrine from the seed alone (src/swarm.js);
	// there is no direct setter. So the seed is searched, not built: try
	// candidate seeds until one happens to draw the requested doctrine. This
	// stays deterministic (same n + doctrine -> same seed, every run) and
	// needs no change to src/swarm.js.
	for (let i = 0; i < DOCTRINE_SEED_SEARCH_LIMIT; i++) {
		const seed = `dev::swarm::${n}::${doctrineRaw}::${i}`;
		if (doctrineFor(seed) === doctrineRaw) return { size: n, doctrineSeed: seed };
	}
	throw new Error(`?swarm=${n}:${doctrineRaw} — no seed matched "${doctrineRaw}" in ${DOCTRINE_SEED_SEARCH_LIMIT} tries (this should never happen)`);
}

// `?scene=<slug>` — the scene a dev flies straight into, skipping the menu, or
// null when the flag is absent. A slug is `[a-z0-9-]+` and nothing else: the
// same rule the server enforces on `/scenes/<slug>/` and on
// `DELETE /__map-api/scenes/:slug`. Refusing here, at load time, means the
// raw value never reaches a message, a fetch URL or the DOM — the boot
// failure path used to echo it into the loading screen with innerHTML, so a
// crafted link ran markup in the app origin for any returning player.
export const SCENE_SLUG_RE = /^[a-z0-9-]+$/;
export function parseSceneFlag(raw) {
	if (raw === null || raw === undefined || raw === '') return null;
	if (!SCENE_SLUG_RE.test(raw)) {
		throw new Error('?scene= attend un slug de carte (minuscules, chiffres, tirets) — reçu une valeur invalide');
	}
	return raw;
}

// `?family=<f>` — the families a DEV may fly. FAMILIES plus the swarm node,
// and the node only here: it stays out of FAMILIES and TARGET_FAMILIES so a
// real game can only ever reach it by hacking a cluster. Without this list
// there is no way at all to fly the node, not even to look at it.
export function devFamilies(families) {
	return [...families, SWARM_FAMILY];
}
