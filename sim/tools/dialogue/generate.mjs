// Atelier de génération du corpus (PHASE 21). OUTIL DE DÉVELOPPEMENT : rien
// sous src/ ne doit importer ce fichier, et le selftest le vérifie. Le jeu
// livré ne contient que des données.
//
//   node tools/dialogue/generate.mjs --event ACQUIRE_AREA --count 200
//     [--batch 20] [--rarity COMMON] [--model claude-opus-5] [--dry-run]
//     [--backend claude|ollama] [--ollama-host http://127.0.0.1:11434]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EVENTS } from './catalog.mjs';
import { validateEntry } from './validate.mjs';
import { findDuplicates, seenLineSet, addLinesToSeen, repeatedLineIn } from './dedupe.mjs';

export const BACKENDS = ['claude', 'ollama'];
export const DEFAULT_BACKEND = 'claude';
export const DEFAULT_MODEL = { claude: 'claude-opus-5', ollama: 'batiai/qwen3.6-27b:q3' };
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
// Un lot local sur un GPU domestique peut prendre plusieurs minutes ; un
// timeout court transformerait un run normal en échec.
const OLLAMA_TIMEOUT_MS = 10 * 60 * 1000;

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

// La rareté n'est pas qu'un poids de tirage, c'est un registre d'écriture.
// Mesuré sur le premier corpus : sans instruction, le modèle ne fait varier
// que la longueur (VERY_RARE = COMMON en plus court), jamais le contenu.
// Chaque entrée dit à l'auteur CE QU'EST le palier, pas seulement son nom.
export const RARITY_GUIDANCE = {
	COMMON: 'This is the ordinary texture of a working channel: routine, procedural, unremarkable. Mundane is correct here — resist the urge to make it clever or memorable.',
	UNCOMMON: 'A sharper exchange than the ordinary channel: a disagreement that actually lands, a joke that works, a flash of friction or personality. Still grounded and work-related, but with an edge COMMON does not have.',
	RARE: 'Something a player would repeat to someone else afterwards. It has to earn being uncommon — an unexpected admission, a genuinely odd turn of phrase, a beat that stands apart from everything around it.',
	VERY_RARE: "Genuinely strange — it should make a player wonder whether they were meant to see it. It explains nothing, resolves nothing, and promises nothing: strangeness must never come from revealing lore, hinting at a plot, or implying something is coming. No line here may promise a sequel someone would then have to write — strange, not portentous. This is jensen's natural register, but it is not exclusive to him; any crew member can carry it.",
};

export function args(argv = process.argv) {
	const a = {};
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1]?.startsWith('--') || !argv[i + 1] ? true : argv[++i];
	}
	return a;
}

// Résout le backend, le modèle et l'hôte à partir des arguments et de
// l'environnement. Pur : aucune E/S, testable sans modèle ni réseau.
// L'hôte n'est calculé que pour ollama : le backend claude ne le lit jamais,
// autant ne pas le porter dans le résultat (sinon un OLLAMA_HOST déjà présent
// dans l'environnement d'un usage claude s'y retrouverait sans raison).
export function resolveBackend(a, env = process.env) {
	const backend = a.backend ?? DEFAULT_BACKEND;
	if (!BACKENDS.includes(backend)) throw new Error(`--backend inconnu (${backend}) — attendu : ${BACKENDS.join(' ou ')}`);
	const model = a.model ?? DEFAULT_MODEL[backend];
	if (backend !== 'ollama') return { backend, model, host: undefined };
	const host = a['ollama-host'] ?? env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
	return { backend, model, host };
}

