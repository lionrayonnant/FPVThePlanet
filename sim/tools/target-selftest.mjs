import {
	generateTargetScan, describeTarget, resolveTarget, swarmChanceFor,
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

// --- l'essaim (issue #29)

// Graines témoin, figées AVANT que l'essaim existe : c'est la non-régression
// qui compte le plus. Le tirage du cluster vit sur un flux séparé (`::swarm`)
// et ne doit jamais consommer celui de la boucle des candidats — à
// swarmChance = 0 la sortie doit rester identique, graine par graine.
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
		check(`swarmChance 0 : candidats inchangés (${seed})`,
			JSON.stringify(scan.candidates) === frozen,
			JSON.stringify(scan.candidates));
		check(`swarmChance 0 : aucun cluster (${seed})`,
			scan.swarmAt === null && scan.candidates.every((c) => !c._swarm));
	}
	// Et sur 300 graines de plus, pas seulement les témoins.
	let drift = 0;
	for (let i = 0; i < 300; i++) {
		const a = generateTargetScan({ seed: `nr-${i}`, count: 5, swarmChance: 0 });
		if (a.swarmAt !== null) drift++;
	}
	check('swarmChance 0 : jamais de cluster sur 300 graines', drift === 0, `${drift}`);
}

{
	const scan = generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 1 });
	const c = scan.candidates[0];
	check('swarmChance 1 : cluster présent', scan.swarmAt === 0);
	check('cluster : index 0, donc le plus fort RSSI',
		scan.candidates.every((x, i) => i === 0 || x.rssiDbm <= c.rssiDbm));
	check('cluster : famille swarmNode', c._family === SWARM_FAMILY);
	check('cluster : classHint MESH écrit en dur', c._classHint === SWARM_CLASS_HINT);
	check('cluster : hackType NETWORK TAKEOVER forcé', c._hackType === SWARM_HACK_TYPE);
	check('cluster : size entier dans 6..12',
		Number.isInteger(c._swarm.size) && c._swarm.size >= SWARM_SIZE_MIN && c._swarm.size <= SWARM_SIZE_MAX,
		`${c._swarm.size}`);
	check('cluster : doctrineSeed déterministe et non vide',
		typeof c._swarm.doctrineSeed === 'string' && c._swarm.doctrineSeed.length > 0
		&& c._swarm.doctrineSeed === generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 1 }).candidates[0]._swarm.doctrineSeed);
	check('cluster : les AUTRES candidats sont ceux de swarmChance 0',
		JSON.stringify(scan.candidates.slice(1))
		=== JSON.stringify(generateTargetScan({ seed: 'swarm-one', count: 4, swarmChance: 0 }).candidates.slice(1)));
	check('swarmChance : la valeur utilisée revient avec le scan', scan.swarmChance === 1);
	// swarmNode n'entre PAS dans le bucket public : le scan ne doit jamais
	// pouvoir la tirer par la boucle ordinaire.
	check('swarmNode hors TARGET_FAMILIES/FAMILY_CLASS',
		!TARGET_FAMILIES.includes(SWARM_FAMILY) && !(SWARM_FAMILY in FAMILY_CLASS));
}

{
	// swarmAt court-circuite le tirage, dans les deux sens.
	const forced = generateTargetScan({ seed: 'swarm-at', count: 4, swarmChance: 0, swarmAt: 2 });
	check('swarmAt : impose un cluster malgré swarmChance 0',
		forced.swarmAt === 2 && forced.candidates[2]._family === SWARM_FAMILY);
	const none = generateTargetScan({ seed: 'swarm-at', count: 4, swarmChance: 1, swarmAt: null });
	check('swarmAt null : pas de cluster malgré swarmChance 1',
		none.swarmAt === null && none.candidates.every((c) => !c._swarm));
	// Le rejeu : même size et même doctrine que le tirage d'origine, sinon la
	// régénération des ambiants et celle du serveur divergeraient.
	const drawn = generateTargetScan({ seed: 'swarm-replay', count: 4, swarmChance: 1 });
	const replay = generateTargetScan({ seed: 'swarm-replay', count: 4, swarmChance: 0, swarmAt: drawn.swarmAt });
	check('swarmAt : le rejeu rend le MÊME essaim',
		JSON.stringify(drawn.candidates) === JSON.stringify(replay.candidates));
	let threw = 0;
	for (const bad of [4, -1, 1.5, '0']) {
		try { generateTargetScan({ seed: 'x', count: 4, swarmAt: bad }); } catch { threw++; }
	}
	check('swarmAt hors borne → throw', threw === 4, `${threw}/4`);
	let chanceThrew = 0;
	for (const bad of [-0.1, 1.1, NaN, 'x']) {
		try { generateTargetScan({ seed: 'x', count: 4, swarmChance: bad }); } catch { chanceThrew++; }
	}
	check('swarmChance hors [0,1] → throw', chanceThrew === 4, `${chanceThrew}/4`);
}

