import {
	generateTargetScan, describeTarget, scanLines, resolveTarget, swarmChanceFor,
	FAMILY_CLASS, TARGET_FAMILIES, HACK_TYPES,
	SWARM_CHANCE, SWARM_FAMILY, SWARM_CLASS_HINT, SWARM_HACK_TYPE,
	SWARM_SIZE_MIN, SWARM_SIZE_MAX,
} from './target-model.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`); }
	else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- determinism
{
	const a = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	const b = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	check('same seed -> same candidates', JSON.stringify(a) === JSON.stringify(b));
	const c = generateTargetScan({ seed: 'kyiv-podil-0000', count: 4 });
	check('different seed -> different candidates', JSON.stringify(a) !== JSON.stringify(c));
}

// --- count clamped and sorted
{
	check('default count = 4', generateTargetScan({ seed: 'x' }).candidates.length === 4);
	check('count clamped low', generateTargetScan({ seed: 'x', count: 0 }).candidates.length === 2);
	check('count clamped high', generateTargetScan({ seed: 'x', count: 99 }).candidates.length === 5);
	const s = generateTargetScan({ seed: 'sorted-check', count: 5 });
	const sorted = s.candidates.every((c, i) => i === 0 || s.candidates[i - 1].rssiDbm >= c.rssiDbm);
	check('candidates sorted RSSI descending', sorted);
	check('sequential ids', s.candidates.map((c) => c.id).join(',') === '01,02,03,04,05');
	check('rssi within a plausible range',
		s.candidates.every((c) => c.rssiDbm <= -45 && c.rssiDbm >= -80));
}

// --- describeTarget never leaks the family
{
	for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
		const scan = generateTargetScan({ seed, count: 5 });
		for (const cand of scan.candidates) {
			const sheet = JSON.stringify(describeTarget(cand));
			check(`describeTarget(${seed}/${cand.id}) without _family`,
				!sheet.includes(cand._family), sheet.includes(cand._family) ? sheet : '');
			// The sheet reflects the measured mode, and UNKNOWN stays UNKNOWN:
			// no intermediate state that would let the answer through.
			check(`describeTarget(${seed}/${cand.id}) coherent video`,
				JSON.parse(sheet).video === cand.mode);
			// And above all: when the mode is not measured, the REAL mode must
			// not appear anywhere on the sheet. An "EST." that is always just
			// the value on a binary field IS the value (issue #45: UNKNOWN
			// must be a genuine unknown).
			if (cand.mode === 'UNKNOWN') {
				check(`describeTarget(${seed}/${cand.id}) does not leak the real video mode`,
					!sheet.includes(cand._videoHint), sheet);
			}
		}
	}
}

// --- resolveTarget
{
	const scan = generateTargetScan({ seed: 'resolve', count: 4 });
	const t = resolveTarget(scan, 1);
	check('resolveTarget: known family', TARGET_FAMILIES.includes(t.family));
	check('resolveTarget: real mode', ['ANALOG', 'DIGITAL'].includes(t.signal.mode));
	check('resolveTarget: rssi carried over', t.signal.rssiDbm === scan.candidates[1].rssiDbm);
	check('resolveTarget: intel frozen', t.intel.control === 'UNKNOWN' && t.intel.location === 'KNOWN');
	let threw = false;
	try { resolveTarget(scan, 9); } catch { threw = true; }
	check('resolveTarget: index out of range -> throw', threw);
}

{
	const scan = generateTargetScan({ seed: 'scan-kept', count: 4 });
	const t = resolveTarget(scan, 2);
	check('resolveTarget carries scan.seed', t.scan?.seed === 'scan-kept');
	check('resolveTarget carries scan.count', t.scan?.count === 4);
	check('resolveTarget carries scan.index', t.scan?.index === 2);
	check('buildSeed derives from scan', t.buildSeed === `${t.scan.seed}::${t.scan.index}`);
}

