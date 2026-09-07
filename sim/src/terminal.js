// Operator Terminal (PHASE 02, Bible §11–17). Remplace le menu « Choisir une
// carte » (ancien Hud.showMenu) et l'ancienne Home minimale (home.js supprimé).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD y est
// déjà. Tout le texte d'interface est en anglais (D5).
import * as operatorApi from './operator.js';
import { captureControlVector, bootstrap } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';
import { countersOf, unlockedNotes, currentBuild } from '../tools/buildnotes-model.mjs';
import { targetLogEntries, areaLabel } from '../tools/session-log-model.mjs';
import { worldWeather, formatForecast, headline, severity as weatherSeverity, today as weatherToday } from './weather.js';
import { previewBounds } from '../tools/map-preview-model.mjs';
import { watchReveal, countUp } from './motion.js';
import { versionLine } from './version.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

// Combien de zones la Home montre sous la carte avant de renvoyer sur MORE….
// Assez pour reconnaître son cache d'un coup d'œil, pas assez pour redevenir la
// liste — c'est justement ce qu'on est en train de sortir de la Home.
const COMPACT_AREAS = 5;

// L'onglet de FIELD où l'on était, pour la session : LOCAL (voler ou acquérir
// une zone cuite) ou LIVE (décoller en direct depuis une épingle) (#222).
let lastTab = 'local';

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
	return { el, box, remove: () => { unwatch(); el.remove(); } };
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

// Le droit d'acquérir, tel que le serveur le rend (issue #60) : le drapeau
// FPVTP_ACQUIRE posé ET le mode `local`. Retenu à part plutôt que rendu par
// fetchScenes(), dont trois écrans attendent un tableau de zones et rien
// d'autre. Fermé tant qu'un serveur n'a pas dit le contraire : une build
// distribuée n'acquiert pas, et c'est le cas par défaut.
let acquireAllowed = false;
export function canAcquire() { return acquireAllowed; }

export async function fetchScenes() {
	try {
		const r = await fetch('/__map-api/scenes');
		if (!r.ok) return null;
		const { scenes, acquire } = await r.json();
		acquireAllowed = acquire === true;
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
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
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
				s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
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
				s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
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
					button('FORECAST', () => forecastScreen(root, sc), 'terminal-link', 'Preview weather over this area'),
					button('REMOVE', async () => {
						closeSub();
						const r = await fetch(`/__map-api/scenes/${sc.slug}`, { method: 'DELETE' });
						if (!r.ok) return;
						scenes = scenes.filter((x) => x.slug !== sc.slug);
						render(Math.min(i, scenes.length - 1));
					}, 'terminal-link', 'Delete this downloaded area'));

				item.append(row, actions);
				list.appendChild(item);
			});
			s.box.appendChild(list);
			s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
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

// ---------- CONTROL VECTOR ----------

