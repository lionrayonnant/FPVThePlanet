// Operator Terminal (PHASE 02, Bible §11–17). Remplace le menu « Choisir une
// carte » (ancien Hud.showMenu) et l'ancienne Home minimale (home.js supprimé).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD y est
// déjà. Tout le texte d'interface est en anglais (D5).
import * as operatorApi from './operator.js';
import { bootstrap } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';
import { countersOf, unlockedNotes, currentBuild } from '../tools/buildnotes-model.mjs';
import { targetLogEntries, areaLabel, targetRow, duration, fit } from '../tools/session-log-model.mjs';
import { dataModel, stickSeries, profileSeries } from '../tools/data-model.mjs';
import { fetchTrackIndex, fetchTrack } from './track-index.js';
import { bars, histogram, scatter, steps } from './graph.js';
import { worldWeather, formatForecast, headline, severity as weatherSeverity, today as weatherToday } from './weather.js';
import { previewBounds } from '../tools/map-preview-model.mjs';
import { watchReveal, countUp, exitScreen } from './motion.js';
import { versionLine } from './version.js';


// Combien de zones la Home montre sous la carte avant de renvoyer sur MORE….
// Assez pour reconnaître son cache d'un coup d'œil, pas assez pour redevenir la
// liste — c'est justement ce qu'on est en train de sortir de la Home.
const COMPACT_AREAS = 5;

// The FIELD tab we were on, for the session: LIVE (take off straight from a
// map pin) or LOCAL (fly or acquire a baked area) (#222). LIVE on entry (D2):
// it is the path that works on every build, including that of an operator who
// has not acquired anything yet.
let lastTab = 'live';

export function screen(root, cls = '') {
	const el = document.createElement('div');
	el.className = `bootstrap terminal ${cls}`.trim();
	// createElement plutôt qu'innerHTML : rigoureusement le même arbre, mais
	// sans passer par l'analyseur HTML — ce qui rend l'écran montable sur le
	// faux DOM de tools/lib/fake-dom.mjs, comme le faux AudioContext rend le
	// son testable sans navigateur.
	const box = document.createElement('div');
	box.className = 'bootstrap-box terminal-box';
	el.appendChild(box);
	root.appendChild(el);
	// L'écran s'imprime de haut en bas (issue #224) : chaque bloc ajouté dans
	// la boîte — maintenant ou après un fetch — reçoit son délai.
	const unwatch = watchReveal(box);
	const remove = () => { unwatch(); el.remove(); };
	// `close()` : la même chose, mais l'écran s'imprime à l'envers d'abord et la
	// promesse ne rend la main qu'une fois qu'il est parti (#67). C'est ce qui
	// permet d'ENCHAÎNER deux écrans sans que la cascade du second commence
	// dans la frame où le premier disparaît. `remove()` reste synchrone : la
	// plupart des écrans se démontent parce qu'on quitte le menu, et là il n'y
	// a rien à regarder s'éteindre.
	//
	// `close({ revealBehind: true })` pour le dernier écran d'un enchaînement,
	// celui qui donne sur le vol : lui seul emmène son fond noir avec lui. Par
	// défaut le fond tient jusqu'au démontage, sinon la scène 3D chargée
	// dessous se voit entre deux écrans.
	const close = (opts) => exitScreen(el, opts).then(remove);
	return { el, box, remove, close };
}

export function button(label, onClick, cls = 'terminal-link', title = '') {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = cls.split(' ').includes('terminal-cta') ? `[ ${label} ]` : label;
	b.onclick = onClick;
	if (title) b.title = title;
	return b;
}

// Une rangée « A · B · C » de liens inline, séparés par des points médians.
function navRow(entries) {
	const row = document.createElement('div');
	row.className = 'terminal-nav';
	entries.forEach(([label, fn, title], i) => {
		if (i) row.appendChild(document.createTextNode(' · '));
		row.appendChild(button(label, fn, 'terminal-link', title));
	});
	return row;
}

// The keys a screen answers to, written where the screen is (D15). Escape has
// always worked everywhere and was named nowhere — a key nobody can see is a key
// nobody presses. `pairs` is [[key, what it does], …], rendered `[ESC] BACK`.
//
// It is information, not assistance (Bible, pilier 1): one dim line, no arrow,
// no prompt, and never a button — pressing it is the point.
export function keyHints(pairs) {
	const row = document.createElement('pre');
	row.className = 'terminal-keys';
	row.textContent = pairs.map(([key, what]) => `[${key}] ${what}`).join(' · ');
	return row;
}

// [ BACK ] and the key that does the same thing, together. Every sub-screen
// repeats this pair, so it is written once — a screen that grows a BACK button
// without its key hint is the drift this helper prevents.
export function backRow(box, onBack) {
	box.appendChild(button('BACK', onBack, 'terminal-cta'));
	box.appendChild(keyHints([['ESC', 'BACK']]));
}

// The line the three screens directly under the root carry.
const ESC_ROOT = () => keyHints([['ESC', 'OPERATION MODE']]);

// Le droit d'acquérir, tel que le serveur le rend (issue #60) : le drapeau
// FPVTP_ACQUIRE posé ET le mode `local`. Retenu à part plutôt que rendu par
// fetchScenes(), dont trois écrans attendent un tableau de zones et rien
// d'autre. Fermé tant qu'un serveur n'a pas dit le contraire : une build
// distribuée n'acquiert pas, et c'est le cas par défaut.
let acquireAllowed = false;
export function canAcquire() { return acquireAllowed; }

// Where the game RUNS, which is a different question from what it is allowed to
// download (V1). Every distributed build ships with acquisition closed, so a
// footer and a LOCAL-tab notice keyed on `acquire` told the desktop client it
// was a SHARED SERVER and that terrain "is not available on this server".
// Optimistic default: an unreachable server is not a reason to call a local
// install someone else's.
let sharedServer = false;
export function isSharedServer() { return sharedServer; }

export async function fetchScenes() {
	try {
		const r = await fetch('/__map-api/scenes');
		if (!r.ok) return null;
		const { scenes, acquire, mode } = await r.json();
		acquireAllowed = acquire === true;
		sharedServer = mode === 'shared';
		return Array.isArray(scenes) ? scenes : null;
	} catch {
		return null;
	}
}

// ---------- FORECAST ----------

// La prévision 7 jours d'une zone (PHASE 04, Bible §5). Rien à régler ici :
// c'est un bulletin, pas un panneau. La météo appartient au monde.
async function forecastScreen(root, scene) {
	const s = screen(root);
	s.box.innerHTML = `<pre>FORECAST // ${scene.name.toUpperCase()}\n\nQUERYING WORLD STATE…</pre>`;
	const back = new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		backRow(s.box, close);
		const nav = menuNav(s.el, { back: close });
	});
	const snapshot = await worldWeather({ lat: scene.lat, lon: scene.lon });
	// L'écran peut avoir été fermé pendant la requête.
	if (s.el.isConnected) {
		s.box.querySelector('pre').textContent = snapshot
			? formatForecast(snapshot, { title: `FORECAST // ${scene.name}` })
			: `FORECAST // ${scene.name.toUpperCase()}\n\nNO COORDINATES FOR THIS AREA`;
	}
	return back;
}