{
	// Fréquence : ~10 % sur un grand nombre de graines, avec la chance par
	// défaut. C'est la rareté visée, pas une valeur arbitraire.
	let hits = 0;
	const N = 2000;
	for (let i = 0; i < N; i++) if (generateTargetScan({ seed: `freq-${i}`, count: 4 }).swarmAt !== null) hits++;
	check('SWARM_CHANCE : ~10 % des scans portent un cluster',
		Math.abs(hits / N - SWARM_CHANCE) < 0.03, `${(100 * hits / N).toFixed(1)} %`);
}

{
	// La garantie précoce : le 3e scan est certain si les deux premiers n'ont
	// rien donné.
	const plain = { target: { swarm: null } };
	const cluster = { target: { swarm: { size: 8, doctrineSeed: 'd' } } };
	check('garantie : 1er scan → chance nominale', swarmChanceFor([]) === SWARM_CHANCE);
	check('garantie : 2e scan → chance nominale', swarmChanceFor([plain]) === SWARM_CHANCE);
	check('garantie : 3e scan sans essaim → certain', swarmChanceFor([plain, plain]) === 1);
	check('garantie : 3e scan après un essaim → chance nominale',
		swarmChanceFor([cluster, plain]) === SWARM_CHANCE);
	check('garantie : 4e scan → chance nominale',
		swarmChanceFor([plain, plain, plain]) === SWARM_CHANCE);
	// Une session ouverte sans cible (chemin dev) n'est pas un scan.
	check('garantie : une session sans cible ne compte pas',
		swarmChanceFor([plain, { target: null }, plain]) === 1);
	check('garantie : état absent → chance nominale',
		swarmChanceFor(undefined) === SWARM_CHANCE && swarmChanceFor(null) === SWARM_CHANCE);
}

{
	// La fiche d'un cluster : le joueur sait que c'est un groupe, et rien de plus.
	const scan = generateTargetScan({ seed: 'swarm-sheet', count: 4, swarmChance: 1 });
	const c = scan.candidates[0];
	const sheet = describeTarget(c);
	const flat = JSON.stringify(sheet);
	check('fiche cluster : DEVICE dit MESH — MULTIPLE EMITTERS',
		sheet.deviceHint === 'MESH — MULTIPLE EMITTERS', sheet.deviceHint);
	check('fiche cluster : SIGNAL dit STRONGEST OF GROUP',
		sheet.signal === `${c.rssiDbm} dBm (STRONGEST OF GROUP)`, sheet.signal);
	check('fiche cluster : COUNT UNKNOWN', sheet.count === 'UNKNOWN');
	check('fiche cluster : ne fuite pas la famille', !flat.includes(SWARM_FAMILY), flat);
	// Le RSSI est le seul nombre légitime de la fiche : si aucun autre champ ne
	// porte de chiffre, la taille de l'essaim ne peut se cacher nulle part.
	const withoutSignal = { ...sheet };
	delete withoutSignal.signal;
	check('fiche cluster : aucun chiffre hors du RSSI',
		!/\d/.test(JSON.stringify(withoutSignal)), JSON.stringify(withoutSignal));
	check('fiche cluster : ne fuite pas la doctrine', !flat.includes(c._swarm.doctrineSeed));
	// Une cible ordinaire n'a PAS de ligne COUNT : il n'y a pas de groupe.
	check('fiche ordinaire : pas de COUNT',
		describeTarget(scan.candidates[1]).count === undefined);
}

{
	// resolveTarget persiste l'essaim et de quoi rejouer le scan à l'identique.
	const scan = generateTargetScan({ seed: 'swarm-resolve', count: 4, swarmChance: 1 });
	const t = resolveTarget(scan, 0);
	check('resolveTarget : swarm { size, doctrineSeed }',
		t.swarm?.size === scan.candidates[0]._swarm.size
		&& t.swarm?.doctrineSeed === scan.candidates[0]._swarm.doctrineSeed);
	check('resolveTarget : scan.swarmAt', t.scan.swarmAt === 0);
	check('resolveTarget : scan.swarmChance', t.scan.swarmChance === 1);
	check('resolveTarget : famille swarmNode', t.family === SWARM_FAMILY);
	check('resolveTarget : classHint MESH', t.classHint === SWARM_CLASS_HINT);
	const plain = resolveTarget(generateTargetScan({ seed: 'swarm-resolve', count: 4, swarmChance: 0 }), 0);
	check('resolveTarget : pas de cluster → swarm null', plain.swarm === null);
	check('resolveTarget : pas de cluster → swarmAt null', plain.scan.swarmAt === null);
}

// --- garde-fou de dérive
check('FAMILY_CLASS couvre exactement FAMILIES',
	TARGET_FAMILIES.slice().sort().join(',') === FAMILIES.slice().sort().join(','),
	`${TARGET_FAMILIES.join(' ')} vs ${FAMILIES.join(' ')}`);

console.log(`\n${pass} tests target OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