async function controlVectorScreen(root, api) {
	const s = screen(root);
	let revealed = false;
	let nav = null;
	const close = () => { nav?.detach(); s.remove(); resolveScreen(); };
	const render = () => {
		const op = api.getOperator();
		const set = op.controlVector?.length > 0;
		const shown = set
			? (revealed ? op.controlVector.map((d) => ARROW[d]).join(' ') : '•'.repeat(op.controlVector.length))
			: '(not set)';
		s.box.innerHTML = `<pre>CONTROL VECTOR

${shown}</pre>`;
		if (set && !revealed) s.box.appendChild(button('SHOW VECTOR', () => { revealed = true; render(); }, 'terminal-cta'));
		s.box.appendChild(button('REDEFINE', async () => {
			// Masqué pendant la capture : les flèches y sont la donnée saisie, cet
			// écran ne doit ni naviguer ni recevoir un clic manette pendant qu'elle
			// est ouverte (issue #123 — un écran s'abonne explicitement).
			s.el.hidden = true;
			const v = await captureControlVector(root, op.controlVector?.length || 6);
			api.patch('controlVector', v);
			try { await api.flush(); } catch { /* réessai automatique côté operator.js */ }
			revealed = true;
			s.el.hidden = false;
			render();
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
		nav?.focusAt(0);
	};
	let resolveScreen;
	render();
	nav = menuNav(s.el, { back: close });
	return new Promise((resolve) => { resolveScreen = resolve; });
}

// ---------- LAST SESSION ----------

// Résout undefined ou un slug (REVISIT AREA).
function lastSessionScreen(root, model) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };
		const ls = model.lastSession;
		if (!ls) {
			s.box.innerHTML = '<pre>LAST SESSION — NONE YET</pre>';
			s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
			nav = menuNav(s.el, { back: () => done() });
			return;
		}
		const area = ls.area ?? ls.slug ?? null;
		const when = ls.end ?? ls.endedAt ?? ls.start ?? ls.startedAt ?? ls.at ?? '';
		s.box.innerHTML = `<pre>LAST SESSION

AREA     ${area ? areaLabel(area) : 'UNKNOWN'}
WHEN     ${String(when).replace('T', ' ').slice(0, 16) || 'UNKNOWN'}
RESULT   ${ls.result ?? 'UNKNOWN'}</pre>`;
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
		// terrain persistent, flights ephemeral : un vol perdu ne se reprend pas
		// (D9, 2026-09-08 : l'atterrissage a disparu, RESUME SESSION avec lui).
		// Le terrain, lui, reste — on le revisite.
		if (areaKnown) {
			s.box.appendChild(button('REVISIT AREA', () => done(area), 'terminal-cta'));
		}
		s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
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
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
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
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
		nav = menuNav(s.el, { back: close });
	});
}

// ---------- ARCHIVE ----------

// Tout ce qui est FROID. La Home ne garde que ce qui sert à décoller ; ce qui se
// consulte — les journaux, le vecteur, l'opérateur, les notes — descend d'un
// cran. La Bible §30 le disait déjà : « La Home est calme. Elle ne doit pas
// devenir un dashboard. »
//
// Cet écran ne RÉIMPLÉMENTE rien : il appelle les écrans existants tels quels.
// Il doit en revanche résoudre VERS LE HAUT, parce que REVISIT (depuis SESSION
// LOG) rend un vol : l'avaler ici laisserait l'opérateur sur un écran de
// journal après avoir demandé à voler.
//
// Résout undefined (retour à la Home) ou un slug.
function archiveScreen(root, { model, api, scenes, settings }) {
	const s = screen(root, 'terminal-archive');
	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };

		// Un écran plein cadre en masque un autre : on cache celui-ci pendant, et
		// on le rend au retour. Même geste que la Home avec le scanner.
		const behind = async (fn) => {
			s.el.hidden = true;
			const r = await fn();
			if (r !== undefined && r !== null) return done(r);
			s.el.hidden = false;
			nav?.focusAt(0);
		};

		const title = document.createElement('pre');
		title.textContent = 'ARCHIVE';
		s.box.appendChild(title);

		s.box.appendChild(navRow([
			['LAST SESSION', () => behind(async () => {
				const r = await lastSessionScreen(root, model);
				// lastSessionScreen rend un slug ou rien.
				return typeof r === 'string' ? r : r ?? undefined;
			}), 'Review your most recent flight'],
			['SESSION LOG', () => behind(async () => {
				const { runSessionLog } = await import('./session-log.js');
				return await runSessionLog(root, { operator: api.getOperator(), scenes });
			}), 'Browse every past flight session'],
			['TARGET LOG', () => behind(async () => {
				const { runTargetLog } = await import('./session-log.js');
				await runTargetLog(root, { operator: api.getOperator() });
			}), 'Browse targets captured across all sessions'],
		]));

		s.box.appendChild(navRow([
			['CONTROL VECTOR', () => behind(() => controlVectorScreen(root, api)), 'View or redefine your assigned control vector'],
			['OPERATOR', () => behind(() => operatorScreen(root, api)), 'View operator identity and stats'],
			['BUILD NOTES', () => behind(() => buildNotesScreen(root, api.getOperator())), 'Read unlocked build notes for this version'],
			['SETTINGS', () => settings?.toggleSettings(true), 'Controller mapping, controls, sound'],
		]));

		s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
		nav = menuNav(s.el, { back: () => done() });
	});
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

