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

export function generateTargetScan({ seed, count } = {}) {
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

	return { seed, count: n, candidates };
}

// Fiche pré-hack (Bible §15/§22). NE CONTIENT JAMAIS _family : on n'affiche que
// ce qui est réellement connu avant le vol.
export function describeTarget(candidate) {
	const known = candidate.mode !== 'UNKNOWN';
	return {
		location: 'KNOWN',
		signal: `${candidate.rssiDbm} dBm`,
		device: 'PARTIAL',
		deviceHint: candidate._classHint,   // EST. — le bucket, pas la famille
		video: known ? candidate.mode : 'PARTIAL',
		videoHint: known ? null : candidate._videoHint,
		control: 'UNKNOWN',
		flightState: 'UNKNOWN',
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
		signal: { rssiDbm: c.rssiDbm, mode: c._videoHint },
		scannedAt: new Date().toISOString(),
		intel: {
			location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL',
			video: 'EST.', control: 'UNKNOWN', flightState: 'UNKNOWN',
		},
	};
}