// Le prompt passe par stdin : un lot dépasse les limites d'argument, et une
// erreur là-dessus est silencieuse et pénible à diagnostiquer.
function callModelClaude(prompt, model) {
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

// Backend local via Ollama. Même contrat que callModelClaude : une chaîne de
// prompt entre, une chaîne de réponse sort. Un timeout généreux car un gros
// lot sur un GPU domestique peut prendre plusieurs minutes (swap VRAM inclus).
async function callModelOllama(prompt, model, host) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${host}/api/generate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.9, num_ctx: 8192 }, think: false }),
			signal: controller.signal,
		});
	} catch (e) {
		const cause = e.name === 'AbortError'
			? `délai dépassé (${OLLAMA_TIMEOUT_MS / 1000}s)`
			: e.message;
		throw new Error(`Ollama injoignable sur ${host} (modèle ${model}) : ${cause}. Ollama tourne-t-il ?`);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Ollama a rendu ${res.status} sur ${host} (modèle ${model}) : ${body.slice(0, 400)}`);
	}
	const parsed = await res.json();
	return String(parsed.response ?? '');
}

function callModel(prompt, { backend, model, host }) {
	if (backend === 'ollama') return callModelOllama(prompt, model, host);
	return callModelClaude(prompt, model);
}

// Numéro de séquence de départ pour un shard : le plus grand suffixe
// numérique déjà utilisé, pas la longueur du tableau. La déduplication en
// fin de run RETIRE des entrées (voir plus bas), donc le tableau rétrécit
// sous le plus haut id jamais délivré — repartir de sa longueur réémettrait
// des ids déjà pris. Un id ne doit JAMAIS être réutilisé, même après
// suppression de l'entrée qui le portait : les trous dans la numérotation
// sont normaux et attendus, exactement comme une séquence de base de
// données. NE PAS "combler les trous" un jour, ça réintroduirait le bug.
export function nextSeq(entries) {
	let max = 0;
	for (const e of entries) {
		const m = /(\d+)\s*$/.exec(e?.id ?? '');
		if (!m) continue;
		const n = Number(m[1]);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max;
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
		`Every entry in this batch has rarity ${rarity}. ${RARITY_GUIDANCE[rarity] ?? ''}`,
		`Use these shapes, one per entry, in order:\n${forms.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
		`\nDo not reach for stock phrases — lines like "ship the coarse pass" or "does it matter" recur constantly across a large corpus and read as formula, not voice. Every entry should sound freshly written, not assembled from a phrasebook of crew clichés.`,
		`\nThe crew's dialogue is decoration, never a true reading of what the software is doing: never state real pipeline state — no durations, no percentages, no progress figures, no accurate diagnostics of what a process is actually doing.`,
		`\n# Already written for this event — do not go near these again\n${digest(entries) || '(nothing yet)'}`,
		`\n# Output\n`,
		'Reply with a JSON array and nothing else. No prose, no code fence.',
		'Each element: {"characters":[...],"requires":[...],"lines":[{"speaker":"...","text":"..."}]}',
		'`requires` lists the state paths of every slot used in the lines. If an entry uses no slot, `requires` is [].',
	].join('\n');
}

// Depuis un index donné, avance jusqu'au ']' qui équilibre le '[' de départ,
// en ignorant les crochets à l'intérieur des chaînes JSON (guillemets et
// échappements pris en compte). Rend l'index de ce ']', ou -1 si le tableau
// ouvert à `start` ne se referme jamais.
function balancedArrayEnd(body, start) {
	let depth = 0, inString = false, escaped = false;
	for (let i = start; i < body.length; i++) {
		const c = body[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '[') depth++;
		else if (c === ']') { depth--; if (depth === 0) return i; }
	}
	return -1;
}

// Le modèle enrobe volontiers sa réponse — un modèle local plus encore qu'un
// modèle hébergé (prose avant *et* après, bloc ```json). Le premier '[' de
// la réponse n'est pas forcément celui du vrai tableau : une préface du
// genre « using the format like [role, text], here is the batch: [...] »
// place un crochet de prose avant le tableau réel. On essaie donc chaque
// occurrence de '[' de gauche à droite, on l'équilibre en respectant les
// chaînes JSON, et on ne retient le résultat que s'il parse en un tableau
// d'objets — un crochet de prose s'équilibre souvent (il a bien un ']' qui
// lui correspond) mais ne parse pas en JSON, ou parse en autre chose qu'un
// tableau d'objets (ex. des mots nus). Le premier candidat qui satisfait les
// deux conditions est le vrai tableau ; les crochets à l'intérieur des
// répliques elles-mêmes ne sont jamais retenus en premier puisqu'ils
// n'ouvrent pas de tableau qui s'équilibre correctement à ce niveau.
export function parseEntries(text) {
	// Retire un éventuel bloc de code (```json ... ``` ou ``` ... ```).
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced ? fenced[1] : text;

	let anyBracket = false;
	let anyBalanced = false;
	for (let i = body.indexOf('['); i >= 0; i = body.indexOf('[', i + 1)) {
		anyBracket = true;
		const end = balancedArrayEnd(body, i);
		if (end < 0) continue;
		anyBalanced = true;
		let parsed;
		try { parsed = JSON.parse(body.slice(i, end + 1)); } catch { continue; }
		if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
			return parsed;
		}
	}
	if (!anyBracket) throw new Error(`aucun tableau JSON dans la réponse : ${text.slice(0, 300)}`);
	if (!anyBalanced) throw new Error(`tableau JSON non refermé dans la réponse : ${text.slice(0, 300)}`);
	throw new Error(`aucun tableau JSON exploitable dans la réponse : ${text.slice(0, 300)}`);
}