// ---------- une rangée de zone ----------

// La rangée entière est le curseur (issue #123) : ↑/↓ la survolent, elle prend
// le ton blanc de la DA — Entrée/clic l'active.
//
// Sortie de localTerrain() pour que la liste compacte de la Home et l'écran
// complet montrent EXACTEMENT la même chose : un nom, un poids, et le temps
// qu'il fait là-bas. Deux implémentations, ce serait deux façons de lire la
// même zone, et un seul des deux appels à worldWeather() serait mis à jour le
// jour où la ligne change.
//
// `onWeather` : la sévérité, une fois connue, pour un appelant qui trie dessus.
function areaRow(sc, { onActivate, onWeather = null } = {}) {
	const row = document.createElement('button');
	row.type = 'button';
	row.className = 'terminal-area';
	row.dataset.slug = sc.slug;

	const name = document.createElement('span');
	name.textContent = sc.name;
	const size = document.createElement('span');
	size.className = 'terminal-area-size';
	size.textContent = formatBytes(sc.bytes);
	countUp(size);
	// Le temps qu'il fait là-bas, pas un réglage : la ligne se remplit quand le
	// world state répond, et reste vide s'il ne répond pas.
	const sky = document.createElement('span');
	sky.className = 'terminal-area-weather';
	sky.textContent = '…';
	worldWeather({ lat: sc.lat, lon: sc.lon })
		.then((snap) => {
			const t = snap && weatherToday(snap);
			sky.textContent = t ? headline(t) : '';
			// La couleur ne sort que si les conditions changent la décision de
			// voler (PHASE 19, Bible §38) : `nominal` ne pose rien et la ligne
			// reste en encre neutre.
			const sev = t ? weatherSeverity(t) : 'nominal';
			if (sev !== 'nominal') sky.dataset.severity = sev;
			else delete sky.dataset.severity;
			onWeather?.(sc.slug, sev);
		})
		.catch(() => { sky.textContent = ''; delete sky.dataset.severity; });

	row.append(name, size, sky);
	row.onclick = () => onActivate?.(sc);
	return row;
}

// ---------- LOCAL TERRAIN ----------

// Résout un slug (→ vol) ou undefined (→ retour au terminal).
function localTerrain(root, scenes) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		// Une rangée ouverte pose son propre menuNav (OPEN/FORECAST/REMOVE),
		// au-dessus de la liste : Échap referme celui-là avant celui de l'écran.
		let subNav = null;
		const closeSub = () => { subNav?.detach(); subNav = null; };
		const done = (slug) => { closeSub(); nav?.detach(); s.remove(); resolve(slug); };

		// Filtre texte, conservé d'un re-rendu à l'autre (REMOVE, retour de
		// FORECAST) — seul le nom compte, c'est la seule donnée que l'opérateur
		// reconnaît au clavier.
		let query = '';

		// Tri actif, même durée de vie que le filtre. WEATHER dépend d'une donnée
		// qui arrive en retard (worldWeather par rangée) : le cache et le
		// registre `weatherReordered` évitent de retrier en boucle à chaque
		// résolution — un seul re-tri par carte, la première fois qu'on connaît
		// sa sévérité.
		const SORTS = ['NAME', 'SIZE', 'DATE', 'WEATHER'];
		let sortBy = 'NAME';
		const weatherSeverityBySlug = new Map();
		const weatherReordered = new Set();

		const SEVERITY_RANK = { nominal: 0, watch: 1, marginal: 2, nogo: 3 };

		const compareScenes = (a, b) => {
			if (sortBy === 'SIZE') return (b.bytes ?? 0) - (a.bytes ?? 0); // plus lourd d'abord
			if (sortBy === 'DATE') return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')); // plus récent d'abord
			if (sortBy === 'WEATHER') {
				const ra = weatherSeverityBySlug.has(a.slug) ? SEVERITY_RANK[weatherSeverityBySlug.get(a.slug)] : 99;
				const rb = weatherSeverityBySlug.has(b.slug) ? SEVERITY_RANK[weatherSeverityBySlug.get(b.slug)] : 99;
				return ra - rb || a.name.localeCompare(b.name);
			}
			return a.name.localeCompare(b.name);
		};

		const render = (focusIdx = 0, focusSearch = false, focusSortIdx = -1) => {
			closeSub();
			nav?.detach();
			s.box.innerHTML = '';
			if (scenes === null || scenes.length === 0) {
				// Pas de renvoi vers une page d'acquisition : le scanner EST l'entrée.
				s.box.innerHTML = `<pre>LOCAL TERRAIN\n\n${scenes === null
					? 'TERRAIN CACHE UNREACHABLE' : 'NO LOCAL TERRAIN — ACQUIRE ONE'}</pre>`;
				backRow(s.box, () => done());
				nav = menuNav(s.el, { back: () => done() });
				return;
			}
			s.box.innerHTML = '<pre>LOCAL TERRAIN</pre>';

			const search = document.createElement('input');
			search.type = 'search';
			search.autocomplete = 'off';
			search.spellcheck = false;
			search.placeholder = 'SEARCH';
			search.value = query;
			search.className = 'terminal-search';
			search.oninput = () => { query = search.value; render(0, true); };
			s.box.appendChild(search);

			const sortRow = document.createElement('div');
			sortRow.className = 'terminal-nav terminal-sort';
			SORTS.forEach((key, i) => {
				if (i) sortRow.appendChild(document.createTextNode(' · '));
				sortRow.appendChild(button(key === sortBy ? `[${key}]` : key, () => {
					sortBy = key;
					render(0, false, i);
				}));
			});
			s.box.appendChild(sortRow);

			const q = query.trim().toLowerCase();
			const shown = (q ? scenes.filter((sc) => sc.name.toLowerCase().includes(q)) : scenes.slice())
				.sort(compareScenes);

			const refocusSearch = () => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); };
			const refocusSort = () => { sortRow.querySelectorAll('button')[focusSortIdx]?.focus(); };

			if (!shown.length) {
				const empty = document.createElement('pre');
				empty.textContent = 'NO MATCH';
				s.box.appendChild(empty);
				backRow(s.box, () => done());
				nav = menuNav(s.el, { back: () => done(), focusFirst: false });
				if (focusSortIdx >= 0) refocusSort(); else refocusSearch();
				return;
			}

			const list = document.createElement('div');
			list.className = 'terminal-areas';
			shown.forEach((sc, i) => {
				const item = document.createElement('div');

				// Ici la rangée OUVRE ses actions (OPEN / FORECAST / REMOVE) ; sur
				// la Home elle sélectionne la zone. Même rangée, deux gestes —
				// c'est tout ce qui distingue les deux listes.
				const actions = document.createElement('div');
				const row = areaRow(sc, {
					onActivate: () => {
						if (subNav) return;
						actions.hidden = false;
						subNav = menuNav(actions, { back: () => { closeSub(); actions.hidden = true; row.focus(); } });
					},
					onWeather: (slug, sev) => {
						weatherSeverityBySlug.set(slug, sev);
						if (sortBy === 'WEATHER' && !weatherReordered.has(slug)) {
							weatherReordered.add(slug);
							render(focusIdx, focusSearch, focusSortIdx);
						}
					},
				});
				actions.className = 'terminal-nav terminal-area-actions';
				actions.hidden = true;
				actions.append(
					button('OPEN', () => done(sc.slug), 'terminal-link', 'Fly this area'),
					button('FORECAST', () => forecastScreen(root, sc), 'terminal-link', 'Preview weather over this area'));
				// Removing an area is a LOCAL operation (issue #78): the terrain
				// belongs to the instance, not to whoever is looking at it, and a
				// shared server answers 403 to everyone. The button would only ever
				// fail silently there, so it is not offered.
				if (!sharedServer) {
					actions.append(button('REMOVE', async () => {
						closeSub();
						const r = await fetch(`/__map-api/scenes/${sc.slug}`, { method: 'DELETE' });
						if (!r.ok) return;
						scenes = scenes.filter((x) => x.slug !== sc.slug);
						render(Math.min(i, scenes.length - 1));
					}, 'terminal-link', 'Delete this downloaded area'));
				}

				item.append(row, actions);
				list.appendChild(item);
			});
			s.box.appendChild(list);
			backRow(s.box, () => done());
			nav = menuNav(s.el, { back: () => done(), focusFirst: false });
			if (focusSortIdx >= 0) refocusSort();
			else if (focusSearch) refocusSearch();
			else {
				const rows = list.querySelectorAll('button.terminal-area');
				(rows[Math.min(focusIdx, rows.length - 1)] ?? s.box.querySelector('button'))?.focus();
			}
		};

		render();
	});
}

