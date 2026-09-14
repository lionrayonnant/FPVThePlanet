// node tools/spec-data-selftest.mjs — the flight-physics specification's own
// data (src/spec-data/), and criterion 1 of its §13: "the five presets load and
// re-serialise identically".
//
// Two jobs, and the second is the one worth having. The first is the round
// trip: src/spec-data/ splits every source record into hardware facts and
// engine tuning constants, and specPresetRecord() has to put the two halves
// back together field for field. The second is that the FACTS are coherent —
// a 1103 weighs 5 g, a "5043" is five inches with a 4.3 pitch, a frame's prop
// window brackets its own default, motor mass grows with stator volume. Those
// are checks the data can FAIL, which is the only kind worth writing: a
// transcription that fat-fingered a digit shows up here rather than three
// modules downstream as a drone that hovers at the wrong stick.
//
// Needs no scene, no network, no browser. The source JSON lives OUTSIDE this
// repo (the specification folder is not vendored); everything that needs it
// SKIPS loudly when it is not reachable rather than failing — same rule as
// tools/entry-state-selftest.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SPEC_PRESETS, SPEC_PRESET_KEYS, SPEC_PRESET_FIELD_ORDER, motorKv,
	SPEC_MOTORS, SPEC_PROPELLERS, SPEC_FRAMES, SPEC_BATTERIES, SPEC_CAMERAS,
	SPEC_COUNTS, specPresetRecord, INCH,
} from '../src/spec-data/index.js';
import { PRESET_TUNING } from '../src/spec-data/tuning-constants.js';

let failures = 0, skipped = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
function skip(label, why) {
	console.log(`  SKIP  ${label} — ${why}`);
	skipped++;
}

console.log('spec-data — the specification catalogue, and criterion 1\n');

// ---------------------------------------------------------------------------
console.log('1. everything the spec says is there, is there');

for (const [what, table] of [
	['presets', SPEC_PRESETS], ['motors', SPEC_MOTORS], ['propellers', SPEC_PROPELLERS],
	['frames', SPEC_FRAMES], ['batteries', SPEC_BATTERIES], ['cameras', SPEC_CAMERAS],
]) {
	const n = Object.keys(table).length;
	check(`${what}: ${SPEC_COUNTS[what]} entries`, n === SPEC_COUNTS[what], `got ${n}`);
}

// §12.2 states the catalogue's extremes in prose. If a transcription dropped an
// end of the range, these are what notice.
check('coverage: the 1103/8000 KV at 5 g is present',
	SPEC_MOTORS['8000-1103']?.massG === 5 && SPEC_MOTORS['8000-1103']?.kv === 8000);
check('coverage: the 2807/1300 KV is present', SPEC_MOTORS['1300-2807']?.kv === 1300);
{
	const d = Object.values(SPEC_PROPELLERS).map((p) => p.diameterIn);
	check('coverage: propellers span 2" to 7"', Math.min(...d) === 2 && Math.max(...d) === 7,
		`${Math.min(...d)}..${Math.max(...d)}`);
	const f = Object.values(SPEC_FRAMES).map((x) => x.defaultPropSize);
	check('coverage: frames span 2" to 7"', Math.min(...f) === 2 && Math.max(...f) === 7,
		`${Math.min(...f)}..${Math.max(...f)}`);
	const b = Object.values(SPEC_BATTERIES);
	check('coverage: batteries span 1S 450 mAh to 6S 4500 mAh',
		b.some((x) => x.cells === 1 && x.capacityMah === 450)
		&& b.some((x) => x.cells === 6 && x.capacityMah === 4500));
}

// ---------------------------------------------------------------------------
console.log('\n2. criterion 1 — the five presets re-serialise identically');

// (a) The split survives a round trip on its own terms: every field of the
//     source order comes back, none of them undefined.
{
	const missing = [];
	for (const key of SPEC_PRESET_KEYS) {
		const rec = specPresetRecord(key);
		for (const f of SPEC_PRESET_FIELD_ORDER) {
			if (rec[f] === undefined) missing.push(`${key}.${f}`);
		}
		if (Object.keys(rec).length !== SPEC_PRESET_FIELD_ORDER.length) missing.push(`${key}: extra fields`);
	}
	check('every preset reassembles all 25 fields, in the spec\'s order',
		missing.length === 0, missing.join(', '));
	const rec = specPresetRecord(SPEC_PRESET_KEYS[0]);
	check('the reassembled field order is the spec\'s field order',
		JSON.stringify(Object.keys(rec)) === JSON.stringify(SPEC_PRESET_FIELD_ORDER));
	check('an unknown preset key returns null, not a half-built record',
		specPresetRecord('no-such-preset') === null);
}

