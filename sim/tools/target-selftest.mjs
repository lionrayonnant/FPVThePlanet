import {
	generateTargetScan, describeTarget, resolveTarget,
	FAMILY_CLASS, TARGET_FAMILIES,
} from './target-model.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`); }
	else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- déterminisme
{
	const a = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	const b = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	check('même graine → mêmes candidats', JSON.stringify(a) === JSON.stringify(b));
	const c = generateTargetScan({ seed: 'kyiv-podil-0000', count: 4 });
	check('graine différente → candidats différents', JSON.stringify(a) !== JSON.stringify(c));
}

// --- count clampé et tri
{
	check('count par défaut = 4', generateTargetScan({ seed: 'x' }).candidates.length === 4);
	check('count clampé bas', generateTargetScan({ seed: 'x', count: 0 }).candidates.length === 2);
	check('count clampé haut', generateTargetScan({ seed: 'x', count: 99 }).candidates.length === 5);
	const s = generateTargetScan({ seed: 'sorted-check', count: 5 });
	const sorted = s.candidates.every((c, i) => i === 0 || s.candidates[i - 1].rssiDbm >= c.rssiDbm);
	check('candidats triés RSSI décroissant', sorted);
	check('ids séquentiels', s.candidates.map((c) => c.id).join(',') === '01,02,03,04,05');
	check('rssi dans une plage plausible',
		s.candidates.every((c) => c.rssiDbm <= -45 && c.rssiDbm >= -80));
}

// --- describeTarget ne fuit jamais la famille
{
	for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
		const scan = generateTargetScan({ seed, count: 5 });
		for (const cand of scan.candidates) {
			const sheet = JSON.stringify(describeTarget(cand));
			check(`describeTarget(${seed}/${cand.id}) sans _family`,
				!sheet.includes(cand._family), sheet.includes(cand._family) ? sheet : '');
			check(`describeTarget(${seed}/${cand.id}) video cohérent`,
				(cand.mode === 'UNKNOWN' && JSON.parse(sheet).video === 'PARTIAL')
				|| (cand.mode !== 'UNKNOWN' && JSON.parse(sheet).video === cand.mode));
		}
	}
}

// --- resolveTarget
{
	const scan = generateTargetScan({ seed: 'resolve', count: 4 });
	const t = resolveTarget(scan, 1);
	check('resolveTarget : famille connue', TARGET_FAMILIES.includes(t.family));
	check('resolveTarget : mode réel', ['ANALOG', 'DIGITAL'].includes(t.signal.mode));
	check('resolveTarget : rssi repris', t.signal.rssiDbm === scan.candidates[1].rssiDbm);
	check('resolveTarget : intel figé', t.intel.control === 'UNKNOWN' && t.intel.location === 'KNOWN');
	let threw = false;
	try { resolveTarget(scan, 9); } catch { threw = true; }
	check('resolveTarget : index hors borne → throw', threw);
}

// --- garde-fou de dérive
check('FAMILY_CLASS couvre exactement FAMILIES',
	TARGET_FAMILIES.slice().sort().join(',') === FAMILIES.slice().sort().join(','),
	`${TARGET_FAMILIES.join(' ')} vs ${FAMILIES.join(' ')}`);

console.log(`\n${pass} tests target OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
