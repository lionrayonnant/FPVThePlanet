// Candidate signals for a TARGET SCAN (PHASE 08). Pure logic, NO dependency:
// imported by the dev plugin, the selftest and (via a Vite bundle) the
// client. The server regenerates the same output from the same seed, which is
// what makes the player's choice non-falsifiable.
//
//   terrain persistent, flights ephemeral — a target belongs to a session.

// FAMILY_CLASS: stable data, duplicated here to keep the model dependency-
// free. The selftest checks that its keys match src/drone-profiles.js. The
// value is the coarse bucket shown as EST. before the hack — never the exact
// family.
export const FAMILY_CLASS = {
	freestyle5: '5"',
	race5: '5"',
	cinewhoop: 'CINEWHOOP',
	longrange: 'LONG RANGE',
	heavy5: '5"',
	toothpick: 'MICRO',
};
export const TARGET_FAMILIES = Object.keys(FAMILY_CLASS);

// HACK_TYPES: the six hacking families (PHASE 09, Bible §17). Stable order.
// The hack type is a property of the target, drawn at generation; it does NOT
// determine flight difficulty (entry state is independent, PHASE 11).
// Concepts are documented and credible; the interaction itself is an
// abstraction (spec PHASE 09, safety rule).
export const HACK_TYPES = [
	'COMMAND INJECTION',
	'LINK HIJACK',
	'TELEMETRY SPOOF',
	'GNSS SPOOF',
	'NETWORK TAKEOVER',
	'FIRMWARE OVERRIDE',
];

// SWARM (issue #29). The rarest thing a scan can produce: a cluster — one
// command node surrounded by its units. It is drawn on a SEPARATE rng stream,
// after the candidate loop, and never touches `rand`: the scan is regenerated
// three times (client, server at hack time, ambients), so at swarmChance = 0
// the candidates must stay byte-for-byte what they were before swarms existed.
export const SWARM_CHANCE = 0.10;
// Inclusive bounds of the unit count. The player never learns it before the hack.
export const SWARM_SIZE_MIN = 6;
export const SWARM_SIZE_MAX = 12;
// `swarmNode` is deliberately absent from TARGET_FAMILIES/FAMILY_CLASS: it must
// stay unreachable by an ordinary draw, otherwise the rarity disappears and an
// ambient could be one. The cluster therefore carries its bucket hard-coded
// here rather than through FAMILY_CLASS. 'MESH' is the honest bucket — several
// emitters — and it reveals neither the machine nor the size.
export const SWARM_FAMILY = 'swarmNode';
export const SWARM_CLASS_HINT = 'MESH';
// Already in HACK_TYPES; its ritual grammar is `gridSwarm` (src/hack-grammars.js).
export const SWARM_HACK_TYPE = 'NETWORK TAKEOVER';

const MODES = ['ANALOG', 'DIGITAL'];
const clampCount = (n) => {
	const r = Math.round(Number.isFinite(n) ? n : 4);
	return r < 2 ? 2 : r > 5 ? 5 : r;
};

// FNV-1a hash of a string → a 32-bit seed, then xorshift (same generator as
// src/link.js: small, deterministic, replayable).
function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

const clampChance = (v) => {
	const x = Number(v);
	if (!Number.isFinite(x) || x < 0 || x > 1) throw new RangeError(`swarmChance outside [0,1]: ${v}`);
	return x;
};

// `undefined` means "not provided, draw it"; `null` means "provided, and there
// is no cluster" — a v2 session replayed must stay swarmless.
const normalizeSwarmAt = (at, n) => {
	if (at === null) return null;
	if (!Number.isInteger(at) || at < 0 || at >= n) throw new RangeError(`swarmAt out of range: ${at}`);
	return at;
};

// The draw pool for the ordinary family loop (issue #185, clearance). `families`
// must be a non-empty subset of TARGET_FAMILIES; anything else (absent, empty,
// containing an unknown key) falls back to the full pool. A client and a
// server that both validate this way never diverge on a malformed value —
// they diverge only on a genuinely different clearance, which is the point.
const validFamilies = (families) => (
	Array.isArray(families) && families.length > 0 && families.every((f) => TARGET_FAMILIES.includes(f))
		? families
		: TARGET_FAMILIES
);