// --- hackType: a property of the target (PHASE 09)
{
	check('HACK_TYPES: 6 families, Bible §17 order',
		HACK_TYPES.join('|') === 'COMMAND INJECTION|LINK HIJACK|TELEMETRY SPOOF|GNSS SPOOF|NETWORK TAKEOVER|FIRMWARE OVERRIDE');

	const a = generateTargetScan({ seed: 'hack-det', count: 5 });
	const b = generateTargetScan({ seed: 'hack-det', count: 5 });
	check('_hackType deterministic by seed',
		a.candidates.map((c) => c._hackType).join(',') === b.candidates.map((c) => c._hackType).join(','));
	check('_hackType always in HACK_TYPES',
		a.candidates.every((c) => HACK_TYPES.includes(c._hackType)));

	// describeTarget never leaks the hackType
	for (const cand of a.candidates) {
		check(`describeTarget(${cand.id}) without _hackType`,
			!JSON.stringify(describeTarget(cand)).includes(cand._hackType));
	}

	// resolveTarget carries the chosen candidate's hackType
	const t = resolveTarget(a, 2);
	check('resolveTarget: hackType carried from the candidate',
		t.hackType === a.candidates[2]._hackType && HACK_TYPES.includes(t.hackType));

	// family x hackType independence: over 250 seeds, every hackType appears
	// with at least 4 distinct families (no strong coupling)
	const pairs = new Map(HACK_TYPES.map((h) => [h, new Set()]));
	// distribution: every hackType between 8% and 25% of the draws
	const counts = new Map(HACK_TYPES.map((h) => [h, 0]));
	let total = 0;
	for (let i = 0; i < 250; i++) {
		for (const c of generateTargetScan({ seed: `dist-${i}`, count: 5 }).candidates) {
			pairs.get(c._hackType).add(c._family);
			counts.set(c._hackType, counts.get(c._hackType) + 1);
			total++;
		}
	}
	check('hackType x family: no strong coupling',
		[...pairs.values()].every((set) => set.size >= 4),
		[...pairs.entries()].map(([h, s]) => `${h}:${s.size}`).join(' '));
	check('hackType: ~uniform distribution (8-25%)',
		[...counts.values()].every((n) => n / total >= 0.08 && n / total <= 0.25),
		[...counts.values()].map((n) => (100 * n / total).toFixed(0)).join(' '));
}

// --- the swarm (issue #29)

