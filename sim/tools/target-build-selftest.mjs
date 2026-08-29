// Vérifie tools/target-build.mjs sans Rapier : déterminisme, bornes, cohérence
// physique du tirage et invariants de famille.
//
// Ce qui demande un vrai pas de physique — « tout exemplaire tient encore son
// taux commandé sur le tune de sa famille » — est dans tools/selftest.mjs, qui
// a une scène et un monde Rapier sous la main.

import {
	targetBuild, BUILD_BOUNDS, INVARIANTS, thrustToWeight,
	FAMILY_VARIATION, DEFAULT_VARIATION,
} from './target-build.mjs';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { RATE_PRESETS } from '../src/flightController.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`); }
	else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const N = 500;
const seeds = Array.from({ length: N }, (_, i) => `build-${i}`);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const within = (v, [lo, hi]) => v >= lo - 1e-9 && v <= hi + 1e-9;

// --- déterminisme
{
	const a = targetBuild({ seed: 'kyiv-podil-9f2a::02', family: 'race5' });
	const b = targetBuild({ seed: 'kyiv-podil-9f2a::02', family: 'race5' });
	check('même graine → même exemplaire', JSON.stringify(a) === JSON.stringify(b));
	const c = targetBuild({ seed: 'kyiv-podil-9f2a::03', family: 'race5' });
	check('graine différente → exemplaire différent', JSON.stringify(a) !== JSON.stringify(c));
	// La famille fait partie du flux : le même index sur deux familles ne doit
	// pas rejouer exactement les mêmes tirages.
	const d = targetBuild({ seed: 'kyiv-podil-9f2a::02', family: 'heavy5' });
	check('la famille entre dans la graine',
		!near(a.profile.mass / PROFILES.race5.mass, d.profile.mass / PROFILES.heavy5.mass));

	let threw = false;
	try { targetBuild({ family: 'race5' }); } catch { threw = true; }
	check('graine absente → throw', threw);
	check('famille inconnue → profil par défaut',
		targetBuild({ seed: 'x', family: 'nope' }).family === 'freestyle5');
}

// --- invariants de famille : l'interdit de l'issue #44
for (const fam of FAMILIES) {
	const base = PROFILES[fam];
	let bad = '';
	for (const seed of seeds) {
		const { profile } = targetBuild({ seed, family: fam });
		for (const key of INVARIANTS) {
			if (profile[key] !== base[key]) { bad = `${seed}: ${key}`; break; }
		}
		if (profile.battery.cells !== base.battery.cells) bad ||= `${seed}: battery.cells`;
		if (profile.battery.maxCurrent !== base.battery.maxCurrent) bad ||= `${seed}: battery.maxCurrent`;
		// Le tune mesuré, à la valeur près.
		if (JSON.stringify(profile.pid) !== JSON.stringify(base.pid)) bad ||= `${seed}: pid`;
		if (bad) break;
	}
	check(`[${fam}] identité de famille intacte sur ${N} tirages`, !bad, bad);
}

// --- bornes du tirage
for (const fam of FAMILIES) {
	const base = PROFILES[fam];
	const out = [];
	for (const seed of seeds) {
		const { profile, rates } = targetBuild({ seed, family: fam });
		const massK = profile.mass / base.mass;
		if (!within(massK, BUILD_BOUNDS.mass)) out.push(`mass ${massK.toFixed(3)}`);

		const kv = profile.maxOmega / base.maxOmega;
		if (!within(kv, BUILD_BOUNDS.kv)) out.push(`kv ${kv.toFixed(3)}`);

		// Cohérence hélice : à hélice constante la poussée va en ω², donc le
		// coefficient de poussée de quad.js doit être rigoureusement invariant.
		const ct = profile.maxThrustPerMotor / (profile.maxOmega * profile.maxOmega);
		const ct0 = base.maxThrustPerMotor / (base.maxOmega * base.maxOmega);
		if (!near(ct, ct0, 1e-12)) out.push(`Ct ${ct} vs ${ct0}`);

		// L'inertie suit la masse, à la répartition près.
		for (const ax of ['x', 'y', 'z']) {
			const spread = (profile.inertia[ax] / base.inertia[ax]) / massK;
			if (!within(spread, BUILD_BOUNDS.inertiaSpread)) out.push(`inertia.${ax} ${spread.toFixed(3)}`);
		}

		const cap = profile.battery.capacityMah / base.battery.capacityMah;
		if (!within(cap, BUILD_BOUNDS.capacity)) out.push(`capacity ${cap.toFixed(3)}`);
		const ohm = profile.battery.internalOhm / base.battery.internalOhm;
		if (!within(ohm, BUILD_BOUNDS.internalOhm)) out.push(`ohm ${ohm.toFixed(3)}`);

		// Un pack ne rajeunit jamais : la résistance interne ne descend pas sous
		// celle du neuf.
		if (profile.battery.internalOhm < base.battery.internalOhm - 1e-12) out.push('pack rajeuni');

		const preset = RATE_PRESETS[base.rates];
		for (const ax of ['roll', 'pitch', 'yaw']) {
			const k = rates[ax].max / preset[ax].max;
			const lo = BUILD_BOUNDS.rate[0] * BUILD_BOUNDS.rateAxis[0];
			const hi = BUILD_BOUNDS.rate[1] * BUILD_BOUNDS.rateAxis[1];
			if (!within(k, [lo, hi])) out.push(`rate.${ax} ${k.toFixed(3)}`);
			// centre et max bougent ensemble : la courbe garde sa forme.
			if (!near(rates[ax].centre / preset[ax].centre, k, 1e-9)) out.push(`centre.${ax} désolidarisé`);
			if (rates[ax].centre > rates[ax].max) out.push(`centre.${ax} > max`);
			if (rates[ax].expo < 0 || rates[ax].expo > 0.9) out.push(`expo.${ax} ${rates[ax].expo}`);
		}
		if (out.length) break;
	}
	check(`[${fam}] tirage dans les bornes sur ${N} tirages`, out.length === 0, out.slice(0, 3).join(' · '));
}