// (b) And against the source JSON, which is what criterion 1 actually asks.
//     The values were transcribed as the source's own float32-widened doubles,
//     so this is an EXACT comparison, not a tolerance.
const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const specDir = process.env.FPV_SPEC_DIR
	?? path.resolve(SIM_ROOT, '../../SPEC_SIMULATEUR_FPV');
const donnees = path.join(specDir, 'donnees');
const readSpec = (f) => JSON.parse(fs.readFileSync(path.join(donnees, f), 'utf8'));
const haveSource = fs.existsSync(path.join(donnees, 'presets_vol.json'));

if (!haveSource) {
	skip('round trip against the source JSON',
		`no specification folder at ${donnees} (set FPV_SPEC_DIR to point at it)`);
} else {
	const src = readSpec('presets_vol.json');
	check('the source field order is the transcribed one',
		JSON.stringify(src.champs_ordonnes) === JSON.stringify(SPEC_PRESET_FIELD_ORDER));
	const bad = [];
	for (const [key, want] of Object.entries(src.presets)) {
		const got = specPresetRecord(key);
		if (!got) { bad.push(`${key}: missing`); continue; }
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			for (const f of SPEC_PRESET_FIELD_ORDER) {
				if (JSON.stringify(got[f]) !== JSON.stringify(want[f])) {
					bad.push(`${key}.${f}: ${JSON.stringify(got[f])} != ${JSON.stringify(want[f])}`);
				}
			}
		}
	}
	check(`all ${Object.keys(src.presets).length} presets re-serialise byte-for-byte`,
		bad.length === 0, bad.slice(0, 6).join('; '));

	// The catalogue too, while the source is open: same exactness, and it is the
	// only thing that can catch a digit lost in 74 transcribed records.
	const cmp = (file, table, map) => {
		const s = readSpec(file);
		const wrong = [];
		for (const [id, want] of Object.entries(s)) {
			const got = table[id];
			if (!got) { wrong.push(`${id}: missing`); continue; }
			for (const [field, pick] of Object.entries(map)) {
				if (JSON.stringify(got[field]) !== JSON.stringify(pick(want))) {
					wrong.push(`${id}.${field}: ${JSON.stringify(got[field])} != ${JSON.stringify(pick(want))}`);
				}
			}
		}
		check(`${file}: every fact matches the source exactly`, wrong.length === 0,
			wrong.slice(0, 6).join('; '));
	};
	cmp('moteurs.json', SPEC_MOTORS, {
		name: (r) => r.Name, massG: (r) => r.MasseGrammes, kv: (r) => r.KV,
		propSizeMin: (r) => r.PropSizeMin, propSizeMax: (r) => r.PropSizeMax,
	});
	cmp('helices.json', SPEC_PROPELLERS, {
		name: (r) => r.Name, massG: (r) => r.MasseGrammes,
		diameterIn: (r) => r.Diametre, pitchIn: (r) => r.Pas,
	});
	cmp('chassis.json', SPEC_FRAMES, {
		name: (r) => r.Name, massG: (r) => r.MasseGrammes,
		defaultPropSize: (r) => r.DefaultPropSize, minPropSize: (r) => r.MinPropSize,
		maxPropSize: (r) => r.MaxPropSize,
	});
	cmp('batteries.json', SPEC_BATTERIES, {
		name: (r) => r.Name, cells: (r) => r.S, capacityMah: (r) => r.Mahcapacity,
		massG: (r) => r.MasseGrammes, dischargeC: (r) => r.DischargeC,
	});
	cmp('cameras.json', SPEC_CAMERAS, {
		name: (r) => r.Name, massG: (r) => r.MasseGrammes, cgOffset: (r) => r.CenterOfGravityoffset,
	});
}

// ---------------------------------------------------------------------------
console.log('\n3. the hardware facts are coherent');