// ---------- LAST SESSION ----------

// Resolves undefined, or a slug (REVISIT AREA).
function lastSessionScreen(root, model) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };
		// createElement rather than innerHTML, like the rest of the house: that
		// is what makes the screen mountable on the fake DOM, and therefore
		// testable — and the REVISIT that leaves here is the contract the root
		// loop consumes.
		const pre = (text) => {
			const el = document.createElement('pre');
			el.textContent = text;
			return el;
		};
		const ls = model.lastSession;
		if (!ls) {
			s.box.appendChild(pre('LAST SESSION — NONE YET'));
			backRow(s.box, () => done());
			nav = menuNav(s.el, { back: () => done() });
			return;
		}
		const area = ls.area ?? ls.slug ?? null;
		const when = ls.end ?? ls.endedAt ?? ls.start ?? ls.startedAt ?? ls.at ?? '';
		s.box.appendChild(pre(`LAST SESSION

AREA     ${area ? areaLabel(area) : 'UNKNOWN'}
WHEN     ${String(when).replace('T', ' ').slice(0, 16) || 'UNKNOWN'}
RESULT   ${ls.result ?? 'UNKNOWN'}`));
		s.box.appendChild(button('VIEW SESSION', async () => {
			s.el.style.display = 'none';
			const { runSessionDetail } = await import('./session-log.js');
			const r = await runSessionDetail(root, ls.id, { scenes: null });
			// REVISIT et DELETE ferment LAST SESSION : dans les deux cas l'écran
			// qu'on avait sous les yeux ne décrit plus l'état courant.
			if (r?.revisit) { done(r.revisit); return; }
			if (r?.deleted) { done(); return; }
			s.el.style.display = '';
			nav?.focusAt(0);
		}, 'terminal-cta'));
		const areaKnown = area && model.areas.some((a) => a.slug === area);
		// Terrain persistent, flights ephemeral: a lost flight is not resumed
		// (D9, 2026-09-08: landing is gone, and RESUME SESSION with it). The
		// terrain stays — that is what a revisit is.
		if (areaKnown) {
			s.box.appendChild(button('REVISIT AREA', () => done(area), 'terminal-cta'));
		}
		backRow(s.box, () => done());
		nav = menuNav(s.el, { back: () => done() });
	});
}

// ---------- OPERATOR ----------

async function operatorScreen(root, api) {
	const s = screen(root);
	let resolveScreen;
	let keyShown = false;
	let nav = null;
	const close = () => { nav?.detach(); s.remove(); resolveScreen(); };
	const render = () => {
		const op = api.getOperator();
		s.box.replaceChildren();
		const pre = document.createElement('pre');
		// Le compteur de cibles est DÉRIVÉ des sessions depuis PHASE 17 (spec
		// D1) : `op.targetLog` n'existe plus, et le lire rendait toujours 0 —
		// cet écran annonçait TARGETS 0 pendant que le pied de la Home disait
		// « 9 TARGETS LOGGED » et que le Target Log en listait neuf.
		pre.textContent = [
			`OPERATOR // ${op.name.toUpperCase()}`,
			'',
			`REGISTERED   ${String(op.createdAt).replace('T', ' ').slice(0, 16)}`,
			`SESSIONS     ${op.sessions?.length ?? 0}`,
			`TARGETS      ${targetLogEntries(op.sessions).length}`,
		].join('\n');
		s.box.appendChild(pre);
		// La CLÉ d'opérateur (#60). Même geste que SHOW VECTOR — masquée, révélée
		// à la demande — et surtout PAS le même objet : le Control Vector est un
		// rituel de jeu (Bible §33), la clé est le secret technique qui dit au
		// serveur `shared` qui parle. Deux écrans, deux mécanismes, jamais mêlés.
		// Elle vient du navigateur : le serveur ne sait plus la relire en clair.
		if (api.hasKey?.()) {
			const keyPre = document.createElement('pre');
			keyPre.className = 'terminal-sub';
			keyPre.textContent = `OPERATOR KEY  ${keyShown ? api.getKey() : '••••-••••-••••-••••'}`;
			s.box.appendChild(keyPre);
			if (!keyShown) s.box.appendChild(button('SHOW KEY', () => { keyShown = true; render(); }, 'terminal-cta'));
			// La seule chose qui soit jamais dite de la clé, et elle est dite ICI :
			// l'inscription, elle, ne fait rien noter à personne.
			const where = document.createElement('pre');
			where.className = 'terminal-foot';
			where.textContent = 'THIS PROFILE LIVES IN THIS BROWSER. THE KEY CARRIES IT ELSEWHERE.';
			s.box.appendChild(where);
		}
		const portrait = document.createElement('div');
		portrait.className = 'op-portrait';
		portrait.hidden = true;
		s.box.appendChild(portrait);
		backRow(s.box, close);
		nav?.focusAt(0);
	};
	render();
	nav = menuNav(s.el, { back: close });
	return new Promise((resolve) => { resolveScreen = resolve; });
}

