// Signaux candidats d'un TARGET SCAN (PHASE 08). Logique pure, AUCUNE
// dépendance : importée par le plugin de dev, le selftest et (via un bundle
// Vite) le client. Le serveur régénère la même sortie depuis la même graine,
// c'est ce qui rend le choix du joueur non falsifiable.
//
//   terrain persistent, flights ephemeral — une cible appartient à une session.

// FAMILY_CLASS : donnée stable, dupliquée ici pour garder le modèle sans
// dépendance. Le selftest vérifie que ses clés collent à src/drone-profiles.js.
// La valeur est le bucket grossier montré en EST. avant le hack — jamais la
// famille exacte.
export const FAMILY_CLASS = {
	freestyle5: '5"',
	race5: '5"',
	cinewhoop: 'CINEWHOOP',
	longrange: 'LONG RANGE',
	heavy5: '5"',
	toothpick: 'MICRO',
};
export const TARGET_FAMILIES = Object.keys(FAMILY_CLASS);

// HACK_TYPES : les six familles de hacking (PHASE 09, Bible §17). Ordre stable.
// Le type de hack est une propriété de la cible, tirée à la génération ; il ne
// détermine PAS la difficulté du vol (entry state indépendant, PHASE 11).
// Concepts documentés et crédibles ; l'interaction est une abstraction (spec
// PHASE 09, règle de sécurité).
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

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même géné que
// src/link.js : petit, déterministe, rejouable).
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

// `swarmChance` is the probability that this scan carries a cluster; `swarmAt`
// short-circuits the draw entirely (an index, or `null` for "no cluster"). A
// session persists both, which is what makes the ambient regeneration exact.
export function generateTargetScan({ seed, count, swarmChance = SWARM_CHANCE, swarmAt } = {}) {
	if (!seed) throw new Error('seed requis');
	const n = clampCount(count);
	const rand = rngFrom(`${seed}::scan`);

	const raw = [];
	for (let i = 0; i < n; i++) {
		const family = pick(rand, TARGET_FAMILIES);
		const videoHint = pick(rand, MODES);
		// -52..-72 dBm : un signal exploitable, jamais parfait (§6). Le tri se
		// fait après, l'ordre de génération n'a pas d'importance.
		const rssiDbm = -52 - Math.round(rand() * 20);
		// ~50 % des signaux révèlent leur mode, le reste reste UNKNOWN.
		const mode = rand() < 0.5 ? videoHint : 'UNKNOWN';
		// Tirage dédié, après `mode`, pour ne pas décaler les tirages RSSI/mode
		// d'une graine déjà utilisée. Indépendant de la famille et du signal.
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

	return { seed, count: n, candidates, swarmAt: at, swarmChance: chance };
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

// Fiche pré-hack (Bible §15/§22). NE CONTIENT JAMAIS _family : on n'affiche que
// ce qui est réellement connu avant le vol.
//
// Trois niveaux et rien d'autre (issue #45) : KNOWN réellement mesuré, EST.
// déduction, UNKNOWN véritable inconnue. Un EST. n'est légitime que s'il DÉDUIT
// sans donner la réponse — c'est le cas de deviceHint, un bucket grossier ('5"'
// couvre trois familles) qui resserre le champ sans le fermer.
//
// Le mode vidéo n'a PAS d'EST. possible : il est binaire. Un « EST. DIGITAL »
// toujours juste EST la valeur, quel que soit le mot devant — les trois niveaux
// s'effondrent alors à deux et on révèle avant le vol ce qu'on est censé
// découvrir à la première image. Quand il n'est pas mesuré il est donc UNKNOWN,
// nu, comme dans l'exemple de fiche de la Bible. Le vrai mode arrive par
// resolveTarget() et se découvre quand le retour vidéo s'allume.
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
		// EST. — le bucket, pas la famille. 'MESH — MULTIPLE EMITTERS' for a
		// cluster: it tightens the field without closing it, like any other bucket.
		deviceHint: swarm ? `${SWARM_CLASS_HINT} — MULTIPLE EMITTERS` : candidate._classHint,
		video: known ? candidate.mode : 'UNKNOWN',
		control: 'UNKNOWN',
		flightState: 'UNKNOWN',
		...(swarm ? { count: 'UNKNOWN' } : {}),
	};
}

// Descripteur persisté sur la session. Le serveur l'obtient en régénérant le
// scan puis en appelant ceci — le client n'envoie qu'un index.
export function resolveTarget(scan, index) {
	const c = scan.candidates[index];
	if (!c) throw new RangeError(`index de cible hors borne : ${index}`);
	return {
		family: c._family,
		classHint: c._classHint,
		hackType: c._hackType,
		// The swarm the node commands (issue #29). `null` on every ordinary
		// target — most of them.
		swarm: c._swarm ? { size: c._swarm.size, doctrineSeed: c._swarm.doctrineSeed } : null,
		// Graine de l'EXEMPLAIRE (PHASE 07, tools/target-build.mjs). Dérivée du
		// scan et de l'index, donc reproductible par le serveur comme par le
		// client, et relue telle quelle du disque : le drone détourné hier est
		// le même aujourd'hui. Distincte de l'id de session, qui n'existe pas
		// encore au moment où le FlightController doit être construit.
		buildSeed: `${scan.seed}::${index}`,
		// Le scan lui-même (issue #250) : ce qu'il faut pour REGÉNÉRER les
		// candidats non pris — les drones ambiants — et pour
		// reconstruire buildSeed côté client sans le stocker deux fois.
		// `swarmAt`/`swarmChance` travel with the scan (issue #29): they are what
		// makes the ambient regeneration exact — without them a replay would
		// redraw the cluster on today's default chance instead of the session's.
		scan: {
			seed: String(scan.seed), count: scan.candidates.length, index,
			swarmAt: scan.swarmAt ?? null,
			swarmChance: Number.isFinite(scan.swarmChance) ? scan.swarmChance : SWARM_CHANCE,
		},
		signal: { rssiDbm: c.rssiDbm, mode: c._videoHint },
		scannedAt: new Date().toISOString(),
		// Ce que le joueur savait AU MOMENT DE CHOISIR, pas ce qui est vrai :
		// l'archive relit ce bloc pour dire ce que valait la fiche avant le vol.
		// `video` suit donc la fiche — mesuré ou pas — au lieu d'être figé.
		intel: {
			location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL',
			video: c.mode === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
			control: 'UNKNOWN', flightState: 'UNKNOWN',
		},
	};
}