// Propeller part numbers encode their own geometry: "5043" is five inches with
// a 4.3 pitch. The last two digits are the pitch EXACTLY, every entry. The
// first two are the nominal diameter, which the catalogue rounds to the frame
// class it belongs to ("3630" is a 3.6" blade filed under 3.5") — hence a
// tolerance on one and none on the other.
//
// KNOWN DEFECT IN THE SOURCE DATA, pinned rather than hidden or worked around:
// "7037" carries a pitch of 3.6", not the 3.7" its own part number states. One
// of the two is a typo upstream and this bench cannot tell which, so it is
// listed here — which means a SECOND such entry appearing tomorrow fails.
const PITCH_MISMATCH = ['7037'];
{
	const pitchBad = [], diaBad = [];
	for (const [id, p] of Object.entries(SPEC_PROPELLERS)) {
		if (!/^\d{4}$/.test(id)) continue;
		const pitch = Number(id.slice(2)) / 10;
		const dia = Number(id.slice(0, 2)) / 10;
		if (Math.abs(pitch - p.pitchIn) > 0.051) pitchBad.push(id);
		if (Math.abs(dia - p.diameterIn) > 0.15) diaBad.push(`${id}: ${p.diameterIn}`);
	}
	check('every propeller part number states its own pitch, bar the known one',
		JSON.stringify(pitchBad) === JSON.stringify(PITCH_MISMATCH),
		`mismatched: ${pitchBad.join(', ') || 'none'} (expected ${PITCH_MISMATCH.join(', ')})`);
	for (const id of PITCH_MISMATCH) {
		console.log(`  NOTE  ${id} is filed with a ${SPEC_PROPELLERS[id].pitchIn.toFixed(2)}" pitch`
			+ ` against a part number that reads ${Number(id.slice(2)) / 10}"`);
	}
	check('every propeller part number states its own diameter to 0.15"',
		diaBad.length === 0, diaBad.join(', '));
}
{
	// The band is wide on purpose: a 2040 really is a 2" blade with a 4" pitch,
	// a pitch/diameter of 2.0, and it is a product you can buy. What this
	// excludes is a transposed pair or a decimal lost in transcription.
	const bad = Object.entries(SPEC_PROPELLERS).filter(([, p]) => {
		const r = p.pitchIn / p.diameterIn;
		return !(r > 0.3 && r <= 2.1) || !(p.massG > 0);
	});
	check('pitch/diameter stays in the physical band, and no blade weighs nothing',
		bad.length === 0, bad.map(([id]) => id).join(', '));
	// A bigger blade is a heavier blade. Sorted by diameter, mass never falls.
	const sorted = Object.values(SPEC_PROPELLERS).sort((a, b) => a.diameterIn - b.diameterIn);
	const drop = sorted.find((p, i) => i > 0 && p.massG < sorted[i - 1].massG);
	check('propeller mass never falls as diameter rises', !drop, drop?.name);
}

// Motors: the part number is the stator, DD x HH in millimetres. Mass has to
// follow stator volume across the whole catalogue — it is the same copper and
// the same steel.
{
	const vol = (name) => {
		const m = /^(\d\d)(\d\d(?:\.\d)?)/.exec(name.replace(/\s/g, ''));
		if (!m) return null;
		return Number(m[1]) ** 2 * Number(m[2]);
	};
	const rows = Object.values(SPEC_MOTORS)
		.map((x) => ({ ...x, vol: vol(x.name) }))
		.filter((x) => x.vol !== null)
		.sort((a, b) => a.vol - b.vol);
	check('every motor name parses as a stator size', rows.length === Object.keys(SPEC_MOTORS).length,
		`${rows.length}/${Object.keys(SPEC_MOTORS).length}`);
	const drop = rows.find((r, i) => i > 0 && r.massG < rows[i - 1].massG);
	check('motor mass never falls as stator volume rises', !drop, drop && `${drop.name} ${drop.massG} g`);
	check('the 1103 weighs 5 g, as §12.2 states',
		rows.filter((r) => r.name.startsWith('1103')).every((r) => r.massG === 5));
	const win = Object.values(SPEC_MOTORS).filter((m) => !(m.propSizeMin < m.propSizeMax && m.propSizeMin > 0));
	check('every motor\'s prop window is a real interval', win.length === 0, win.map((m) => m.name).join(', '));
	// Bigger stator, bigger prop, lower KV: the three move together on a real
	// bench, and a transcription that swapped two rows would break it.
	const kvDrop = rows.filter((r, i) => i > 0 && r.vol > rows[i - 1].vol * 2 && r.kv > rows[i - 1].kv);
	check('a much bigger motor is never a much higher KV one', kvDrop.length === 0,
		kvDrop.map((r) => r.name).join(', '));
}