// Monte l'Operator Terminal et résout le slug de la zone à survoler.
// `settings` : instance de Settings (src/settings.js) — l'entrée SETTINGS ouvre
// le même panneau que Tab en vol.
// Résout { slug } pour voler une zone cuite, { live: [lat, lon] } pour
// décoller en direct depuis le scanner, ou null pour remonter au choix de mode
// quand `back` est vrai (PHASE 26 : la Home n'est plus la racine du jeu).
export async function runTerminal(root, { settings, api = operatorApi, back = false } = {}) {
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
		const model = terminalModel({ operator: api.getOperator(), scenes });
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

		const head = document.createElement('pre');
		head.textContent = `${versionLine()}\nOPERATOR // ${model.operatorName}`;
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
		for (const [id, label] of [['local', 'LOCAL'], ['live', 'LIVE']]) {
			const b = button(label, () => setTab(id), 'terminal-tab', tabTitles[id]);
			b.dataset.on = String(tab === id);
			tabs.appendChild(b);
		}
		left.appendChild(tabs);

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
				const none = document.createElement('pre');
				none.className = 'terminal-sub';
				// Sans le droit d'acquérir, [ DRAW BOX ] n'est pas à l'écran : envoyer
				// le joueur le chercher serait lui demander l'impossible. LIVE est
				// alors la seule façon de décoller, et elle suffit.
				none.textContent = acquireAllowed
					? 'NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP'
					: 'NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY';
				left.appendChild(none);
			}

			// ALL TERRAIN… n'apparaît que s'il y a réellement de quoi chercher,
			// trier ou supprimer — c'est l'écran complet, inchangé.
			const tail = [];
			if (areas.length) tail.push(['ALL TERRAIN…', async () => {
				s.el.hidden = true;
				const slug = await localTerrain(root, scenes);
				if (slug) return fly(slug);
				scenes = await fetchScenes();
				scanner?.setAreaFrames(Array.isArray(scenes) ? scenes : []);
				scanner?.refreshCoverage();
				s.el.hidden = false;
				renderLeft();
			}, 'Search, sort or remove every local area']);
			tail.push(['ARCHIVE', async () => {
				s.el.hidden = true;
				const r = await archiveScreen(root, { model, api, scenes, settings });
				if (typeof r === 'string') return fly(r);
				if (r) return fly(r.slug);
				s.el.hidden = false;
				// Une suppression a pu changer les compteurs du pied.
				renderLeft();
			}, 'Session history, control vector, operator, build notes']);
			left.appendChild(navRow(tail));

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

		// --- le pied : ce qui n'est ni un lieu ni une action de vol
		left.appendChild(navRow([
			...(back ? [['MODE', () => leave()]] : []),
			['SETTINGS', () => settings?.toggleSettings(true)],
		]));

		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		left.appendChild(foot);
		countUp(foot);

		// Une ligne, au pied, et rien de plus (#60). L'argument n'est PAS de
		// débloquer une fonctionnalité — la build de bureau n'acquiert pas non
		// plus — c'est de jouer chez soi plutôt que dans un onglet. Information,
		// pas assistance (Bible, pilier 1) : ni bandeau, ni compte à rebours.
		if (!acquireAllowed) {
			const hint = document.createElement('pre');
			hint.className = 'terminal-foot terminal-foot-hint';
			hint.textContent = 'DESKTOP CLIENT AVAILABLE — THE SAME GAME, ON YOUR OWN MACHINE';
			left.appendChild(hint);
		}
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