// Witness seeds, frozen BEFORE the swarm existed: this is the non-regression
// that matters most. The cluster's draw lives on a separate stream (`::swarm`)
// and must never consume the candidate loop's — at swarmChance = 0 the output
// must stay identical, seed by seed.
const WITNESS = [
	["kyiv-podil-9f2a",4,"[{\"id\":\"01\",\"rssiDbm\":-57,\"mode\":\"ANALOG\",\"_family\":\"longrange\",\"_classHint\":\"LONG RANGE\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"LINK HIJACK\"},{\"id\":\"02\",\"rssiDbm\":-62,\"mode\":\"UNKNOWN\",\"_family\":\"heavy5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"03\",\"rssiDbm\":-64,\"mode\":\"UNKNOWN\",\"_family\":\"cinewhoop\",\"_classHint\":\"CINEWHOOP\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"04\",\"rssiDbm\":-67,\"mode\":\"ANALOG\",\"_family\":\"toothpick\",\"_classHint\":\"MICRO\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"NETWORK TAKEOVER\"}]"],
	["witness-01",5,"[{\"id\":\"01\",\"rssiDbm\":-56,\"mode\":\"DIGITAL\",\"_family\":\"longrange\",\"_classHint\":\"LONG RANGE\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"GNSS SPOOF\"},{\"id\":\"02\",\"rssiDbm\":-62,\"mode\":\"DIGITAL\",\"_family\":\"cinewhoop\",\"_classHint\":\"CINEWHOOP\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"03\",\"rssiDbm\":-65,\"mode\":\"DIGITAL\",\"_family\":\"cinewhoop\",\"_classHint\":\"CINEWHOOP\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"TELEMETRY SPOOF\"},{\"id\":\"04\",\"rssiDbm\":-68,\"mode\":\"UNKNOWN\",\"_family\":\"freestyle5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"NETWORK TAKEOVER\"},{\"id\":\"05\",\"rssiDbm\":-72,\"mode\":\"UNKNOWN\",\"_family\":\"freestyle5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"FIRMWARE OVERRIDE\"}]"],
	["witness-02",2,"[{\"id\":\"01\",\"rssiDbm\":-53,\"mode\":\"UNKNOWN\",\"_family\":\"race5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"GNSS SPOOF\"},{\"id\":\"02\",\"rssiDbm\":-71,\"mode\":\"UNKNOWN\",\"_family\":\"freestyle5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"}]"],
	["a3f9c1",3,"[{\"id\":\"01\",\"rssiDbm\":-53,\"mode\":\"DIGITAL\",\"_family\":\"cinewhoop\",\"_classHint\":\"CINEWHOOP\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"02\",\"rssiDbm\":-62,\"mode\":\"DIGITAL\",\"_family\":\"race5\",\"_classHint\":\"5\\\"\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"03\",\"rssiDbm\":-72,\"mode\":\"ANALOG\",\"_family\":\"longrange\",\"_classHint\":\"LONG RANGE\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"GNSS SPOOF\"}]"],
	["sorted-check",5,"[{\"id\":\"01\",\"rssiDbm\":-59,\"mode\":\"UNKNOWN\",\"_family\":\"longrange\",\"_classHint\":\"LONG RANGE\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"COMMAND INJECTION\"},{\"id\":\"02\",\"rssiDbm\":-61,\"mode\":\"UNKNOWN\",\"_family\":\"toothpick\",\"_classHint\":\"MICRO\",\"_videoHint\":\"ANALOG\",\"_hackType\":\"TELEMETRY SPOOF\"},{\"id\":\"03\",\"rssiDbm\":-65,\"mode\":\"DIGITAL\",\"_family\":\"toothpick\",\"_classHint\":\"MICRO\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"TELEMETRY SPOOF\"},{\"id\":\"04\",\"rssiDbm\":-65,\"mode\":\"DIGITAL\",\"_family\":\"longrange\",\"_classHint\":\"LONG RANGE\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"NETWORK TAKEOVER\"},{\"id\":\"05\",\"rssiDbm\":-70,\"mode\":\"DIGITAL\",\"_family\":\"cinewhoop\",\"_classHint\":\"CINEWHOOP\",\"_videoHint\":\"DIGITAL\",\"_hackType\":\"NETWORK TAKEOVER\"}]"],
];

{
	for (const [seed, count, frozen] of WITNESS) {
		const scan = generateTargetScan({ seed, count, swarmChance: 0 });
		check(`swarmChance 0: candidates unchanged (${seed})`,
			JSON.stringify(scan.candidates) === frozen,
			JSON.stringify(scan.candidates));
		check(`swarmChance 0: no cluster (${seed})`,
			scan.swarmAt === null && scan.candidates.every((c) => !c._swarm));
	}
	// And over 300 more seeds, not only the witnesses.
	let drift = 0;
	for (let i = 0; i < 300; i++) {
		const a = generateTargetScan({ seed: `nr-${i}`, count: 5, swarmChance: 0 });
		if (a.swarmAt !== null) drift++;
	}
	check('swarmChance 0: never a cluster over 300 seeds', drift === 0, `${drift}`);
}