// ---------- BUILD NOTES ----------

// Échelle de versions écrite à la main (tools/buildnotes-model.mjs), déverrouillée
// par les compteurs déjà accumulés par l'opérateur. Décoratif : pas de résolution
// de vol, juste un BACK vers la Home.
function buildNotesScreen(root, operator) {
	const s = screen(root);
	const c = countersOf(operator);
	// createElement, et une ligne de note = un <pre>. En un seul bloc, une note
	// trop longue se repliait en colonne 0 : la suite d'« fixed: session
	// timestamp off by one hour on the » se lisait comme une NOUVELLE entrée de
	// premier niveau, au même rang que le numéro de version. Un élément par
	// ligne, c'est la seule façon de donner à la ligne repliée un retrait
	// suspendu (`.terminal-note`) — deux espaces littéraux ne survivent pas au
	// repli. Effet de bord voulu : l'écran devient montable sur le faux DOM.
	const head = document.createElement('pre');
	head.textContent = `BUILD NOTES\n\nCURRENT BUILD   ${currentBuild(c)}`;
	s.box.appendChild(head);

	for (const n of unlockedNotes(c)) {
		const block = document.createElement('div');
		block.className = 'terminal-note-block';
		const build = document.createElement('pre');
		build.textContent = n.build;
		block.appendChild(build);
		for (const line of n.lines) {
			const p = document.createElement('pre');
			p.className = 'terminal-note';
			p.textContent = line;
			block.appendChild(p);
		}
		s.box.appendChild(block);
	}
	return new Promise((resolve) => {
		// Seul écran de la maison qui n'appelait pas menuNav : ni curseur, ni
		// clavier, ni manette, et surtout Escape sans effet. Sur une liste de
		// notes assez longue pour passer sous la ligne de flottaison, le seul
		// BACK était hors de vue — l'écran se refermait sur l'opérateur.
		let nav = null;
		const close = () => { nav?.detach(); s.remove(); resolve(); };
		backRow(s.box, close);
		nav = menuNav(s.el, { back: close });
	});
}

// ---------- DATA ----------