// Frames: the prop window has to bracket the frame's own default, and the
// catalogue has to actually contain a blade that fits it.
{
	const bad = [], empty = [];
	for (const f of Object.values(SPEC_FRAMES)) {
		if (!(f.minPropSize <= f.defaultPropSize && f.defaultPropSize <= f.maxPropSize)) bad.push(f.name);
		const fits = Object.values(SPEC_PROPELLERS)
			.some((p) => p.diameterIn >= f.minPropSize && p.diameterIn <= f.maxPropSize);
		if (!fits) empty.push(f.name);
		if (!(f.massG > 0)) bad.push(`${f.name}: massless`);
	}
	check('every frame\'s prop window brackets its own default', bad.length === 0, bad.join(', '));
	check('every frame has at least one propeller in the catalogue that fits it',
		empty.length === 0, empty.join(', '));
	const sorted = Object.values(SPEC_FRAMES).sort((a, b) => a.defaultPropSize - b.defaultPropSize);
	check('the biggest frame is the heaviest class',
		sorted[sorted.length - 1].massG > sorted[0].massG);
}

// Batteries: energy density is a property of the chemistry, not of the pack, so
// Wh per gram has to sit in one narrow band across all seventeen.
{
	const wh = (b) => (b.cells * 3.7 * b.capacityMah) / 1000;
	const rows = Object.values(SPEC_BATTERIES).map((b) => ({ b, whPerG: wh(b) / b.massG }));
	const out = rows.filter((r) => !(r.whPerG > 0.09 && r.whPerG < 0.30));
	check('every pack sits in the LiPo energy-density band (0.09-0.30 Wh/g)',
		out.length === 0, out.map((r) => `${r.b.name} ${r.whPerG.toFixed(3)}`).join(', '));
	const bad = Object.values(SPEC_BATTERIES).filter(
		(b) => !(b.cells >= 1 && b.cells <= 6 && b.capacityMah > 0 && b.dischargeC > 0
			&& b.framePropSizeMin <= b.framePropSizeMax),
	);
	check('cells, capacity, C rating and fitment window are all sane', bad.length === 0,
		bad.map((b) => b.name).join(', '));
	// A pack that fits no frame in the catalogue is a real gap, not a typo —
	// reported, not failed, because the spec's coverage claim (§12.2) does not
	// promise the six slots intersect.
	const orphans = Object.values(SPEC_BATTERIES).filter((b) => !Object.values(SPEC_FRAMES)
		.some((f) => f.defaultPropSize >= b.framePropSizeMin && f.defaultPropSize <= b.framePropSizeMax));
	console.log(`  NOTE  ${orphans.length} pack(s) fit no frame in the catalogue`
		+ `${orphans.length ? `: ${orphans.map((b) => b.name).join(', ')}` : ''}`);
}

// Cameras: three entries, and the "None" one has to be the zero of the set.
{
	const none = Object.values(SPEC_CAMERAS).find((c) => c.name === 'None');
	check('the "None" camera adds no mass and no CG offset',
		none && none.massG === 0 && none.cgOffset === 0);
	const heavy = Object.values(SPEC_CAMERAS).map((c) => c.massG).sort((a, b) => a - b);
	check('the heavy action cam is the heaviest', heavy[heavy.length - 1] === 150);
}

// ---------------------------------------------------------------------------
console.log('\n4. the five presets say what §12.1 says they say');

