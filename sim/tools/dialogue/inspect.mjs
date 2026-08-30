// Outil de relecture humaine du corpus (PHASE 21). OUTIL DE DÉVELOPPEMENT :
// rien sous src/ ne doit importer ce fichier, et le selftest le vérifie.
//
//   node tools/dialogue/inspect.mjs --event ACQUIRE_AREA [--count 30] [--rarity RARE] [--character jensen]
//
// Politique de relecture : RARE, VERY_RARE et jensen se relisent en entier ;
// le reste se relit par échantillon de 10 %. --count force la taille du tirage.
import { readFileSync } from 'node:fs';
import { EVENTS } from './catalog.mjs';
import { render } from './render.mjs';

// Contexte factice COMPLET : tous les chemins de tous les slots du catalogue
// sont renseignés, pour qu'aucune entrée ne soit jamais « non rendable »
// faute de contexte — la relecture porte sur le ton, pas sur l'éligibilité.
const FAKE_CTX = {
	area: { name: 'sample sector' },
	operator: { name: 'raven' },
	weather: { summary: 'clear', windMs: 6.4, rain: 'none', visibility: 'good' },
	drone: { label: 'cinewhoop' },
	target: { video: 'analog', rssiDbm: -58, hackType: 'passive' },
	scan: { count: 4 },
	terrain: { tiles: 842, megabytes: 310 },
	session: { durationS: 720 },
	machine: { gpu: 'sample gpu', display: 'sample display' },
};

function args() {
	const a = {};
	for (let i = 2; i < process.argv.length; i++) {
		const k = process.argv[i];
		if (k.startsWith('--')) a[k.slice(2)] = process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i];
	}
	return a;
}

const shardPath = (event) => new URL(`../../public/dialogue/${EVENTS[event].shard}.json`, import.meta.url);

const loadShard = (event) => JSON.parse(readFileSync(shardPath(event), 'utf8'));

// Tirage sans remise (Fisher-Yates partiel).
function sample(arr, n) {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy.slice(0, n);
}

const FULL_REVIEW_RARITIES = new Set(['RARE', 'VERY_RARE']);

function main() {
	const a = args();
	const event = a.event;
	if (!EVENTS[event]) throw new Error(`--event manquant ou inconnu (${event})`);

	const shard = loadShard(event);
	let pool = shard.entries;
	if (a.rarity) pool = pool.filter((e) => e.rarity === a.rarity);
	if (a.character) pool = pool.filter((e) => e.characters?.includes(a.character));

	// jensen et les raretés RARE/VERY_RARE se relisent en entier ; le reste par
	// échantillon de 10 %, sauf si --count force une taille précise.
	const fullReview = FULL_REVIEW_RARITIES.has(a.rarity) || a.character === 'jensen';
	const wanted = a.count ? Number(a.count) : (fullReview ? pool.length : Math.max(1, Math.ceil(pool.length * 0.1)));
	const picked = a.count || !fullReview ? sample(pool, Math.min(wanted, pool.length)) : pool;

	console.log(`${picked.length} / ${pool.length} entrées (${fullReview ? 'relecture complète' : 'échantillon 10 %'})\n`);

	for (const entry of picked) {
		let lines;
		try {
			lines = render(entry, FAKE_CTX);
		} catch (e) {
			console.log(`[${entry.id}] ERREUR DE RENDU : ${e.message}\n`);
			continue;
		}
		console.log(`[${entry.id}] ${entry.rarity} — ${entry.characters.join('+')}`);
		for (const l of lines) console.log(`  ${l.speaker}: ${l.text}`);
		console.log('');
	}
}

main();