// --- la variation est réellement perceptible, et bornée
for (const fam of FAMILIES) {
	const base = PROFILES[fam];
	const twr0 = thrustToWeight(base);
	const varies = (FAMILY_VARIATION[fam] ?? DEFAULT_VARIATION) > 0;
	let lo = Infinity, hi = -Infinity, loM = Infinity, hiM = -Infinity;
	for (const seed of seeds) {
		const { profile } = targetBuild({ seed, family: fam });
		const t = thrustToWeight(profile);
		lo = Math.min(lo, t); hi = Math.max(hi, t);
		loM = Math.min(loM, profile.mass); hiM = Math.max(hiM, profile.mass);
	}
	// Bornée : la masse et la poussée restent couplées, rien ne s'échappe.
	check(`[${fam}] poussée/poids reste dans [0.75, 1.35] × nominal`,
		lo >= twr0 * 0.75 && hi <= twr0 * 1.35,
		`${lo.toFixed(2)}..${hi.toFixed(2)} pour ${twr0.toFixed(2)} nominal`);
	// Perceptible : deux exemplaires de la même famille doivent pouvoir différer
	// d'assez pour se sentir au manche. 15 % d'écart de masse, c'est un pack de
	// plus ou de moins. Une famille à variation nulle (MICRO — voir le
	// commentaire de FAMILY_VARIATION, son bouclage n'a plus de marge
	// d'overshoot) doit au contraire rendre le nominal À LA VALEUR PRÈS : c'est
	// le garde-fou qui empêche de lui rouvrir la variation sans re-mesurer.
	if (varies) {
		check(`[${fam}] deux exemplaires diffèrent de façon perceptible`,
			hiM / loM > 1.15 && hi / lo > 1.15,
			`masse ×${(hiM / loM).toFixed(2)}, TWR ×${(hi / lo).toFixed(2)}`);
	} else {
		check(`[${fam}] variation nulle → exemplaire = nominal exact`,
			loM === base.mass && hiM === base.mass && lo === twr0 && hi === twr0,
			`masse ${loM}..${hiM} pour ${base.mass}`);
	}
}

// --- variation nulle : rien du tout ne bouge
{
	for (const fam of FAMILIES) {
		if ((FAMILY_VARIATION[fam] ?? DEFAULT_VARIATION) > 0) continue;
		const base = PROFILES[fam];
		let bad = '';
		for (const seed of seeds) {
			const { profile, rates } = targetBuild({ seed, family: fam });
			if (JSON.stringify(profile) !== JSON.stringify(base)) bad ||= `${seed}: profil`;
			const preset = RATE_PRESETS[base.rates];
			for (const ax of ['roll', 'pitch', 'yaw']) {
				if (rates[ax].max !== preset[ax].max) bad ||= `${seed}: rates.${ax}.max`;
				if (rates[ax].centre !== preset[ax].centre) bad ||= `${seed}: rates.${ax}.centre`;
				if (rates[ax].expo !== preset[ax].expo) bad ||= `${seed}: rates.${ax}.expo`;
			}
			if (bad) break;
		}
		check(`[${fam}] variation nulle : profil ET rates strictement nominaux`, !bad, bad);
	}
}

// --- la variation ne remplace pas la famille : à tirage égal, l'écart entre
// deux familles reste plus grand que l'écart interne à une famille sur les
// axes qui DÉFINISSENT la famille (hélice, cellules, preset de rates).
{
	let bad = '';
	for (const fam of FAMILIES) {
		const base = PROFILES[fam];
		for (const seed of seeds.slice(0, 60)) {
			const { profile, rates } = targetBuild({ seed, family: fam });
			const other = FAMILIES.find((f) => f !== fam && PROFILES[f].propRadius !== base.propRadius);
			if (profile.propRadius === PROFILES[other].propRadius) bad ||= `${fam}/${seed}: hélice`;
			if (rates.label !== RATE_PRESETS[base.rates].label) bad ||= `${fam}/${seed}: preset`;
		}
	}
	check('hélice, cellules et preset restent ceux de la famille', !bad, bad);
}

// --- garde-fou de dérive : les bornes documentées sont bien celles utilisées
check('BUILD_BOUNDS : toutes les plages sont ordonnées',
	Object.values(BUILD_BOUNDS).every(([lo, hi]) => lo <= hi));
check('INVARIANTS : tous présents sur la famille de référence',
	INVARIANTS.every((k) => k === 'filterScale' || PROFILES.freestyle5[k] !== undefined),
	INVARIANTS.filter((k) => k !== 'filterScale' && PROFILES.freestyle5[k] === undefined).join(' '));

console.log(`\n${pass} tests target-build OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