{
	const scan = generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 1 });
	const c = scan.candidates[0];
	check('swarmChance 1: cluster present', scan.swarmAt === 0);
	check('cluster: index 0, so the strongest RSSI',
		scan.candidates.every((x, i) => i === 0 || x.rssiDbm <= c.rssiDbm));
	check('cluster: swarmNode family', c._family === SWARM_FAMILY);
	check('cluster: classHint MESH hard-coded', c._classHint === SWARM_CLASS_HINT);
	check('cluster: hackType NETWORK TAKEOVER forced', c._hackType === SWARM_HACK_TYPE);
	check('cluster: integer size within 6..12',
		Number.isInteger(c._swarm.size) && c._swarm.size >= SWARM_SIZE_MIN && c._swarm.size <= SWARM_SIZE_MAX,
		`${c._swarm.size}`);
	check('cluster: deterministic and non-empty doctrineSeed',
		typeof c._swarm.doctrineSeed === 'string' && c._swarm.doctrineSeed.length > 0
		&& c._swarm.doctrineSeed === generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 1 }).candidates[0]._swarm.doctrineSeed);
	check('cluster: the OTHER candidates are those of swarmChance 0',
		JSON.stringify(scan.candidates.slice(1))
		=== JSON.stringify(generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 0 }).candidates.slice(1)));
	check('swarmChance: the value used comes back with the scan', scan.swarmChance === 1);
	// swarmNode does NOT enter the public bucket: the ordinary loop must never
	// be able to draw it.
	check('swarmNode outside TARGET_FAMILIES/FAMILY_CLASS',
		!TARGET_FAMILIES.includes(SWARM_FAMILY) && !(SWARM_FAMILY in FAMILY_CLASS));
}

{
	// swarmAt short-circuits the draw, both ways.
	const forced = generateTargetScan({ seed: 'swarm-at', count: 4, swarmChance: 0, swarmAt: 2 });
	check('swarmAt: forces a cluster despite swarmChance 0',
		forced.swarmAt === 2 && forced.candidates[2]._family === SWARM_FAMILY);
	const none = generateTargetScan({ seed: 'swarm-at', count: 4, swarmChance: 1, swarmAt: null });
	check('swarmAt null: no cluster despite swarmChance 1',
		none.swarmAt === null && none.candidates.every((c) => !c._swarm));
	// Replay: same size and same doctrine as the original draw, or the ambient
	// and server regenerations would diverge.
	const drawn = generateTargetScan({ seed: 'swarm-replay', count: 4, swarmChance: 1 });
	const replay = generateTargetScan({ seed: 'swarm-replay', count: 4, swarmChance: 0, swarmAt: drawn.swarmAt });
	check('swarmAt: the replay renders the SAME swarm',
		JSON.stringify(drawn.candidates) === JSON.stringify(replay.candidates));
	let threw = 0;
	for (const bad of [4, -1, 1.5, '0']) {
		try { generateTargetScan({ seed: 'x', count: 4, swarmAt: bad }); } catch { threw++; }
	}
	check('swarmAt out of range -> throw', threw === 4, `${threw}/4`);
	let chanceThrew = 0;
	for (const bad of [-0.1, 1.1, NaN, 'x']) {
		try { generateTargetScan({ seed: 'x', count: 4, swarmChance: bad }); } catch { chanceThrew++; }
	}
	check('swarmChance outside [0,1] -> throw', chanceThrew === 4, `${chanceThrew}/4`);
}

{
	// Frequency: ~10% over a large number of seeds, at the default chance.
	// That is the targeted rarity, not an arbitrary value.
	let hits = 0;
	const N = 2000;
	for (let i = 0; i < N; i++) if (generateTargetScan({ seed: `freq-${i}`, count: 4 }).swarmAt !== null) hits++;
	check('SWARM_CHANCE: ~10% of scans carry a cluster',
		Math.abs(hits / N - SWARM_CHANCE) < 0.03, `${(100 * hits / N).toFixed(1)} %`);
}

