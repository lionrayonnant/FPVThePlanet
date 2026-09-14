// Validate src/blade-element.js against MEASURED propeller data.
//
//   node tools/uiuc-prop-validate.mjs [path-to-UIUC-propDB]
//   node tools/uiuc-prop-validate.mjs --selftest     (no data needed, CI-safe)
//
// Everything in the blade-element model so far is CALIBRATED: chord scale and
// section drag are solved so each rotor reproduces its own profile's two
// measured anchors. That makes it self-consistent and proves nothing about
// anywhere else — which is exactly the gap this closes.
//
// The UIUC Propeller Data Site (Selig et al., University of Illinois) publishes
// wind-tunnel measurements for hundreds of small propellers: thrust and power
// coefficients against advance ratio, which is the curve this model predicts
// and nothing until now has checked. Download:
//
//   https://m-selig.ae.illinois.edu/props/download/UIUC-propDB.zip
//
// Unzip it anywhere and pass the path, or set UIUC_PROP_DB, or drop it at
// sim/.data/ (gitignored — the archive is large and is not this repository's to
// redistribute; it stays a local reference, cited, not vendored).
//
// THE TEST. For each propeller: take ONE operating point — static thrust and
// power at one rpm — and solve the model's two free numbers against it, exactly
// as a family profile does. Then predict the whole advance-ratio sweep with
// those two held fixed, and compare against the tunnel. Two numbers in, a curve
// out. If the model is only curve-fitting, this is where it shows.
//
// Conventions. UIUC uses the propeller convention, this model uses the rotor
// one, so everything crosses over here and nowhere else:
//
//   n = rpm/60 rev/s,  D = 2R,  omega = 2*pi*n
//   J  = V / (n D)                 advance ratio
//   CT = T / (rho n^2 D^4)
//   CP = P / (rho n^3 D^5),  P = Q * omega
//
// Blade count is NOT in the file names. Almost every propeller in the database
// is a two-blader, which is what is assumed; the few that are not are excluded
// by name rather than silently mismodelled.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geometryOf, rotorForces } from '../src/blade-element.js';

const RHO = 1.225;
const INCH = 0.0254;

// Two- and three-bladed props share a naming scheme; the known non-two are kept
// out rather than modelled as two.
const NOT_TWO_BLADED = /(_3b|_4b|three|quad)/i;

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.endsWith('.txt')) out.push(p);
	}
	return out;
}

// A data file is a text header line then whitespace-separated numeric rows.
function readRows(file) {
	const rows = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const nums = parts.map(Number);
		if (nums.some((v) => !Number.isFinite(v))) continue;   // the header
		rows.push(nums);
	}
	return rows;
}

// "apce_5x4.7_static_2783rd.txt" -> { prop: 'apce_5x4.7', diameter, pitch }
export function parseName(file) {
	const base = path.basename(file, '.txt');
	const m = base.match(/^(.*?_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?))(?:_(static))?(?:_(\d+))?/);
	if (!m) return null;
	return {
		prop: m[1],
		diameter: Number(m[2]) * INCH,
		pitch: Number(m[3]) * INCH,
		isStatic: base.includes('_static'),
	};
}

export function predict(geom, diameter, rpm, J) {
	const n = rpm / 60;
	const omega = 2 * Math.PI * n;
	const V = J * n * diameter;
	const { thrust, torque } = rotorForces(geom, omega, V, RHO);
	return {
		ct: thrust / (RHO * n * n * diameter ** 4),
		cp: (torque * omega) / (RHO * n ** 3 * diameter ** 5),
	};
}

// Calibrate against ONE measured static point, the way a family profile does.
export function calibrate(p, rpm, ct, cp) {
	const n = rpm / 60;
	const omega = 2 * Math.PI * n;
	const thrust = ct * RHO * n * n * p.diameter ** 4;
	const torque = (cp * RHO * n ** 3 * p.diameter ** 5) / omega;
	return geometryOf({
		propRadius: p.diameter / 2,
		propPitch: p.pitch,
		bladeCount: 2,
		maxOmega: omega,
		maxThrustPerMotor: thrust,
		torqueRatio: torque / thrust,
	});
}

// Error against advance ratio, in tenth-wide bins, with the SIGN kept.
//
// This is the view that matters and the reason it is built in rather than done
// on the side. A mean error over a whole database says "the model is 77% out"
// and stops there. The same points split by J said something an average cannot:
// the error grew monotonically with advance ratio and never changed sign, which
// is a structural defect and not scatter — and its shape named the term that
// was missing, the zero-lift angle of a cambered section. A mean absolute error
// alone would have hidden that behind the propellers that happened to agree.
export const BIN_WIDTH = 0.1;
export const BIN_COUNT = 12;

