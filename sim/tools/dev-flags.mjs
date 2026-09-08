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

// `?swarm=<n>` — the swarm descriptor a dev scan carries, or null when the
// flag is absent. Same shape as the one resolveTarget() persists, so whatever
// reads it does not care where the scan came from.
//
// `raw` is the raw query value (`params.get('swarm')`), or null/undefined when
// the parameter is absent. Anything that is not an integer in 6..12 throws:
// the game itself can only ever draw a swarm in that range, so a dev path that
// silently clamped would be showing a swarm the game cannot produce.
export function parseSwarmFlag(raw) {
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < SWARM_SIZE_MIN || n > SWARM_SIZE_MAX) {
		throw new Error(`?swarm= attend un entier de ${SWARM_SIZE_MIN} à ${SWARM_SIZE_MAX} — reçu "${raw}"`);
	}
	return { size: n, doctrineSeed: `dev::swarm::${n}` };
}

// `?family=<f>` — the families a DEV may fly. FAMILIES plus the swarm node,
// and the node only here: it stays out of FAMILIES and TARGET_FAMILIES so a
// real game can only ever reach it by hacking a cluster. Without this list
// there is no way at all to fly the node, not even to look at it.
export function devFamilies(families) {
	return [...families, SWARM_FAMILY];
}
