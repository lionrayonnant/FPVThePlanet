import {
	generateTargetScan, describeTarget, resolveTarget,
	FAMILY_CLASS, TARGET_FAMILIES, HACK_TYPES,
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
			// La fiche reprend le mode mesuré, et UNKNOWN reste UNKNOWN : plus
			// d'état intermédiaire qui laisserait passer la réponse.
			check(`describeTarget(${seed}/${cand.id}) video cohérent`,
				JSON.parse(sheet).video === cand.mode);
			// Et surtout : quand le mode n'est pas mesuré, le VRAI mode ne doit
			// apparaître nulle part sur la fiche. Un « EST. » toujours juste sur
			// une valeur binaire est la valeur (issue #45 : UNKNOWN doit être une
			// véritable inconnue).
			if (cand.mode === 'UNKNOWN') {
				check(`describeTarget(${seed}/${cand.id}) ne fuite pas le vrai mode vidéo`,
					!sheet.includes(cand._videoHint), sheet);
			}
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

{
	const scan = generateTargetScan({ seed: 'scan-kept', count: 4 });
	const t = resolveTarget(scan, 2);
	check('resolveTarget porte scan.seed', t.scan?.seed === 'scan-kept');
	check('resolveTarget porte scan.count', t.scan?.count === 4);
	check('resolveTarget porte scan.index', t.scan?.index === 2);
	check('buildSeed dérive de scan', t.buildSeed === `${t.scan.seed}::${t.scan.index}`);
}

// --- hackType : propriété de cible (PHASE 09)
{
	check('HACK_TYPES : 6 familles, ordre Bible §17',
		HACK_TYPES.join('|') === 'COMMAND INJECTION|LINK HIJACK|TELEMETRY SPOOF|GNSS SPOOF|NETWORK TAKEOVER|FIRMWARE OVERRIDE');

	const a = generateTargetScan({ seed: 'hack-det', count: 5 });
	const b = generateTargetScan({ seed: 'hack-det', count: 5 });
	check('_hackType déterministe par graine',
		a.candidates.map((c) => c._hackType).join(',') === b.candidates.map((c) => c._hackType).join(','));
	check('_hackType toujours dans HACK_TYPES',
		a.candidates.every((c) => HACK_TYPES.includes(c._hackType)));

	// describeTarget ne fuite jamais le hackType
	for (const cand of a.candidates) {
		check(`describeTarget(${cand.id}) sans _hackType`,
			!JSON.stringify(describeTarget(cand)).includes(cand._hackType));
	}

	// resolveTarget porte le hackType du candidat choisi
	const t = resolveTarget(a, 2);
	check('resolveTarget : hackType repris du candidat',
		t.hackType === a.candidates[2]._hackType && HACK_TYPES.includes(t.hackType));

	// indépendance famille × hackType : sur 250 graines, chaque hackType
	// apparaît avec au moins 4 familles distinctes (pas de couplage fort)
	const pairs = new Map(HACK_TYPES.map((h) => [h, new Set()]));
	// distribution : chaque hackType entre 8 % et 25 % des tirages
	const counts = new Map(HACK_TYPES.map((h) => [h, 0]));
	let total = 0;
	for (let i = 0; i < 250; i++) {
		for (const c of generateTargetScan({ seed: `dist-${i}`, count: 5 }).candidates) {
			pairs.get(c._hackType).add(c._family);
			counts.set(c._hackType, counts.get(c._hackType) + 1);
			total++;
		}
	}
	check('hackType × famille : pas de couplage fort',
		[...pairs.values()].every((set) => set.size >= 4),
		[...pairs.entries()].map(([h, s]) => `${h}:${s.size}`).join(' '));
	check('hackType : distribution ~uniforme (8–25 %)',
		[...counts.values()].every((n) => n / total >= 0.08 && n / total <= 0.25),
		[...counts.values()].map((n) => (100 * n / total).toFixed(0)).join(' '));
}

// --- garde-fou de dérive
check('FAMILY_CLASS couvre exactement FAMILIES',
	TARGET_FAMILIES.slice().sort().join(',') === FAMILIES.slice().sort().join(','),
	`${TARGET_FAMILIES.join(' ')} vs ${FAMILIES.join(' ')}`);

console.log(`\n${pass} tests target OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