// Everything COLD, and no longer a shelf of logs (issue #26). ARCHIVE listed
// what had been stored; DATA is one scrolling page where the operator reads
// their own flying back — nine sections, graphs first, raw records last.
//
// The screen COMPUTES NOTHING. Every series comes from tools/data-model.mjs and
// every mark is put down by src/graph.js; what lives here is the page — which
// section, in what order, and the one readout line under each.
//
// No score, no level, no badge, no comparison with anybody (spec, Non-goals).
// Nothing here is won: it is what happened, drawn.
//
// Resolves { slug } (a REVISIT, which the root loop flies like a choice made in
// FIELD) or null.
//
// `openMap` is the single call site of the ENRICHED map (#25): the scanner does
// not carry that toggle yet, so the caller passes nothing today and GEOGRAPHY
// renders no link. Wiring it later is one argument at one call site.
export function dataScreen(root, { api = operatorApi, scenes = null, openMap = null } = {}) {
	const operator = api.getOperator();
	const model = terminalModel({ operator, scenes });
	const s = screen(root, 'terminal-data');
	return new Promise((resolve) => {
		let nav = null;
		let alive = true;
		// A bare slug (lastSessionScreen) and a { slug } (SESSION LOG) say the
		// same thing: one shape goes back up, the one the root loop knows how to
		// fly.
		const done = (value) => {
			alive = false;
			window.removeEventListener('resize', onResize);
			nav?.detach();
			s.remove();
			resolve(value == null ? null : (typeof value === 'string' ? { slug: value } : value));
		};

		// Un écran plein cadre en masque un autre : on cache celui-ci pendant, et
		// on le rend au retour. Même geste que la Home avec le scanner.
		const behind = async (fn) => {
			s.el.hidden = true;
			const r = await fn();
			if (r !== undefined && r !== null) return done(r);
			s.el.hidden = false;
			nav?.focusAt(0);
		};

		// --- state ---------------------------------------------------------
		// `tracks` is the index (#24), empty until it answers — and empty for
		// ever on a build that does not serve it. `track` is the ONE decoded
		// track of the flight being profiled: STICKS and PROFILE need samples,
		// and no other section does.
		const sessions = operator?.sessions ?? [];
		let tracks = [];
		let data = dataModel({ sessions, tracks });
		let selectedId = data.selectedId;
		let track = null;
		let openFamily = null;

		// --- page ----------------------------------------------------------
		const page = document.createElement('div');
		page.className = 'data-page';
		// Drawing is deferred: a canvas measures 0 until it has been laid out,
		// and the same closures are what a resize replays.
		let draws = [];
		const paint = () => { for (const d of draws) d(); };
		const onResize = () => { if (alive) paint(); };

		const pre = (text, cls = '') => {
			const el = document.createElement('pre');
			if (cls) el.className = cls;
			el.textContent = text;
			return el;
		};

		// A section is a title, one readout line, then whatever it draws. The
		// title is the machine speaking (DISPLAY); the readout is data.
		const section = (name, readout) => {
			const box = document.createElement('div');
			box.className = 'data-section';
			box.appendChild(pre(name));
			if (readout) box.appendChild(pre(readout, 'terminal-foot'));
			page.appendChild(box);
			return box;
		};

		// A canvas, and the closure that fills it. `draw` is called once the page
		// is up and again on every resize.
		const graph = (box, height, draw) => {
			const c = document.createElement('canvas');
			c.className = 'data-graph';
			box.appendChild(c);
			draws.push(() => draw(c));
			return c;
		};

		// The sections that need a trace say so in the same words everywhere.
		const noTrack = (box, why = 'NO TRACK') => box.appendChild(pre(why, 'terminal-foot'));

		const link = (row, label, fn, title = '') => {
			if (row.children.length) row.appendChild(document.createTextNode(' · '));
			row.appendChild(button(label, fn, 'terminal-link', title));
		};
		const linkRow = () => {
			const row = document.createElement('div');
			row.className = 'terminal-nav';
			return row;
		};

		// --- the nine sections ----------------------------------------------

		const render = () => {
			page.replaceChildren();
			draws = [];

			// 1. RHYTHM — the only graph about real time, and the one that makes
			// coming back visible.
			const weeks = data.rhythm.bars.filter((b) => b.value > 0).length;
			const rhythm = section('RHYTHM',
				`SESSIONS PER WEEK · LAST ${data.rhythm.weeks} · ${data.rhythm.total} FLOWN · ${weeks} WEEKS WITH A FLIGHT`);
			graph(rhythm, 96, (c) => bars(c, { items: data.rhythm.bars, height: 96, format: (v) => String(Math.round(v)) }));

			// 2. LIFE — how long each one lasted, in the order they happened.
			const life = section('LIFE',
				data.life.bars.length
					? `DURATION PER SESSION · LONGEST ${duration(data.life.maxS)} · MEAN ${duration(data.life.meanS)}`
					: 'NO SESSION YET');
			graph(life, 96, (c) => bars(c, {
				items: data.life.bars.map((b) => ({ ...b, selected: b.id === selectedId })),
				height: 96,
				format: (v) => `${Math.round(v / 60)}m`,
				everyLabel: Math.max(1, Math.ceil(data.life.bars.length / 8)),
			}));

			// 3. SPEED × ALTITUDE — the shape of a flying style: low and fast, or
			// high and slow. One mark per flight, from the maxima it recorded.
			const sa = section('SPEED × ALTITUDE',
				data.speedAlt.points.length
					? `PEAK OF EACH FLIGHT · ${data.speedAlt.points.length} FLIGHTS · UP TO ${round1(data.speedAlt.maxX)} m/s AND ${Math.round(data.speedAlt.maxY)} m`
					: 'NO FLIGHT WITH A SHAPE YET');
			graph(sa, 150, (c) => scatter(c, {
				points: data.speedAlt.points.map((p) => ({ ...p, selected: p.id === selectedId })),
				height: 150, maxX: data.speedAlt.maxX, maxY: data.speedAlt.maxY,
				xLabel: 'SPEED m/s', yLabel: 'ALT m',
			}));

			// 4. HOW THEY DIED — the state at the moment the link died. Needs the
			// `end` event, so flights without a track are counted, not drawn.
			const deaths = section('HOW THEY DIED',
				data.loss.points.length
					? `SPEED AND ALTITUDE AT LINK LOSS · ${data.loss.points.length} RECORDED`
					+ (data.loss.missing ? ` · ${data.loss.missing} WITHOUT A TRACK` : '')
					: '');
			if (data.loss.points.length) {
				graph(deaths, 150, (c) => scatter(c, {
					points: data.loss.points.map((p) => ({ ...p, selected: p.id === selectedId })),
					height: 150, maxX: data.loss.maxX, maxY: data.loss.maxY,
					xLabel: 'SPEED m/s', yLabel: 'ALT m',
				}));
			} else noTrack(deaths);

			// 5. STICKS — throttle and rotation rate. They live in the samples, so
			// this is the SELECTED flight, the same one PROFILE draws.
			const sticks = stickSeries(track);
			const st = section('STICKS', sticks
				? `${selectedLabel()} · ${sticks.samples} SAMPLES`
				: '');
			if (sticks) {
				st.appendChild(pre('THROTTLE', 'terminal-foot'));
				graph(st, 84, (c) => histogram(c, { bins: sticks.throttle.bins, height: 84, format: (v) => `${Math.round(v * 100)}%` }));
				st.appendChild(pre('ROTATION RATE', 'terminal-foot'));
				graph(st, 84, (c) => histogram(c, { bins: sticks.rate.bins, height: 84, format: (v) => `${Math.round(v)}°/s` }));
			} else noTrack(st);

			// 6. FAMILIES — a bar per target family, mean survival on it. This is
			// where the TARGET LOG went (D2): a family opens on the targets met.
			const fam = section('FAMILIES', data.families.total
				? `MEAN SURVIVAL PER TARGET FAMILY · ${data.families.total} TARGETS MET`
				: 'NO TARGET MET YET');
			if (data.families.total) {
				graph(fam, 110, (c) => bars(c, {
					items: data.families.families.map((f) => ({ label: f.label, value: f.meanS, selected: f.family === openFamily })),
					height: 110, format: (v) => `${Math.round(v / 60)}m`,
				}));
				const row = linkRow();
				for (const f of data.families.families) {
					link(row, `${f.label} ${f.count}`, () => {
						openFamily = openFamily === f.family ? null : f.family;
						render();
					}, 'Show the targets met in this family');
				}
				fam.appendChild(row);
				const open = data.families.families.find((f) => f.family === openFamily);
				if (open) {
					fam.appendChild(pre(open.entries.map((e) => `  ${targetRow(e)}`).join('\n'), 'terminal-log'));
				}
			}

			// 7. GEOGRAPHY — where the operator has been. Countries only when a
			// session carries one; nothing invents a flag out of a slug.
			const geo = section('GEOGRAPHY',
				`${data.geography.areaCount} AREAS · ${formatDistance(data.geography.distanceM)} FLOWN`);
			const areaLines = data.geography.areas.slice(0, 12)
				.map((a) => `  ${fit(a.label, 30)} ${String(a.count).padStart(4)}`);
			geo.appendChild(pre(areaLines.length ? areaLines.join('\n') : '  NOWHERE YET', 'terminal-log'));
			geo.appendChild(pre(`COUNTRIES  ${data.geography.countries.length
				? data.geography.countries.map((c) => `${c.code} ${c.count}`).join(' · ')
				: '—'}`, 'terminal-foot'));
			// The way back to the one map with the traces drawn on it (#25). The
			// ENRICHED toggle does not exist yet: until the caller passes
			// `openMap`, this link is simply not there. THIS is the call site.
			if (openMap) {
				const row = linkRow();
				link(row, 'OPEN MAP — ENRICHED', () => behind(async () => openMap({ enriched: true })),
					'Reopen the global scanner with your own traces drawn on it');
				geo.appendChild(row);
			}

			// 8. PROFILE — altitude against time for one flight, photos marked.
			// Opens on the last flight that HAS a track, not simply the last one.
			const profile = profileSeries(track);
			const prof = section('PROFILE', data.hasTracks
				? `${selectedLabel()} · ALTITUDE OVER TIME`
				: '');
			if (data.flights.length > 1) {
				const row = linkRow();
				link(row, 'PREVIOUS FLIGHT', () => step(-1), 'Profile the flight before this one');
				link(row, 'NEXT FLIGHT', () => step(1), 'Profile the flight after this one');
				prof.appendChild(row);
			}
			if (profile) {
				graph(prof, 160, (c) => steps(c, {
					points: profile.points.map((p) => ({ x: p.t, y: p.alt })),
					marks: profile.photos.map((p) => ({ x: p.t, y: p.alt })),
					height: 160, maxY: profile.maxAltM,
					formatX: (v) => `${Math.round(v)}s`, formatY: (v) => `${Math.round(v)}m`,
					xLabel: 'TIME',
				}));
				prof.appendChild(pre(`PEAK ${Math.round(profile.maxAltM)} m · ${duration(profile.durationS)}`
					+ ` · ${profile.photos.length} CAPTURES MARKED`, 'terminal-foot'));
			} else noTrack(prof, data.hasTracks ? 'LOADING…' : 'NO TRACK');

			// 9. RECORDS — the raw log at the bottom, unchanged, and everything
			// that is read rather than drawn.
			const rec = section('RECORDS', 'the log, the vector, the operator, the notes');
			const row = linkRow();
			link(row, 'SESSION LOG', () => behind(async () => {
				const { runSessionLog } = await import('./session-log.js');
				return await runSessionLog(root, { operator: api.getOperator(), scenes });
			}), 'Browse every past flight session');
			link(row, 'LAST SESSION', () => behind(async () => {
				const r = await lastSessionScreen(root, model);
				// lastSessionScreen yields a slug, or nothing.
				return typeof r === 'string' ? r : r ?? undefined;
			}), 'Review your most recent flight');
			link(row, 'OPERATOR', () => behind(() => operatorScreen(root, api)), 'View operator identity and stats');
			link(row, 'BUILD NOTES', () => behind(() => buildNotesScreen(root, api.getOperator())), 'Read unlocked build notes for this version');
			rec.appendChild(row);

			paint();
			// A canvas measures nothing until the page has been laid out: the
			// second pass is what gives the graphs their real width.
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => { if (alive) paint(); });
			}
		};

		const selectedLabel = () =>
			data.flights.find((f) => f.id === selectedId)?.label ?? 'NO FLIGHT';

		// Walks the flights that have a track, in the order they were flown.
		const step = (dir) => {
			const i = data.flights.findIndex((f) => f.id === selectedId);
			const next = data.flights[Math.min(data.flights.length - 1, Math.max(0, i + dir))];
			if (!next || next.id === selectedId) return;
			selectedId = next.id;
			track = null;
			render();
			loadTrack();
		};

		const loadTrack = async () => {
			if (!selectedId) return;
			const wanted = selectedId;
			const t = await fetchTrack(operator?.id, wanted);
			if (!alive || wanted !== selectedId) return;
			track = t;
			render();
		};

		const title = document.createElement('pre');
		title.textContent = 'DATA';
		s.box.appendChild(title);
		s.box.appendChild(pre(`${data.sessionCount} SESSIONS ON RECORD`, 'terminal-foot'));
		s.box.appendChild(page);
		render();

		s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
		s.box.appendChild(ESC_ROOT());
		nav = menuNav(s.el, { back: () => done() });
		window.addEventListener('resize', onResize);

		// The index, then the one track the profile needs. Both are allowed to
		// fail: the page is already readable without them.
		(async () => {
			tracks = await fetchTrackIndex(operator?.id);
			if (!alive) return;
			data = dataModel({ sessions, tracks });
			if (!selectedId) selectedId = data.selectedId;
			render();
			await loadTrack();
		})();
	});
}