{
	// The early guarantee: the 3rd scan is certain if the first two gave nothing.
	const plain = { target: { swarm: null } };
	const cluster = { target: { swarm: { size: 8, doctrineSeed: 'd' } } };
	check('guarantee: 1st scan -> nominal chance', swarmChanceFor([]) === SWARM_CHANCE);
	check('guarantee: 2nd scan -> nominal chance', swarmChanceFor([plain]) === SWARM_CHANCE);
	check('guarantee: 3rd scan with no swarm -> certain', swarmChanceFor([plain, plain]) === 1);
	check('guarantee: 3rd scan after a swarm -> nominal chance',
		swarmChanceFor([cluster, plain]) === SWARM_CHANCE);
	check('guarantee: 4th scan -> nominal chance',
		swarmChanceFor([plain, plain, plain]) === SWARM_CHANCE);
	// A session opened with no target (dev path) is not a scan.
	check('guarantee: a session with no target does not count',
		swarmChanceFor([plain, { target: null }, plain]) === 1);
	check('guarantee: absent state -> nominal chance',
		swarmChanceFor(undefined) === SWARM_CHANCE && swarmChanceFor(null) === SWARM_CHANCE);
}

{
	// A cluster's sheet: the player knows it is a group, and nothing more.
	const scan = generateTargetScan({ seed: 'swarm-sheet', count: 4, swarmChance: 1 });
	const c = scan.candidates[0];
	const sheet = describeTarget(c);
	const flat = JSON.stringify(sheet);
	check('cluster sheet: DEVICE says MESH — MULTIPLE EMITTERS',
		sheet.deviceHint === 'MESH — MULTIPLE EMITTERS', sheet.deviceHint);
	check('cluster sheet: SIGNAL says STRONGEST OF GROUP',
		sheet.signal === `${c.rssiDbm} dBm (STRONGEST OF GROUP)`, sheet.signal);
	check('cluster sheet: COUNT UNKNOWN', sheet.count === 'UNKNOWN');
	check('cluster sheet: does not leak the family', !flat.includes(SWARM_FAMILY), flat);
	// RSSI is the only legitimate number on the sheet: if no other field
	// carries a digit, the swarm's size cannot hide anywhere.
	const withoutSignal = { ...sheet };
	delete withoutSignal.signal;
	check('cluster sheet: no digit outside the RSSI',
		!/\d/.test(JSON.stringify(withoutSignal)), JSON.stringify(withoutSignal));
	check('cluster sheet: does not leak the doctrine', !flat.includes(c._swarm.doctrineSeed));
	// An ordinary target has NO COUNT line: there is no group.
	check('ordinary sheet: no COUNT',
		describeTarget(scan.candidates[1]).count === undefined);
}

{
	// resolveTarget persists the swarm and what is needed to replay the scan
	// identically.
	const scan = generateTargetScan({ seed: 'swarm-resolve', count: 4, swarmChance: 1 });
	const t = resolveTarget(scan, 0);
	check('resolveTarget: swarm { size, doctrineSeed }',
		t.swarm?.size === scan.candidates[0]._swarm.size
		&& t.swarm?.doctrineSeed === scan.candidates[0]._swarm.doctrineSeed);
	check('resolveTarget: scan.swarmAt', t.scan.swarmAt === 0);
	check('resolveTarget: scan.swarmChance', t.scan.swarmChance === 1);
	check('resolveTarget: swarmNode family', t.family === SWARM_FAMILY);
	check('resolveTarget: classHint MESH', t.classHint === SWARM_CLASS_HINT);
	const plain = resolveTarget(generateTargetScan({ seed: 'swarm-resolve', count: 4, swarmChance: 0 }), 0);
	check('resolveTarget: no cluster -> swarm null', plain.swarm === null);
	check('resolveTarget: no cluster -> swarmAt null', plain.scan.swarmAt === null);
}