// `swarmChance` is the probability that this scan carries a cluster; `swarmAt`
// short-circuits the draw entirely (an index, or `null` for "no cluster"). A
// session persists both, which is what makes the ambient regeneration exact.
// `families` (issue #185) is the operator's clearance pool: same seed + same
// families → same scan, so client and server must agree on the SAME pool for
// a given flight.
export function generateTargetScan({ seed, count, swarmChance = SWARM_CHANCE, swarmAt, families } = {}) {
	if (!seed) throw new Error('seed required');
	const n = clampCount(count);
	const rand = rngFrom(`${seed}::scan`);
	const pool = validFamilies(families);

	const raw = [];
	for (let i = 0; i < n; i++) {
		const family = pick(rand, pool);
		const videoHint = pick(rand, MODES);
		// -52..-72 dBm: an exploitable signal, never perfect (§6). Sorting
		// happens afterwards, the draw order does not matter.
		const rssiDbm = -52 - Math.round(rand() * 20);
		// ~50% of signals reveal their mode, the rest stay UNKNOWN.
		const mode = rand() < 0.5 ? videoHint : 'UNKNOWN';
		// A dedicated draw, after `mode`, so as not to shift the RSSI/mode
		// draws of a seed already in use. Independent of family and signal.
		const hackType = pick(rand, HACK_TYPES);
		raw.push({ rssiDbm, mode, _family: family, _classHint: FAMILY_CLASS[family], _videoHint: videoHint, _hackType: hackType });
	}
	raw.sort((a, b) => b.rssiDbm - a.rssiDbm);
	const candidates = raw.map((c, i) => ({ id: String(i + 1).padStart(2, '0'), ...c }));

	// The swarm draw, on its own stream. The three values are ALWAYS consumed,
	// cluster or not: a scan replayed with an explicit `swarmAt` must yield the
	// same size and the same doctrine as the scan that drew it.
	const swarmRand = rngFrom(`${seed}::swarm`);
	const roll = swarmRand();
	const size = SWARM_SIZE_MIN + Math.floor(swarmRand() * (SWARM_SIZE_MAX - SWARM_SIZE_MIN + 1));
	const doctrineSeed = `${seed}::swarm::${Math.floor(swarmRand() * 0x100000000).toString(16)}`;
	const chance = clampChance(swarmChance);
	// A cluster is always the strongest signal of the scan, so index 0 after the
	// sort: it changes THAT candidate only, never the order, never the others.
	const at = swarmAt === undefined ? (roll < chance ? 0 : null) : normalizeSwarmAt(swarmAt, n);
	if (at !== null) {
		const c = candidates[at];
		c._family = SWARM_FAMILY;
		c._classHint = SWARM_CLASS_HINT;
		c._hackType = SWARM_HACK_TYPE;
		c._swarm = { size, doctrineSeed };
	}

	return { seed, count: n, candidates, swarmAt: at, swarmChance: chance, families: pool };
}

// The early guarantee: a player must meet a cluster reasonably soon, or the
// rarest event of the game is one most players never see. If the first two
// scans carried none, the third is certain. Computed from the operator state
// the client already holds, and transmitted with the hack request so the
// server regenerates the very same scan.
export function swarmChanceFor(sessions) {
	const scanned = (sessions ?? []).filter((s) => s && s.target);
	if (scanned.length !== 2) return SWARM_CHANCE;
	return scanned.some((s) => s.target.swarm) ? SWARM_CHANCE : 1;
}

// Pre-hack sheet (Bible §15/§22). NEVER CONTAINS _family: only what is really
// known before the flight is shown.
//
// Three levels and nothing else (issue #45): KNOWN really measured, EST.
// deduced, UNKNOWN a genuine unknown. An EST. is only legitimate if it DEDUCES
// without giving away the answer — that is the case of deviceHint, a coarse
// bucket ('5"' covers three families) that narrows the field without closing
// it.
//
// The video mode has NO possible EST.: it is binary. An "EST. DIGITAL" is
// always just the value, whatever word precedes it — the three levels would
// then collapse to two and reveal, before the flight, what the player is
// meant to discover at the first frame. When it is not measured it is
// therefore UNKNOWN, bare, as in the Bible's example sheet. The real mode
// arrives through resolveTarget() and is discovered when the video feed comes
// up.
//
// A cluster (issue #29) cannot be invisible on the sheet, or the rarity only
// exists after the fact and the player's choice is not one. It says GROUP, and
// nothing more: never the family, never the size. `count` only exists on a
// cluster's sheet — an ordinary target has no group to count.
export function describeTarget(candidate) {
	const known = candidate.mode !== 'UNKNOWN';
	const swarm = !!candidate._swarm;
	return {
		location: 'KNOWN',
		signal: swarm ? `${candidate.rssiDbm} dBm (STRONGEST OF GROUP)` : `${candidate.rssiDbm} dBm`,
		device: 'PARTIAL',
		// EST. — the bucket, not the family. 'MESH — MULTIPLE EMITTERS' for a
		// cluster: it tightens the field without closing it, like any other bucket.
		deviceHint: swarm ? `${SWARM_CLASS_HINT} — MULTIPLE EMITTERS` : candidate._classHint,
		video: known ? candidate.mode : 'UNKNOWN',
		control: 'UNKNOWN',
		flightState: 'UNKNOWN',
		...(swarm ? { count: 'UNKNOWN' } : {}),
	};
}