const round1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function formatDistance(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ---------- OPERATOR SELECT (repris de l'ancienne home.js) ----------

export async function operatorSelect(root, choices) {
	const s = screen(root);
	s.box.innerHTML = '<pre>OPERATOR SELECT</pre>';
	return new Promise((resolve) => {
		const done = (value) => { nav.detach(); s.remove(); resolve(value); };
		for (const c of choices) {
			s.box.appendChild(button(c.name.toUpperCase(), () => done({ id: c.id }), 'terminal-cta'));
		}
		s.box.appendChild(button('+ NEW OPERATOR', () => done({ create: true }), 'terminal-cta'));
		// Pas de `back` : il faut choisir un opérateur — il n'y a pas d'ailleurs.
		const nav = menuNav(s.el, {});
	});
}

// ---------- OPERATOR KEY (issue #60) ----------

// Ce que voit un opérateur qu'un serveur `shared` ne reconnaît pas : clé
// absente, fausse, ou fichier d'avant #60 qui n'en a pas encore. Même gabarit
// que OPERATOR SELECT ci-dessus — c'est le même moment du jeu, avec une liste
// en moins : sur un serveur partagé il n'y a personne à choisir.
//
// [ NEW OPERATOR ] est le chemin NORMAL, et il est premier : le cas nominal sur
// un serveur partagé, c'est quelqu'un qui arrive et repart avec un profil. La
// saisie de clé est une porte de secours — on n'y va que si l'on a déjà un
// profil ailleurs — donc plus bas et sans CTA.
//
// Résout { create: true } pour un bootstrap, { operator } quand une clé
// retrouve son opérateur.
export async function operatorKey(root, api = operatorApi) {
	const s = screen(root);
	const title = document.createElement('pre');
	title.textContent = 'OPERATOR\n\nTHIS SERVER DOES NOT KNOW THIS BROWSER.';
	s.box.appendChild(title);

	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };

		s.box.appendChild(button('NEW OPERATOR', () => done({ create: true }), 'terminal-cta'));

		const sub = document.createElement('pre');
		sub.className = 'terminal-sub';
		sub.textContent = 'ALREADY REGISTERED ELSEWHERE? ENTER YOUR OPERATOR KEY.';
		s.box.appendChild(sub);

		const input = document.createElement('input');
		input.type = 'text';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = 'K7QP-3MZX-…';
		s.box.appendChild(input);

		const err = document.createElement('div');
		err.className = 'bootstrap-err';
		s.box.appendChild(err);

		const submit = async () => {
			err.textContent = '';
			if (!input.value.trim()) { err.textContent = 'KEY REQUIRED'; return; }
			try { done({ operator: await api.resumeWithKey(input.value) }); }
			catch { err.textContent = 'UNKNOWN KEY'; }
		};
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		s.box.appendChild(button('RESUME', submit, 'terminal-link'));
		// Pas de `back` : comme OPERATOR SELECT, il n'y a pas d'ailleurs. Le
		// curseur se pose sur [ NEW OPERATOR ], pas dans le champ : c'est ce que
		// fait la personne qui arrive.
		nav = menuNav(s.el, {});
	});
}

// ---------- terminal ----------