// --- scanLines: the list row (issue #49)
//
// The pre-hack sheet is gone; what the player reads to choose now fits on the
// row. These cases are therefore the direct heir of describeTarget's: the
// "never leaks" guarantee is checked here on the string ACTUALLY shown, not
// on an intermediate object nobody sees.
{
	const scan = generateTargetScan({ seed: 'line-plain', count: 5, swarmChance: 0 });
	const lines = scanLines(scan.candidates);
	check('scanLines: one row per candidate', lines.length === scan.candidates.length);

	// Columns are the sole point of a single row: misaligned, it is less
	// readable than the sheet it replaces. This checks position, not
	// spacing — that is what the eye follows.
	const at = (line, needle) => line.indexOf(needle);
	const idCols = lines.map((l) => at(l, l.trim().slice(0, 2)));
	check('scanLines: the id column is aligned', new Set(idCols).size === 1, String(idCols));
	const dbmCols = lines.map((l) => at(l, ' dBm'));
	check('scanLines: the signal column is aligned', new Set(dbmCols).size === 1, String(dbmCols));
	scan.candidates.forEach((c, i) => {
		const d = describeTarget(c);
		check(`scanLines(${c.id}) carries the id`, lines[i].includes(c.id));
		check(`scanLines(${c.id}) carries the signal`, lines[i].includes(`${c.rssiDbm} dBm`));
		check(`scanLines(${c.id}) carries the video mode`, lines[i].includes(d.video));
		check(`scanLines(${c.id}) carries the device`, lines[i].includes(d.deviceHint), lines[i]);
	});
	// A row is a row: a line break would split it in two in the list.
	check('scanLines: no row contains a line break', lines.every((l) => !l.includes('\n')));
}

{
	// What the row DOES NOT SAY stays what the sheet did not say.
	for (const seed of ['line-leak-a', 'line-leak-b', 'line-leak-c']) {
		const scan = generateTargetScan({ seed, count: 5, swarmChance: 0 });
		const flat = scanLines(scan.candidates).join('\n');
		scan.candidates.forEach((c) => {
			check(`scanLines(${seed}/${c.id}) without family`, !flat.includes(c._family), c._family);
			check(`scanLines(${seed}/${c.id}) without hackType`, !flat.includes(c._hackType), c._hackType);
			// An unmeasured mode stays UNKNOWN: the row must not let the real
			// mode through, which is discovered at the first frame.
			if (c.mode === 'UNKNOWN') {
				const other = c._videoHint;
				const line = scanLines(scan.candidates)[scan.candidates.indexOf(c)];
				check(`scanLines(${seed}/${c.id}) does not leak the real mode`, !line.includes(other), line);
			}
		});
	}
}

{
	// A cluster's row carries the three mentions of the old sheet, and still
	// never the machine nor the size (issue #29).
	const scan = generateTargetScan({ seed: 'line-swarm', count: 4, swarmChance: 1 });
	const lines = scanLines(scan.candidates);
	const c = scan.candidates[0];
	check('cluster row: STRONGEST OF GROUP', lines[0].includes('(STRONGEST OF GROUP)'), lines[0]);
	check('cluster row: MESH — MULTIPLE EMITTERS', lines[0].includes('MESH — MULTIPLE EMITTERS'));
	check('cluster row: COUNT UNKNOWN', lines[0].includes('COUNT UNKNOWN'));
	check('cluster row: does not name the family', !lines[0].includes(SWARM_FAMILY), lines[0]);
	check('cluster row: does not leak the doctrine', !lines[0].includes(c._swarm.doctrineSeed));
	// RSSI is the only legitimate number: elsewhere, a digit would be the
	// group's size. The signal's `-57` is stripped before searching.
	const withoutRssi = lines[0].replace(`${c.rssiDbm} dBm`, '').replace(c.id, '');
	check('cluster row: no digit outside the RSSI', !/\d/.test(withoutRssi), withoutRssi);
	// The ordinary targets of the SAME scan mention no group at all.
	check('ordinary row: no COUNT',
		lines.slice(1).every((l) => !l.includes('COUNT')), lines.slice(1).join(' | '));
	check('ordinary row: no GROUP',
		lines.slice(1).every((l) => !l.includes('GROUP')));
	// And the cluster's long row does not misalign the ones below it.
	const dbmCols = lines.map((l) => l.indexOf(' dBm'));
	check('cluster row: the columns still hold', new Set(dbmCols).size === 1, String(dbmCols));
}