async function main() {
	const a = args();
	const event = a.event;
	if (!EVENTS[event]) throw new Error(`--event manquant ou inconnu (${event})`);
	const total = Number(a.count ?? 100);
	const size = Number(a.batch ?? 20);
	const rarity = a.rarity ?? 'COMMON';
	const { backend, model, host } = resolveBackend(a);

	const shard = loadShard(event);
	let seq = nextSeq(shard.entries);
	let kept = 0, rejected = 0, rejectedPhrase = 0;
	// Filtrage à l'accueil, pas seulement en fin de run : voir dedupe.mjs.
	// Amorcé sur le corpus déjà écrit, puis grandi au fil des entrées gardées
	// — une formule qui apparaît deux fois DANS le même run doit être attrapée
	// aussi sûrement qu'une formule déjà présente dans le shard chargé.
	const seenLines = seenLineSet(shard.entries);

	for (let done = 0; done < total; done += size) {
		const n = Math.min(size, total - done);
		const forms = Array.from({ length: n }, (_, i) => FORMS[(done + i) % FORMS.length]);
		const text = await callModel(buildPrompt({ event, entries: shard.entries, rarity, forms, count: n }), { backend, model, host });

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
			// Rejet distinct de la validation : l'entrée est par ailleurs correcte,
			// elle recycle juste une réplique déjà écrite pour cet événement.
			const repeated = repeatedLineIn(entry, seenLines);
			if (repeated) { rejectedPhrase++; console.warn(`  rejet ${entry.id} (formule reprise) : "${repeated}"`); continue; }
			addLinesToSeen(entry, seenLines);
			shard.entries.push(entry);
			kept++;
		}
		console.log(`lot ${done / size + 1} : ${kept} gardées, ${rejected} rejetées (validation), ${rejectedPhrase} rejetées (formule reprise)`);
	}

	// Déduplication en dernier : une entrée peut être irréprochable, inédite
	// ligne à ligne, et pourtant redire tout un ÉCHANGE déjà écrit autrement.
	const dups = findDuplicates(shard.entries, { threshold: 0.75 });
	const drop = new Set(dups.map((d) => d.b));
	shard.entries = shard.entries.filter((e) => !drop.has(e.id));
	console.log(`\n${kept} gardées, ${rejected} rejetées (validation), ${rejectedPhrase} rejetées (formule reprise), ${drop.size} doublons d'échange écartés → ${shard.entries.length} au total`);

	// Le taux de rejet d'un lot dit quelque chose du PROMPT, pas des entrées :
	// au-delà de 5 %, on jette et on corrige le brief plutôt que de rapiécer.
	// On nomme le backend et le modèle : 20 % de rejet ne veut pas dire la même
	// chose venant d'un 27B local que du modèle hébergé. La formule reprise
	// compte dans ce taux au même titre que la validation : les deux disent
	// que le prompt n'a pas suffi à obtenir des entrées neuves.
	const totalRejected = rejected + rejectedPhrase;
	const rate = totalRejected / (kept + totalRejected || 1);
	console.log(`backend : ${backend} (${model})`);
	if (rate > 0.05) console.warn(`\n⚠  taux de rejet ${(rate * 100).toFixed(1)} % avec ${backend}/${model} — revoir prompts/events/${EVENTS[event].shard}.md avant de continuer`);

	if (a['dry-run']) { console.log('(--dry-run : rien écrit)'); return; }
	writeFileSync(shardPath(event), `${JSON.stringify(shard, null, 2)}\n`);
	console.log(`écrit : public/dialogue/${EVENTS[event].shard}.json`);
}

// Ne lance rien à l'import : le selftest importe args()/resolveBackend()/
// parseEntries() sans vouloir déclencher un run réel.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => { console.error(e.message); process.exit(1); });
}