// The list row (issue #49). The pre-hack sheet used to be a whole screen; of
// its seven fields, four were the same constants for every target (LOCATION
// KNOWN, DEVICE PARTIAL, CONTROL UNKNOWN, FLIGHT STATE UNKNOWN) and so never
// distinguished two signals, and CONDITIONS is already at the top of the
// list. What informs the choice fits on one line: id, signal, video mode,
// device.
//
// Built from describeTarget() and not from the raw candidate: that is what
// makes the row inherit its guarantee — never _family, never _hackType, never
// the real video mode of an unmeasured signal.
//
// Takes ALL the candidates rather than one, because column alignment is a
// property of the whole set: a cluster's row is much longer than the others,
// and without this pass it would shift everything after it.
const COL_GAP = '   ';

export function scanLines(candidates) {
	const cells = candidates.map((c) => {
		const d = describeTarget(c);
		return [
			c.id,
			d.signal,
			d.video,
			// COUNT only exists on a cluster — an ordinary target has no group
			// to count, and the word alone would be enough to give one away.
			d.count ? `${d.deviceHint}, COUNT ${d.count}` : d.deviceHint,
		];
	});
	// The last column is never padded: nothing follows it, and padding it
	// would leave a trail of spaces at the end of every row.
	const widths = cells[0]?.slice(0, -1).map((_, i) => Math.max(...cells.map((r) => r[i].length))) ?? [];
	return cells.map((row) => row
		.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]) : cell))
		.join(COL_GAP));
}

// The descriptor persisted on the session. The server obtains it by
// regenerating the scan and then calling this — the client only ever sends
// an index.
export function resolveTarget(scan, index) {
	const c = scan.candidates[index];
	if (!c) throw new RangeError(`target index out of range: ${index}`);
	return {
		family: c._family,
		classHint: c._classHint,
		hackType: c._hackType,
		// The swarm the node commands (issue #29). `null` on every ordinary
		// target — most of them.
		swarm: c._swarm ? { size: c._swarm.size, doctrineSeed: c._swarm.doctrineSeed } : null,
		// The INDIVIDUAL's seed (PHASE 07, tools/target-build.mjs). Derived
		// from the scan and the index, so it is reproducible by the server as
		// well as the client, and read back as-is from disk: the drone
		// hijacked yesterday is the same one today. Distinct from the session
		// id, which does not exist yet when the FlightController has to be
		// built.
		buildSeed: `${scan.seed}::${index}`,
		// The scan itself (issue #250): what is needed to REGENERATE the
		// candidates not taken — the ambient drones — and to rebuild
		// buildSeed client-side without storing it twice.
		// `swarmAt`/`swarmChance` travel with the scan (issue #29): they are what
		// makes the ambient regeneration exact — without them a replay would
		// redraw the cluster on today's default chance instead of the session's.
		// `families` (issue #185) does the same job for the clearance pool: an
		// ambient regeneration must draw from the SAME pool as the flight did,
		// not from whatever clearance the operator holds today.
		scan: {
			seed: String(scan.seed), count: scan.candidates.length, index,
			swarmAt: scan.swarmAt ?? null,
			swarmChance: Number.isFinite(scan.swarmChance) ? scan.swarmChance : SWARM_CHANCE,
			families: validFamilies(scan.families),
		},
		signal: { rssiDbm: c.rssiDbm, mode: c._videoHint },
		scannedAt: new Date().toISOString(),
		// What the player knew AT THE MOMENT OF CHOOSING, not what is true:
		// the archive reads this block back to say what the sheet was worth
		// before the flight. `video` therefore follows the sheet — measured or
		// not — instead of being fixed.
		intel: {
			location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL',
			video: c.mode === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
			control: 'UNKNOWN', flightState: 'UNKNOWN',
		},
	};
}