// §12.1 states the common fields in prose and the varying ones in a table. The
// JSON and the prose are two independent statements of the same thing; this is
// where they get compared.
{
	const bad = [];
	for (const p of Object.values(SPEC_PRESETS)) {
		if (p.batteryCells !== 6) bad.push(`${p.key}: cells ${p.batteryCells}`);
		if (Math.abs(p.gravity - 9.82) > 1e-5) bad.push(`${p.key}: gravity ${p.gravity}`);
		if (Math.abs(p.mass - 0.715) > 1e-5) bad.push(`${p.key}: mass ${p.mass}`);
	}
	check('common fields: 6S, 9.82 m/s², 0.715 kg on all five', bad.length === 0, bad.join(', '));

	// The §12.1 table, transcribed from the PROSE rather than from the JSON —
	// that is the whole point of the check.
	const TABLE = {
		All_default: { propSize: 5.0, pitch: 4.30, kv: 1.75, airGrip: 0.80, damp: 0.40, instant: 1.00 },
		'5free':     { propSize: 5.0, pitch: 3.70, kv: 1.75, airGrip: 1.45, damp: 0.40, instant: 1.00 },
		'5Race':     { propSize: 5.0, pitch: 4.30, kv: 1.90, airGrip: 1.10, damp: 0.32, instant: 0.75 },
		'3Cinewhoop': { propSize: 3.0, pitch: 3.00, kv: 1.60, airGrip: 0.80, damp: 0.50, instant: 1.00 },
		'3free':     { propSize: 3.0, pitch: 3.00, kv: 1.70, airGrip: 0.80, damp: 0.15, instant: 1.70 },
	};
	const off = [];
	for (const [key, w] of Object.entries(TABLE)) {
		const p = SPEC_PRESETS[key], t = PRESET_TUNING[key];
		if (!p || !t) { off.push(`${key}: missing`); continue; }
		const near = (a, b, tol = 5e-3) => Math.abs(a - b) <= tol;
		if (!near(p.propSize, w.propSize)) off.push(`${key}.PropSize ${p.propSize}`);
		if (!near(p.propellerPitch, w.pitch)) off.push(`${key}.Pitch ${p.propellerPitch}`);
		if (!near(p.motorsKvThousands, w.kv)) off.push(`${key}.MotorsKV ${p.motorsKvThousands}`);
		if (!near(t.airGrip, w.airGrip)) off.push(`${key}.AirGrip ${t.airGrip}`);
		if (!near(t.linearDamp, w.damp)) off.push(`${key}.LinearDamp ${t.linearDamp}`);
		if (!near(t.instantPower, w.instant)) off.push(`${key}.InstantPower ${t.instantPower}`);
	}
	check('the JSON matches the §12.1 table as written in prose', off.length === 0, off.join(', '));

	// The unit trap §13 names explicitly: MotorsKV is in thousands. A preset
	// whose motorKv() came back at 1.75 rpm/V would fly a thousand times slow.
	const kvs = Object.values(SPEC_PRESETS).map(motorKv);
	check('motorKv() returns rpm per volt, not thousands',
		kvs.every((k) => k >= 1000 && k <= 20000), kvs.join(', '));

	// And the intents §12.1 states in words, which are the only thing keeping
	// the five presets from being one preset five times.
	check('§12.1 intent: the 5" freestyle has the highest AirGrip',
		PRESET_TUNING['5free'].airGrip === Math.max(...Object.values(PRESET_TUNING).map((t) => t.airGrip)));
	check('§12.1 intent: the race preset has more KV and less drag than the default',
		SPEC_PRESETS['5Race'].motorsKvThousands > SPEC_PRESETS.All_default.motorsKvThousands
		&& PRESET_TUNING['5Race'].linearDamp < PRESET_TUNING.All_default.linearDamp);
	check('§12.1 intent: the race preset has the LOWER InstantPower, not the higher',
		PRESET_TUNING['5Race'].instantPower < PRESET_TUNING.All_default.instantPower);
	check('§12.1 intent: the 3" freestyle has the highest InstantPower and the least damping',
		PRESET_TUNING['3free'].instantPower === Math.max(...Object.values(PRESET_TUNING).map((t) => t.instantPower))
		&& PRESET_TUNING['3free'].linearDamp === Math.min(...Object.values(PRESET_TUNING).map((t) => t.linearDamp)));
}

// One unit constant the rest of the bench leans on.
check('INCH is metres per inch', Math.abs(INCH - 0.0254) < 1e-12);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`
	+ `${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures === 0 ? 0 : 1);