// Mounts the Operator Terminal and resolves the area to fly over.
// Resolves { slug } to fly a baked area, { live: [lat, lon] } to
// décoller en direct depuis le scanner, ou null pour remonter au choix de mode
// quand `back` est vrai (PHASE 26 : la Home n'est plus la racine du jeu).
export async function runTerminal(root, { api = operatorApi, back = false } = {}) {
	let scenes = await fetchScenes();
	// `terminal-field` en plus de `terminal-home` : le banc monte ses deux écrans
	// avec `terminal-home` aussi (bench.js:72 et :196) pour en partager la
	// typographie. La mise en page en deux colonnes, elle, n'appartient qu'à
	// FIELD — l'accrocher à `terminal-home` la posait sur SELECT OPERATION MODE
	// et sur l'écran du banc, qui se retrouvaient en pleine largeur.
	const s = screen(root, 'terminal-home terminal-field');
	let resolveFly;

	let nav = null;
	// La zone sous le curseur : ce que [ FLY ] volera et ce que la carte recadre.
	let selected = null;
	// La poignée du scanner. Il est monté UNE fois et vit aussi longtemps que la
	// Home : c'est lui qui possède la carte, et la carte ne se démonte jamais
	// entre l'état de repos et l'état de travail (#211).
	let scanner = null;
	// Vrai dès qu'une zone est tracée sur la carte. C'est le basculement de
	// l'onglet LOCAL : le corps de la colonne gauche passe de la liste au rail
	// du scanner.
	let drawing = false;
	// LOCAL ou LIVE (#222). Les deux onglets partagent la tête, la recherche et
	// le pied ; seul le corps change.
	let tab = lastTab;

	// --- les deux colonnes, créées UNE fois
	//
	// FIELD est un seul écran (Bible §4 : « le GLOBAL SCANNER est le menu
	// principal après l'initialisation »). À gauche ce qu'on lit et ce qu'on
	// choisit ; à droite le monde. Seule la colonne gauche est reconstruite —
	// `right` et le nœud de la carte qu'elle contient ne sont JAMAIS remplacés,
	// sans quoi Leaflet se remonterait à chaque re-rendu et la promesse de
	// l'écran tomberait.
	const left = document.createElement('div');
	left.className = 'terminal-left';
	const right = document.createElement('div');
	right.className = 'terminal-right';
	const mapHost = document.createElement('div');
	mapHost.className = 'terminal-map';
	right.appendChild(mapHost);
	// Les trois hôtes du scanner, créés une fois : la recherche au-dessus des
	// onglets, le rail LOCAL au travail, l'onglet LIVE. Le scanner les remplit,
	// la Home les place.
	const searchHost = document.createElement('div');
	searchHost.className = 'terminal-search';
	const rail = document.createElement('aside');
	const liveRail = document.createElement('aside');
	s.box.append(left, right);

	const renderLeft = () => {
		const model = terminalModel({ operator: api.getOperator(), scenes, shared: sharedServer });
		const areas = Array.isArray(scenes) ? scenes : [];

		// Voler est ce qu'on fait à chaque session : l'action la plus fréquente a
		// une entrée directe et le curseur au repos (issue #123, point 5) — la
		// zone de la dernière session si elle est encore sur disque, sinon la
		// première zone locale.
		if (!selected || !areas.some((a) => a.slug === selected)) {
			selected = areas.find((a) => a.slug === model.lastSession?.area)?.slug
				?? areas[0]?.slug ?? null;
		}
		const flyArea = areas.find((a) => a.slug === selected) ?? null;

		left.replaceChildren();

		// D1: the version, and nothing else. The operator is greeted at the
		// root — once, where the game asks who you are.
		const head = document.createElement('pre');
		head.textContent = versionLine();
		left.appendChild(head);

		// La recherche est commune aux deux onglets : elle ne fait que déplacer
		// la carte. Son hôte reste vide tant que le scanner n'est pas monté.
		left.appendChild(searchHost);

		// --- les onglets (#222)
		//
		// LOCAL : ce qui est sur le disque, et comment y ajouter une zone.
		// LIVE : une épingle et un décollage en direct. Deux façons de voler,
		// une seule carte.
		const tabs = document.createElement('div');
		tabs.className = 'terminal-tabs';
		const tabTitles = { local: 'Fly a downloaded area', live: 'Take off live from a map pin' };
		// LIVE first (D2): it is the path that works everywhere, on every build,
		// with nothing to download. LOCAL is the path of whoever has acquired.
		for (const [id, label] of [['live', 'LIVE'], ['local', 'LOCAL']]) {
			const b = button(label, () => setTab(id), 'terminal-tab', tabTitles[id]);
			b.dataset.on = String(tab === id);
			// Dimmed but still selectable: the state is read BEFORE the click,
			// and areas a host pre-installed stay reachable.
			// Dimmed on a SHARED server only: a local install with acquisition
			// closed still flies whatever terrain is on its disk.
			if (id === 'local' && sharedServer) b.dataset.off = 'true';
			tabs.appendChild(b);
		}
		left.appendChild(tabs);

		// The LOCAL tab of a shared server opens by SAYING so (D2). Three lines
		// at the head of the body, before any list: they absorb the old "SWITCH
		// TO LIVE TO FLY" line and the old "DESKTOP CLIENT AVAILABLE" footer,
		// which said the same thing twice, elsewhere, and never where the
		// operator was wondering why the list is empty.
		// V1: keyed on the SERVER MODE, not on the acquisition right. Telling the
		// desktop client to "install the desktop client" is the bug this fixes.
		if (tab === 'local' && sharedServer) {
			const notice = document.createElement('pre');
			notice.className = 'terminal-notice';
			notice.textContent = [
				'LOCAL TERRAIN IS NOT AVAILABLE ON THIS SERVER.',
				'THIS SERVER FLIES LIVE ONLY — SWITCH TO THE LIVE TAB.',
				'TO ACQUIRE AND KEEP TERRAIN, INSTALL THE DESKTOP CLIENT.',
			].join('\n');
			left.appendChild(notice);
		}

		if (tab === 'live') {
			left.appendChild(liveRail);
		} else if (drawing) {
			// État de TRAVAIL : une zone est tracée, le corps devient le rail du
			// scanner. La carte, elle, n'a pas bougé d'un pixel — c'est tout
			// l'intérêt de l'écran.
			left.appendChild(rail);
		} else {
			// --- la seule chose qui décolle
			const acts = document.createElement('div');
			acts.className = 'terminal-acts';
			if (flyArea) {
				acts.appendChild(button(`FLY — ${flyArea.name.toUpperCase()}`, () => fly(flyArea.slug), 'terminal-cta'));
			}
			left.appendChild(acts);

			// --- le cache terrain
			//
			// La liste SÉLECTIONNE, elle ne fait pas voler : cliquer une zone
			// recadre la carte et réétiquette le CTA. [ FLY ] reste la seule chose
			// qui décolle — deux façons de partir, ce serait deux axes sur un
			// écran qui n'en veut qu'un.
			if (areas.length) {
				const h = document.createElement('pre');
				h.className = 'terminal-sub';
				h.textContent = 'LOCAL TERRAIN';
				left.appendChild(h);

				const list = document.createElement('div');
				list.className = 'terminal-areas terminal-areas-compact';
				for (const sc of areas.slice(0, COMPACT_AREAS)) {
					const row = areaRow(sc, { onActivate: (picked) => pickArea(picked.slug) });
					if (sc.slug === selected) row.dataset.selected = '1';
					list.appendChild(row);
				}
				left.appendChild(list);
			} else {
				// Three cases, three sentences (V1). Acquisition open: the map is
				// where a new area comes from. Shared server: the notice at the
				// head of the tab has already said everything, and repeating it
				// here would say the same phrase twice in one column. Local
				// install with acquisition closed: neither of those — the disk is
				// simply empty, and the LIVE tab is the way to fly today.
				const none = document.createElement('pre');
				none.className = 'terminal-sub';
				if (acquireAllowed) {
					none.textContent = 'NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP';
					left.appendChild(none);
				} else if (!sharedServer) {
					none.textContent = 'NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY';
					left.appendChild(none);
				}
			}

			// ALL TERRAIN… only appears when there is really something to
			// search, sort or remove — it is the full screen, unchanged. It has
			// been alone on its row since ARCHIVE moved to the root (D3).
			if (areas.length) left.appendChild(navRow([['ALL TERRAIN…', async () => {
				s.el.hidden = true;
				const slug = await localTerrain(root, scenes);
				if (slug) return fly(slug);
				scenes = await fetchScenes();
				scanner?.setAreaFrames(Array.isArray(scenes) ? scenes : []);
				scanner?.refreshCoverage();
				s.el.hidden = false;
				renderLeft();
			}, 'Search, sort or remove every local area']]));

			// Tracer n'est pas voler, mais il faut bien pouvoir commencer : au
			// repos le rail est caché, donc les deux tracés avec lui. Un clic
			// arme l'outil et met l'écran au travail — la source, le nom et
			// l'acquisition arrivent alors avec le rail.
			// … et seulement là où une scène a le droit de naître sur disque (#60).
			// Sans ce droit il ne reste que l'onglet LIVE, qui porte déjà la boucle
			// complète depuis #218. La garde qui compte est sur POST /__map-api/jobs :
			// ici on ne fait que ne pas proposer ce que le serveur refusera.
			if (scanner && acquireAllowed) {
				const draw = (shape) => () => { drawing = true; renderLeft(); scanner.startDraw(shape); };
				const row = document.createElement('div');
				row.className = 'terminal-acts';
				row.append(
					button('DRAW BOX', draw('Rectangle'), 'terminal-cta terminal-scanner-cta', 'Trace a rectangular area on the map to download'),
					button('DRAW SHAPE', draw('Polygon'), 'terminal-cta terminal-scanner-cta', 'Trace a free-form area on the map to download'),
				);
				left.appendChild(row);
			}
		}

		// --- the footer: where the game runs, and nothing more
		//
		// No row of links any more (D4, D6): MODE only did what Escape already
		// does, and SETTINGS moved to the root. A menu that repeats its exits on
		// every floor has no floors.
		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		left.appendChild(foot);
		countUp(foot);

		// D15: Escape goes back up, and it says so. Not when FIELD is the root
		// (?scene=), where there is nothing above it.
		if (back) left.appendChild(ESC_ROOT());
		// « Une seule touche pour voler » (issue #123) : le curseur se pose sur
		// [ FLY ], pas sur la recherche ni sur un onglet, qui le précèdent
		// désormais dans la colonne (#222).
		const cta = [...left.querySelectorAll('button')].find((b) => b.textContent.startsWith('[ FLY'));
		if (cta) cta.focus(); else nav?.focusAt(0);
	};

	const setTab = (id) => {
		if (tab === id) return;
		tab = lastTab = id;
		scanner?.setMode(id);
		renderLeft();
	};

	// Sélectionner une zone recadre la carte et réétiquette [ FLY ]. On ne
	// reconstruit QUE la colonne gauche : tout re-rendre remonterait la carte,
	// ce que cet écran promet de ne jamais faire.
	const pickArea = (slug) => {
		selected = slug;
		const sc = (Array.isArray(scenes) ? scenes : []).find((a) => a.slug === slug);
		if (sc) scanner?.focusBounds(previewBounds(sc));
		// Un cadre cliqué sur la carte est une sélection LOCAL, même depuis LIVE.
		if (tab !== 'local') { tab = lastTab = 'local'; scanner?.setMode('local'); }
		renderLeft();
	};

	// Toute sortie passe par ici. `s.remove()` détruit le nœud de la carte mais
	// pas les écouteurs que Leaflet a posés sur window : c'est destroy() qui
	// appelle map.remove(), sans quoi une Home ouverte trois fois laisse trois
	// cartes vivantes derrière elle.
	const quit = (value) => { scanner?.destroy(); scanner = null; nav?.detach(); s.remove(); resolveFly(value); };
	const fly = (slug) => quit({ slug });
	// Vol en direct. La Home ne fait que TRANSMETTRE, sans rien lire ni rien
	// décider : le scanner joint au point le relevé qu'il vient de faire de la
	// zone (densité de signal, nom du lieu), et c'est fieldLoop() qui sait ce
	// qu'un vol en direct veut dire.
	const flyLive = (live) => quit(live);
	// Remonter d'un cran : SELECT OPERATION MODE. Depuis PHASE 26 la Home n'est
	// plus la racine — mais elle l'est encore pour ?scene=, qui saute le choix
	// de mode, d'où le drapeau plutôt qu'un `back` inconditionnel.
	const leave = () => quit(null);

	renderLeft();
	// Échap / B : au travail, repose l'outil (le rail n'a plus de nav à lui,
	// #222) ; au repos, remonte au choix de mode si l'on peut.
	nav = menuNav(s.el, {
		// renderLeft() a déjà posé le curseur sur [ FLY ] ; focusFirst le
		// déplacerait sur l'onglet LOCAL.
		focusFirst: false,
		back: () => {
			if (scanner?.busy()) return;
			if (drawing && tab === 'local') return scanner?.rest();
			if (back) leave();
		},
	});

	// Le scanner est monté après le premier rendu : la Home doit tenir même s'il
	// ne vient pas (hors ligne, chunk absent). Sans lui, la colonne de droite
	// reste vide et tout le reste fonctionne — c'est déjà ce que faisait la
	// vignette de #208.
	import('./scanner.js')
		.then(({ runScanner }) => {
			if (!mapHost.isConnected) return;
			scanner = runScanner({
				mapHost,
				searchHost,
				railHost: rail,
				liveHost: liveRail,
				// Une zone tracée met l'écran au travail ; l'effacer ne l'en sort
				// PAS — on peut vouloir redessiner. C'est BACK qui repose l'outil.
				onZone: (zone) => { if (zone) { drawing = true; renderLeft(); } },
				onPickArea: pickArea,
				onRest: () => { drawing = false; renderLeft(); },
				// Une acquisition reprise au montage : le rail doit se voir.
				onBusy: () => { drawing = true; tab = lastTab = 'local'; renderLeft(); },
			});
			scanner.setMode(tab);
			scanner.setAreaFrames(Array.isArray(scenes) ? scenes : []);
			scanner.refreshCoverage();
			// Le scanner arrive après le premier rendu : la colonne gauche doit
			// être refaite pour montrer DRAW BOX / DRAW SHAPE, qui n'ont de sens
			// qu'avec lui.
			renderLeft();
			// Une zone cuite se vole par son slug ; un décollage en direct remonte
			// tel quel jusqu'à fieldLoop(), qui sait le faire traverser bootLive().
			scanner.done.then((choice) => {
				if (choice?.slug) return fly(choice.slug);
				if (choice?.live) return flyLive(choice);
			});
		})
		.catch(() => {
			const none = document.createElement('pre');
			none.className = 'terminal-map-none';
			none.textContent = 'NO MAP LINK';
			mapHost.appendChild(none);
		});

	return new Promise((resolve) => { resolveFly = resolve; });
}