function newBins() {
	return Array.from({ length: BIN_COUNT }, (_, i) => ({
		lo: i * BIN_WIDTH, hi: (i + 1) * BIN_WIDTH,
		n: 0, absCt: 0, signedCt: 0, absCp: 0, signedCp: 0,
	}));
}

function binFor(bins, J) {
	return bins[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(J / BIN_WIDTH)))];
}

export function analyse(root) {
	const props = new Map();
	for (const f of walk(root)) {
		const info = parseName(f);
		if (!info || NOT_TWO_BLADED.test(f)) continue;
		// Small props only: this model exists for multirotor blades, and a 20
		// inch slow-flyer says nothing about a 5 inch freestyle prop.
		if (info.diameter > 0.28) continue;
		if (!props.has(info.prop)) props.set(info.prop, { ...info, static: [], sweeps: [] });
		const rows = readRows(f);
		if (rows.length < 3) continue;
		if (info.isStatic) props.get(info.prop).static.push(...rows);      // rpm CT CP
		else props.get(info.prop).sweeps.push({ file: f, rows });          // J CT CP eta
	}

	const results = [];
	const bins = newBins();
	for (const [name, p] of props) {
		if (!p.static.length || !p.sweeps.length) continue;
		// The static point nearest the middle of the measured rpm range: the ends
		// of a tunnel sweep are where the measurement is least trustworthy.
		const stat = p.static.slice().sort((a, b) => a[0] - b[0])[Math.floor(p.static.length / 2)];
		const [rpm, ct0, cp0] = stat;
		if (!(ct0 > 0) || !(cp0 > 0)) continue;
		let geom;
		try { geom = calibrate(p, rpm, ct0, cp0); } catch { continue; }

		let n = 0, sumCt = 0, sumCp = 0, worst = 0, worstAt = '';
		for (const sweep of p.sweeps) {
			const sweepRpm = Number(path.basename(sweep.file).match(/_(\d{3,5})[a-z]*\.txt$/)?.[1]);
			if (!Number.isFinite(sweepRpm)) continue;
			for (const [J, ct, cp] of sweep.rows) {
				if (!(ct > 0.005) || !(cp > 0.005)) continue;   // past the thrust-zero knee
				const got = predict(geom, p.diameter, sweepRpm, J);
				const eCt = Math.abs(got.ct - ct) / ct;
				sumCt += eCt;
				sumCp += Math.abs(got.cp - cp) / cp;
				const b = binFor(bins, J);
				b.n++;
				b.absCt += eCt;
				b.signedCt += (got.ct - ct) / ct;
				b.absCp += Math.abs(got.cp - cp) / cp;
				b.signedCp += (got.cp - cp) / cp;
				n++;
				if (eCt > worst) { worst = eCt; worstAt = `J=${J.toFixed(2)}`; }
			}
		}
		if (n < 8) continue;
		results.push({
			name, points: n, ct: sumCt / n, cp: sumCp / n, worst, worstAt,
			d: p.diameter / INCH, pitch: p.pitch / INCH, cd0: geom.cd0,
		});
	}
	results.bins = bins;
	return results;
}

// ---------------------------------------------------------------------------
// --selftest: generate a database in UIUC's own format FROM this model, feed it
// back through the whole path, and require the error to come out at zero. It
// proves nothing about the physics — it is the same model on both sides — and
// that is the point: it guards the part that silently ruins a validation, the
// conversion between UIUC's propeller convention and this model's rotor one. A
// units error there shows up as a plausible-looking 30% model error and gets
// chased in the wrong file for a day.
function roundTrip() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uiuc-'));
	const data = path.join(dir, 'volume-1', 'data');
	fs.mkdirSync(data, { recursive: true });
	const D = 5 * INCH;
	const g0 = geometryOf({
		propRadius: D / 2, propPitch: 4.3 * INCH, bladeCount: 2,
		maxOmega: 3140, maxThrustPerMotor: 6.0, torqueRatio: 0.02,
	});
	const coeffs = (rpm, J) => {
		const n = rpm / 60, w = 2 * Math.PI * n;
		const r = rotorForces(g0, w, J * n * D, RHO);
		return [r.thrust / (RHO * n * n * D ** 4), (r.torque * w) / (RHO * n ** 3 * D ** 5)];
	};
	let stat = 'RPM        CT        CP\n';
	for (const rpm of [2000, 3000, 4000, 5000, 6000]) {
		const [ct, cp] = coeffs(rpm, 0);
		stat += `${rpm}  ${ct.toFixed(5)}  ${cp.toFixed(5)}\n`;
	}
	fs.writeFileSync(path.join(data, 'synth_5x4.3_static_0000rd.txt'), stat);
	for (const rpm of [3000, 4000, 5000]) {
		let d = 'J         CT        CP        eta\n';
		for (let J = 0.05; J <= 0.7; J += 0.05) {
			const [ct, cp] = coeffs(rpm, J);
			d += `${J.toFixed(4)}  ${ct.toFixed(5)}  ${cp.toFixed(5)}  ${(J * ct / cp).toFixed(4)}\n`;
		}
		fs.writeFileSync(path.join(data, `synth_5x4.3_${rpm}rd.txt`), d);
	}
	const res = analyse(dir);
	fs.rmSync(dir, { recursive: true, force: true });
	if (res.length !== 1) {
		console.error(`uiuc-prop-validate --selftest: expected 1 propeller, got ${res.length}`);
		process.exit(1);
	}
	const r = res[0];
	if (!(r.points >= 30 && r.ct < 1e-3 && r.cp < 1e-3)) {
		console.error(`uiuc-prop-validate --selftest: round trip not exact — ${JSON.stringify(r)}`);
		process.exit(1);
	}
	console.log(`uiuc-prop-validate --selftest : round trip exact over ${r.points} points`);
}