// --- families: the draw pool follows clearance (issue #185, Signals lot 3)
{
	const FREESTYLE_ONLY = ['freestyle5'];
	// A restricted pool: every draw stays inside it, over many seeds — this
	// is the guarantee that makes a clearance level actually gate anything.
	// swarmChance: 0 throughout — the swarm draw is a SEPARATE mechanism
	// (issue #29) that overwrites candidate 0's family regardless of pool;
	// gating it is Task 2's other half, checked in ambient/session-api.
	let outside = 0;
	for (let i = 0; i < 200; i++) {
		const scan = generateTargetScan({ seed: `pool-${i}`, count: 5, families: FREESTYLE_ONLY, swarmChance: 0 });
		for (const c of scan.candidates) if (c._family !== 'freestyle5') outside++;
	}
	check('families: a restricted pool never draws outside it', outside === 0, `${outside}`);

	const pool2 = ['freestyle5', 'cinewhoop', 'toothpick'];
	let outside2 = 0;
	for (let i = 0; i < 200; i++) {
		const scan = generateTargetScan({ seed: `pool2-${i}`, count: 5, families: pool2, swarmChance: 0 });
		for (const c of scan.candidates) if (!pool2.includes(c._family)) outside2++;
	}
	check('families: a wider pool still never draws outside it', outside2 === 0, `${outside2}`);

	// Same seed, same families -> same scan (the client/server non-divergence
	// this task depends on).
	const a = generateTargetScan({ seed: 'pool-det', count: 5, families: pool2 });
	const b = generateTargetScan({ seed: 'pool-det', count: 5, families: pool2 });
	check('families: same seed + same families -> same scan', JSON.stringify(a) === JSON.stringify(b));

	// Absent, empty or invalid -> the full pool, never a throw: an older
	// caller that knows nothing of clearance must keep working.
	check('families: absent -> full pool',
		generateTargetScan({ seed: 'pool-full', count: 5 }).families.join() === TARGET_FAMILIES.join());
	check('families: empty array -> full pool',
		generateTargetScan({ seed: 'pool-full', count: 5, families: [] }).families.join() === TARGET_FAMILIES.join());
	check('families: unknown key -> full pool',
		generateTargetScan({ seed: 'pool-full', count: 5, families: ['not-a-family'] }).families.join() === TARGET_FAMILIES.join());
	check('families: not an array -> full pool',
		generateTargetScan({ seed: 'pool-full', count: 5, families: 'freestyle5' }).families.join() === TARGET_FAMILIES.join());

	// The pool actually used travels with the scan and with resolveTarget's
	// persisted descriptor — that is what lets an ambient regeneration draw
	// from the SAME pool as the flight did.
	check('families: the scan carries the pool it drew from',
		generateTargetScan({ seed: 'pool-echo', count: 4, families: FREESTYLE_ONLY }).families.join() === FREESTYLE_ONLY.join());
	const scan = generateTargetScan({ seed: 'pool-resolve', count: 4, families: pool2 });
	const t = resolveTarget(scan, 0);
	check('resolveTarget: scan.families carries the pool used',
		t.scan.families.join() === pool2.join());
}

// --- drift guard
check('FAMILY_CLASS covers exactly FAMILIES',
	TARGET_FAMILIES.slice().sort().join(',') === FAMILIES.slice().sort().join(','),
	`${TARGET_FAMILIES.join(' ')} vs ${FAMILIES.join(' ')}`);

console.log(`\n${pass} tests target OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
