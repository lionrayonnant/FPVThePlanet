// Colle navigateur du moteur de dialogue (PHASE 21). Tout ce qui est testable
// vit dans tools/dialogue/ ; ici il ne reste que du réseau, du DOM et des
// minuteurs.
//
// Deux invariants hérités de PHASE 05, non négociables : ce module ne bloque
// JAMAIS rien (aucun await sur son chargement dans un chemin d'interaction), et
// il n'est JAMAIS une source d'information sur l'état réel du pipeline.
import { EVENTS } from '../tools/dialogue/catalog.mjs';
import { select, emptyMemory } from '../tools/dialogue/engine.mjs';
import { planExchange, nextGapMs } from '../tools/dialogue/cadence.mjs';
import { render } from '../tools/dialogue/render.mjs';
import { FALLBACK } from './dialogue-fallback.js';
import { getOperator, patch } from './operator.js';

const shards = new Map();   // event -> Promise<entries[]>
let memory = null;          // hydratée à la première utilisation

// Le corpus d'un événement, chargé une fois par onglet. Un échec quel qu'il
// soit retombe sur le pack embarqué : un écran muet serait pire qu'un écran
// répétitif, et surtout une erreur réseau n'a pas le droit de casser un écran.
export function loadShard(event) {
	if (shards.has(event)) return shards.get(event);
	const file = EVENTS[event]?.shard;
	const p = (!file ? Promise.resolve([]) : fetch(`/dialogue/${file}.json`)
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
		.then((s) => (Array.isArray(s.entries) ? s.entries : [])))
		.catch(() => FALLBACK.filter((e) => e.events.includes(event)));
	shards.set(event, p);
	return p;
}

function hydrateMemory() {
	if (memory) return memory;
	const stored = getOperator()?.dialogueMemory;
	// Une clé absente se lit comme une mémoire vierge : pas de migration, pas
	// de bump de schéma, un opérateur d'avant PHASE 21 marche tel quel (D6).
	memory = (stored && Array.isArray(stored.ring)) ? stored : emptyMemory();
	return memory;
}

function persistMemory() {
	try { patch('dialogueMemory', memory); } catch { /* pas d'opérateur chargé : tant pis, c'est cosmétique */ }
}

// Un seul échange, sans minuteur : pour les écrans qui parlent une fois.
export async function sayOnce(event, context) {
	const pool = await loadShard(event);
	const mem = hydrateMemory();
	const r = select({ event, pool, ctx: context, memory: mem, rng: Math.random });
	memory = r.memory;
	persistMemory();
	if (!r.entry) return null;
	try { return render(r.entry, context); }
	catch (e) { console.warn('[dialogue] entrée non rendable, ignorée', e); return null; }
}

// Flux continu dans un <pre>. Rend un `stop()` — l'appeler est OBLIGATOIRE
// quand l'écran disparaît, sinon les minuteurs survivent à leur conteneur.
export function mount(el, { event, context }) {
	let stopped = false;
	const timers = new Set();
	const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
	const rng = Math.random;

	const append = (speaker, text) => {
		if (stopped || !el.isConnected) return;
		el.appendChild(document.createTextNode(`\n> ${speaker}\n${text}\n`));
		while (el.childNodes.length > 400) el.removeChild(el.firstChild);
		el.scrollTop = el.scrollHeight;
	};

	const tick = async () => {
		if (stopped) return;
		const ctx = typeof context === 'function' ? context() : context;
		const pool = await loadShard(event);
		if (stopped) return;
		const mem = hydrateMemory();
		const r = select({ event, pool, ctx, memory: mem, rng });
		memory = r.memory;
		persistMemory();
		if (r.entry) {
			let lines = null;
			try { lines = render(r.entry, ctx); }
			catch (e) { console.warn('[dialogue] entrée non rendable, ignorée', e); }
			if (lines) for (const l of planExchange(lines, event, rng)) later(() => append(l.speaker, l.text), l.atMs);
		}
		later(tick, nextGapMs(event, rng));
	};

	later(tick, nextGapMs(event, rng));

	return () => {
		stopped = true;
		for (const id of timers) clearTimeout(id);
		timers.clear();
	};
}