// ---------------------------------------------------------------------------

if (process.argv.includes('--selftest')) {
	roundTrip();
	process.exit(0);
}

const root = process.argv[2]
	?? process.env.UIUC_PROP_DB
	?? path.join(process.cwd(), '.data', 'UIUC-propDB');

if (!fs.existsSync(root)) {
	// Loud skip, not a failure: the pattern tools/entry-state-selftest.mjs sets
	// for a check that needs data the repository does not carry.
	console.log('uiuc-prop-validate: SKIPPED — no propeller database found.');
	console.log(`  looked in: ${root}`);
	console.log('  get it:    https://m-selig.ae.illinois.edu/props/download/UIUC-propDB.zip');
	console.log('  then:      node tools/uiuc-prop-validate.mjs <path-to-unzipped-dir>');
	console.log('             (or set UIUC_PROP_DB, or unzip into sim/.data/)');
	process.exit(0);
}

const results = analyse(root);
if (!results.length) {
	console.log('uiuc-prop-validate: SKIPPED — database found but no usable propeller in it.');
	console.log(`  looked in: ${root}`);
	process.exit(0);
}

results.sort((a, b) => a.ct - b.ct);
console.log(`uiuc-prop-validate: ${results.length} propellers, calibrated on ONE static point each,`);
console.log('then predicting the whole advance-ratio sweep.\n');
console.log('propeller             size      pts   mean CT err   mean CP err   worst CT');
for (const r of results) {
	console.log(
		`${r.name.padEnd(20)} ${`${r.d}x${r.pitch}`.padEnd(9)} ${String(r.points).padStart(4)}`
		+ `   ${(r.ct * 100).toFixed(1).padStart(9)}%   ${(r.cp * 100).toFixed(1).padStart(9)}%`
		+ `   ${(r.worst * 100).toFixed(0).padStart(5)}% ${r.worstAt}`,
	);
}
const meanCt = results.reduce((a, r) => a + r.ct, 0) / results.length;
const meanCp = results.reduce((a, r) => a + r.cp, 0) / results.length;
console.log(`\nacross all ${results.length}: CT ${(meanCt * 100).toFixed(1)}%, CP ${(meanCp * 100).toFixed(1)}%`);

console.log('\nAgainst advance ratio. The SIGNED column is the one to read: scatter');
console.log('averages towards zero there, so a signed error that tracks J and keeps');
console.log('its sign is a missing term, not noise.\n');
console.log('J           pts    |err CT|    signed    |err CP|    signed');
for (const b of results.bins) {
	if (!b.n) continue;
	const pc = (v) => `${((100 * v) / b.n).toFixed(1).padStart(8)}%`;
	console.log(`${b.lo.toFixed(1)}-${b.hi.toFixed(1)} ${String(b.n).padStart(7)}  ${pc(b.absCt)} ${pc(b.signedCt)}  ${pc(b.absCp)} ${pc(b.signedCp)}`);
}

console.log('\nFor reference: blade-element momentum theory with a generic aerofoil is');
console.log('usually quoted at 10-20% on CT for props this small, and worse on CP,');
console.log('where Reynolds number is low and published polars stop applying. Under');
console.log('that is the model working. Well over it is the model being wrong, and');
console.log('the shape of the error against J says where.');
console.log('\nNote on the tail. The relative error grows with J because CT itself goes');
console.log('to zero: the same absolute miss is 5% at J=0.1 and 200% one point before');
console.log('the thrust-zero knee. That is why the signed column, not the magnitude,');
console.log('is what a defect shows up in.');
