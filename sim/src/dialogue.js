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
	// Hydratée une seule fois par onglet à partir de l'opérateur chargé — sûr
	// aujourd'hui seulement parce que main.js attend loadOperator() avant tout
	// écran qui monte le dialogue. Rien ne l'impose ici : un futur écran monté
	// plus tôt dans le boot figerait silencieusement la mémoire vide pour tout
	// l'onglet, sans qu'aucun test ne le détecte.
	const stored = getOperator()?.dialogueMemory;
	// Une clé absente se lit comme une mémoire vierge : pas de migration, pas
	// de bump de schéma, un opérateur d'avant PHASE 21 marche tel quel (D6).
	memory = (stored && Array.isArray(stored.ring)) ? stored : emptyMemory();
	return memory;
}

function persistMemory() {
	try { patch('dialogueMemory', memory); } catch { /* pas d'opérateur chargé : tant pis, c'est cosmétique */ }
}

// Le bloc RTC, en un seul endroit. Même markup que scanner.js et
// target-scan.js — qui gardent chacun leur copie pour l'instant : les unifier
// touche deux écrans que cette issue ne touche pas, et ce n'est pas le moment.
// Rend le <pre> où écrire, pas la section.
export function appendRtc(box) {
	const el = document.createElement('section');
	el.className = 'sc-block sc-log-block sc-rtc-block';
	const h = document.createElement('pre');
	h.className = 'sc-h';
	h.textContent = 'RTC // INTERNAL';
	const log = document.createElement('pre');
	log.className = 'sc-log sc-rtc';
	el.appendChild(h);
	el.appendChild(log);
	box.appendChild(el);
	return log;
}

// Un seul échange, sans minuteur : pour les écrans qui parlent une fois.
// Sans appelant depuis #243 — les deux qu'il avait (la fiche de cible et la
// sonde du scanner) ont perdu leur RTC. Gardé parce que c'est la moitié « une
// fois » de l'API du moteur, en face de mount() : le jour où un écran d'attente
// veut une réplique et pas un flux, il n'y a rien à réécrire.
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

// ---------------------------------------------------------------------------
// LE MOTEUR DE FLUX, UNE SEULE FOIS
//
// Minuteur, mémoire, cadence et découpage de l'échange sont ici ; la
// PRÉSENTATION est le `emit` que l'appelant fournit. C'est ce qui fait que le
// bloc du terminal et le toast en surimpression (issue #243) tirent exactement
// le même dialogue, à la même cadence, avec la même anti-répétition — deux
// copies de cette boucle auraient divergé au premier réglage.
//
// `event` accepte un TABLEAU : la racine (SELECT OPERATION MODE) mêle les
// treize événements câblés, parce qu'elle n'est aucun d'eux et que le corpus
// n'a plus d'autre écran où être lu. Un événement est tiré par tick, et c'est
// LUI qui donne la cadence — un flux mêlé ne doit pas parler plus vite que
// l'écran le plus bavard qu'il contient.
function runStream({ event, context, emit, alive }) {
	let stopped = false;
	const timers = new Set();
	const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
	const rng = Math.random;
	const pickEvent = () => (Array.isArray(event)
		? event[Math.floor(rng() * event.length)]
		: event);

	const tick = async () => {
		if (stopped) return;
		const ev = pickEvent();
		const ctx = typeof context === 'function' ? context() : context;
		const pool = await loadShard(ev);
		if (stopped) return;
		const mem = hydrateMemory();
		const r = select({ event: ev, pool, ctx, memory: mem, rng });
		memory = r.memory;
		persistMemory();
		if (r.entry) {
			let lines = null;
			try { lines = render(r.entry, ctx); }
			catch (e) { console.warn('[dialogue] entrée non rendable, ignorée', e); }
			if (lines) {
				const beats = planExchange(lines, ev, rng);
				// Le toast veut l'échange ENTIER d'un coup (il fabrique une carte),
				// le <pre> veut ses répliques une par une au rythme du battement.
				// `emit` reçoit donc les deux : la réplique et son instant.
				for (const l of beats) later(() => { if (!stopped && alive()) emit(l); }, l.atMs);
			}
		}
		later(tick, nextGapMs(ev, rng));
	};

	later(tick, nextGapMs(pickEvent(), rng));

	return () => {
		stopped = true;
		for (const id of timers) clearTimeout(id);
		timers.clear();
	};
}

// Flux continu dans un <pre>. Rend un `stop()` — l'appeler est OBLIGATOIRE
// quand l'écran disparaît, sinon les minuteurs survivent à leur conteneur.
export function mount(el, { event, context }) {
	return runStream({
		event, context,
		alive: () => el.isConnected,
		emit: ({ speaker, text }) => {
			el.appendChild(document.createTextNode(`\n> ${speaker}\n${text}\n`));
			while (el.childNodes.length > 400) el.removeChild(el.firstChild);
			el.scrollTop = el.scrollHeight;
		},
	});
}

// ---------------------------------------------------------------------------
// LE TOAST (issue #243)
//
// Même flux, rendu en surimpression au coin bas-droit de `host` au lieu d'un
// bloc qui pousse la colonne. C'est la SEULE surimpression du jeu — tout le
// reste vit dans le flux du terminal — et c'est un choix assumé : le rail de
// gauche du scanner portait deux blocs de log qui grandissaient à côté du
// formulaire et de la progression.
//
// Une carte par réplique, empilée du plus ancien au plus récent, effacée au
// bout de TOAST_MS. `TOAST_MAX` borne la pile : sur une acquisition longue, un
// écran de cartes cesserait d'être une notification.
const TOAST_MS = 6500;
const TOAST_MAX = 3;

export function notify({ event, context, host }) {
	if (!host) return () => {};
	const layer = document.createElement('div');
	layer.className = 'rtc-toasts';
	// aria-live off : le crew est décoratif (Bible §10), un lecteur d'écran n'a
	// pas à réciter une conversation qu'on peut ignorer.
	layer.setAttribute('aria-hidden', 'true');
	host.appendChild(layer);

	const drop = (card) => {
		if (!card.isConnected) return;
		card.dataset.out = '1';
		setTimeout(() => card.remove(), 400);
	};

	const stop = runStream({
		event, context,
		alive: () => layer.isConnected,
		emit: ({ speaker, text }) => {
			const card = document.createElement('div');
			card.className = 'rtc-toast';
			const who = document.createElement('pre');
			who.className = 'rtc-toast-who';
			who.textContent = speaker;
			const what = document.createElement('pre');
			what.className = 'rtc-toast-text';
			what.textContent = text;
			card.appendChild(who);
			card.appendChild(what);
			layer.appendChild(card);
			while (layer.childElementCount > TOAST_MAX) drop(layer.firstElementChild);
			setTimeout(() => drop(card), TOAST_MS);
		},
	});

	return () => { stop(); layer.remove(); };
}
