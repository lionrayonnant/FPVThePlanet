// Atelier de génération du corpus (PHASE 21). OUTIL DE DÉVELOPPEMENT : rien
// sous src/ ne doit importer ce fichier, et le selftest le vérifie. Le jeu
// livré ne contient que des données.
//
//   node tools/dialogue/generate.mjs --event ACQUIRE_AREA --count 200
//     [--batch 20] [--rarity COMMON] [--model claude-opus-5] [--dry-run]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EVENTS } from './catalog.mjs';
import { validateEntry } from './validate.mjs';
import { findDuplicates } from './dedupe.mjs';

const MODEL = 'claude-opus-5';

// Un lot impose SA distribution de formes. C'est le levier principal contre
// l'effondrement stylistique : 200 entrées demandées d'un bloc convergent vers
// le même rythme, 10 lots de formes différentes non.
const FORMS = [
	'a single deadpan one-liner from one character',
	'a two-line exchange, question then flat answer',
	'a two-line exchange where the second line disagrees',
	'a three-line exchange that ends without resolution',
	'an observation nobody answers',
	'an interruption: one character cuts the other off',
	'a technical remark that is mundane, not clever',
	'a short disagreement about whether something is correct',
	'a rare cryptic remark that explains nothing',
];

function args() {
	const a = {};
	for (let i = 2; i < process.argv.length; i++) {
		const k = process.argv[i];
		if (k.startsWith('--')) a[k.slice(2)] = process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i];
	}
	return a;
}

// Le prompt passe par stdin : un lot dépasse les limites d'argument, et une
// erreur là-dessus est silencieuse et pénible à diagnostiquer.
function callModel(prompt, model = MODEL) {
	return new Promise((resolve, reject) => {
		const p = spawn('claude', ['-p', '--output-format', 'json', '--model', model]);
		let out = '', err = '';
		p.stdout.on('data', (d) => { out += d; });
		p.stderr.on('data', (d) => { err += d; });
		p.on('error', (e) => reject(new Error(`impossible de lancer claude : ${e.message}`)));
		p.on('close', (code) => {
			if (code !== 0) return reject(new Error(`claude a rendu ${code} : ${err.slice(0, 400)}`));
			let parsed;
			try { parsed = JSON.parse(out); } catch { return reject(new Error(`sortie illisible : ${out.slice(0, 400)}`)); }
			if (parsed.is_error) return reject(new Error(`claude en erreur : ${String(parsed.result).slice(0, 400)}`));
			resolve(String(parsed.result ?? ''));
		});
		p.stdin.end(prompt);
	});
}

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

const shardPath = (event) => new URL(`../../public/dialogue/${EVENTS[event].shard}.json`, import.meta.url);

function loadShard(event) {
	const path = shardPath(event);
	if (!existsSync(path)) return { event, entries: [] };
	return JSON.parse(readFileSync(path, 'utf8'));
}

// Le digest : les premières répliques déjà écrites pour cet événement. Assez
// pour que le modèle voie où il s'est déjà promené, assez court pour ne pas
// noyer le prompt.
const digest = (entries) => entries.slice(-160).map((e) => `- ${e.lines[0].text}`).join('\n');

function buildPrompt({ event, entries, rarity, forms, count }) {
	return [
		read('prompts/crew.md'),
		read('prompts/style.md'),
		read(`prompts/events/${EVENTS[event].shard}.md`),
		`\n# This batch\n`,
		`Write exactly ${count} dialogue entries for the event ${event}.`,
		`Every entry in this batch has rarity ${rarity}.`,
		`Use these shapes, one per entry, in order:\n${forms.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
		`\n# Already written for this event — do not go near these again\n${digest(entries) || '(nothing yet)'}`,
		`\n# Output\n`,
		'Reply with a JSON array and nothing else. No prose, no code fence.',
		'Each element: {"characters":[...],"requires":[...],"lines":[{"speaker":"...","text":"..."}]}',
		'`requires` lists the state paths of every slot used in the lines. If an entry uses no slot, `requires` is [].',
	].join('\n');
}

// Le modèle enrobe volontiers sa réponse. On récupère le premier tableau JSON.
function parseEntries(text) {
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start < 0 || end < 0) throw new Error(`aucun tableau JSON dans la réponse : ${text.slice(0, 300)}`);
	return JSON.parse(text.slice(start, end + 1));
}

async function main() {
	const a = args();
	const event = a.event;
	if (!EVENTS[event]) throw new Error(`--event manquant ou inconnu (${event})`);
	const total = Number(a.count ?? 100);
	const size = Number(a.batch ?? 20);
	const rarity = a.rarity ?? 'COMMON';
	const model = a.model ?? MODEL;

	const shard = loadShard(event);
	let seq = shard.entries.length;
	let kept = 0, rejected = 0;

	for (let done = 0; done < total; done += size) {
		const n = Math.min(size, total - done);
		const forms = Array.from({ length: n }, (_, i) => FORMS[(done + i) % FORMS.length]);
		const text = await callModel(buildPrompt({ event, entries: shard.entries, rarity, forms, count: n }), model);

		for (const raw of parseEntries(text)) {
			const entry = {
				id: `${EVENTS[event].shard}/${String(++seq).padStart(4, '0')}`,
				events: [event], rarity,
				characters: raw.characters, requires: raw.requires ?? [], lines: raw.lines,
			};
			const problems = validateEntry(entry);
			// Le premier problème suffit rarement à corriger le prompt : on les
			// rapporte tous, pas seulement le premier trouvé.
			if (problems.length) { rejected++; console.warn(`  rejet ${entry.id} : ${problems.join(' ; ')}`); continue; }
			shard.entries.push(entry);
			kept++;
		}
		console.log(`lot ${done / size + 1} : ${kept} gardées, ${rejected} rejetées`);
	}

	// Déduplication en dernier : une entrée peut être irréprochable et redite.
	const dups = findDuplicates(shard.entries, { threshold: 0.75 });
	const drop = new Set(dups.map((d) => d.b));
	shard.entries = shard.entries.filter((e) => !drop.has(e.id));
	console.log(`\n${kept} gardées, ${rejected} rejetées, ${drop.size} doublons écartés → ${shard.entries.length} au total`);

	// Le taux de rejet d'un lot dit quelque chose du PROMPT, pas des entrées :
	// au-delà de 5 %, on jette et on corrige le brief plutôt que de rapiécer.
	const rate = rejected / (kept + rejected || 1);
	if (rate > 0.05) console.warn(`\n⚠  taux de rejet ${(rate * 100).toFixed(1)} % — revoir prompts/events/${EVENTS[event].shard}.md avant de continuer`);

	if (a['dry-run']) { console.log('(--dry-run : rien écrit)'); return; }
	writeFileSync(shardPath(event), `${JSON.stringify(shard, null, 2)}\n`);
	console.log(`écrit : public/dialogue/${EVENTS[event].shard}.json`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
