// Operator Terminal (PHASE 02, Bible §11–17). Remplace le menu « Choisir une
// carte » (ancien Hud.showMenu) et l'ancienne Home minimale (home.js supprimé).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD y est
// déjà. Tout le texte d'interface est en anglais (D5).
import * as operatorApi from './operator.js';
import { captureControlVector, bootstrap } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';
import { countersOf, unlockedNotes, currentBuild } from '../tools/buildnotes-model.mjs';
import { worldWeather, formatForecast, headline, severity as weatherSeverity, today as weatherToday } from './weather.js';
import { previewBounds } from '../tools/map-preview-model.mjs';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

// Combien de zones la Home montre sous la carte avant de renvoyer sur MORE….
// Assez pour reconnaître son cache d'un coup d'œil, pas assez pour redevenir la
// liste — c'est justement ce qu'on est en train de sortir de la Home.
const COMPACT_AREAS = 5;

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
	return { el, box, remove: () => el.remove() };
}

export function button(label, onClick, cls = 'terminal-link') {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = cls.split(' ').includes('terminal-cta') ? `[ ${label} ]` : label;
	b.onclick = onClick;
	return b;
}

// Une rangée « A · B · C » de liens inline, séparés par des points médians.
function navRow(entries) {
	const row = document.createElement('div');
	row.className = 'terminal-nav';
	entries.forEach(([label, fn], i) => {
		if (i) row.appendChild(document.createTextNode(' · '));
		row.appendChild(button(label, fn));
	});
	return row;
}

export async function fetchScenes() {
	try {
		const r = await fetch('/__map-api/scenes');
		if (!r.ok) return null;
		const { scenes } = await r.json();
		return Array.isArray(scenes) ? scenes : null;
	} catch {
		return null;
	}
}

// ---------- écrans souches (assumés, jusqu'aux phases dédiées) ----------

function stub(root, title, line) {
	const s = screen(root);
	s.box.innerHTML = `<pre>${title}\n\n${line}</pre>`;
	return new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
		const nav = menuNav(s.el, { back: close });
	});
}

// ---------- GLOBAL SCANNER ----------

// Chargé à la demande : Leaflet et Geoman ne partent dans le navigateur que si
// l'opérateur ouvre le scanner. Résout une forme de vol — `{ slug }` pour une
// zone cuite, `{ live: [lat, lon] }` pour un décollage en direct — ou undefined.
//
// Un seul scanner à la fois : la Home est masquée pendant l'opération, donc
// l'utilisateur ne peut pas rouvrir le scanner — mais un second appel monterait
// une deuxième carte Leaflet par-dessus la première, et deux acquisitions
// concurrentes. Le verrou rend ce cas impossible plutôt qu'improbable.
let scannerOpen = false;
async function globalScanner(root) {
	if (scannerOpen) return;
	scannerOpen = true;
	try {
		const { runScanner } = await import('./scanner.js');
		return await runScanner(root);
	} catch (e) {
		console.error(e);
		await stub(root, 'GLOBAL SCANNER', `SCANNER UNAVAILABLE — ${e.message}`);
	} finally {
		scannerOpen = false;
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
					button('OPEN', () => done(sc.slug)),
					button('FORECAST', () => forecastScreen(root, sc)),
					button('REMOVE', async () => {
						closeSub();
						const r = await fetch(`/__map-api/scenes/${sc.slug}`, { method: 'DELETE' });
						if (!r.ok) return;
						scenes = scenes.filter((x) => x.slug !== sc.slug);
						render(Math.min(i, scenes.length - 1));
					}));

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

// Résout undefined, un slug (REVISIT AREA) ou { slug, resume } (RESUME SESSION).
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

AREA     ${area ?? 'UNKNOWN'}
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
		// terrain persistent, flights ephemeral : seule une session LANDED garde
		// son drone, donc seule elle se reprend. Un CRASHED est terminal.
		if (ls.result === 'LANDED' && areaKnown) {
			s.box.appendChild(button('RESUME SESSION',
				() => done({ slug: area, resume: ls.id }), 'terminal-cta'));
		}
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
	let nav = null;
	const close = () => { nav?.detach(); s.remove(); resolveScreen(); };
	const render = () => {
		const op = api.getOperator();
		s.box.innerHTML = `<pre>OPERATOR // ${op.name.toUpperCase()}

REGISTERED   ${String(op.createdAt).replace('T', ' ').slice(0, 16)}
SESSIONS     ${op.sessions?.length ?? 0}
TARGETS      ${op.targetLog?.length ?? 0}</pre>
			<div class="op-portrait" hidden></div>`;
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
	s.box.innerHTML = `<pre>BUILD NOTES

CURRENT BUILD   ${currentBuild(c)}

${unlockedNotes(c).map((n) => `${n.build}\n${n.lines.map((l) => `  ${l}`).join('\n')}`).join('\n\n')}</pre>`;
	return new Promise((resolve) => {
		s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
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
// LOG) et RESUME (depuis LAST SESSION) rendent tous deux un vol : les avaler ici
// laisserait l'opérateur sur un écran de journal après avoir demandé à voler.
//
// Résout undefined (retour à la Home), un slug, ou { slug, resume }.
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
				// lastSessionScreen rend un slug, { slug, resume }, ou rien.
				return typeof r === 'string' ? r : r ?? undefined;
			})],
			['SESSION LOG', () => behind(async () => {
				const { runSessionLog } = await import('./session-log.js');
				return await runSessionLog(root, { operator: api.getOperator(), scenes });
			})],
			['TARGET LOG', () => behind(async () => {
				const { runTargetLog } = await import('./session-log.js');
				await runTargetLog(root, { operator: api.getOperator() });
			})],
		]));

		s.box.appendChild(navRow([
			['CONTROL VECTOR', () => behind(() => controlVectorScreen(root, api))],
			['OPERATOR', () => behind(() => operatorScreen(root, api))],
			['BUILD NOTES', () => behind(() => buildNotesScreen(root, api.getOperator()))],
			['SETTINGS', () => settings?.toggleSettings(true)],
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

// ---------- terminal ----------

// Monte l'Operator Terminal et résout le slug de la zone à survoler.
// `settings` : instance de Settings (src/settings.js) — l'entrée SETTINGS ouvre
// le même panneau que Tab en vol.
// Résout { slug, resume } pour voler une zone cuite, { live: [lat, lon] } pour
// décoller en direct depuis le scanner, ou null pour remonter au choix de mode
// quand `back` est vrai (PHASE 26 : la Home n'est plus la racine du jeu).
export async function runTerminal(root, { settings, api = operatorApi, back = false } = {}) {
	let scenes = await fetchScenes();
	const s = screen(root, 'terminal-home');
	let resolveFly;

	let nav = null;
	// La zone sous le curseur : ce que la carte cadre et ce que [ FLY ] volera.
	// Choisie une première fois plus bas, puis par la liste compacte.
	let selected = null;
	// La carte vit entre deux rendus tant que la zone ne change pas : Leaflet
	// coûte un montage, et la Home se re-rend pour trois fois rien (retour de
	// l'ARCHIVE, d'une acquisition, d'un écran opérateur).
	let miniMap = null;
	const disposeMap = () => { miniMap?.destroy(); miniMap = null; };

	const render = () => {
		const model = terminalModel({ operator: api.getOperator(), scenes });
		const areas = Array.isArray(scenes) ? scenes : [];

		// Voler est ce qu'on fait à chaque session : l'action la plus fréquente a
		// une entrée directe et le curseur au repos (issue #123, point 5) — la
		// zone de la dernière session si elle est encore sur disque, sinon la
		// première zone locale. Sans terrain, le scanner reste l'entrée.
		if (!selected || !areas.some((a) => a.slug === selected)) {
			selected = areas.find((a) => a.slug === model.lastSession?.area)?.slug
				?? areas[0]?.slug ?? null;
		}
		const flyArea = areas.find((a) => a.slug === selected) ?? null;

		disposeMap();
		s.box.replaceChildren();

		const head = document.createElement('pre');
		head.textContent = `FPVTP! // 0.97b\nOPERATOR // ${model.operatorName}`;
		s.box.appendChild(head);

		// --- la carte, au centre
		//
		// L'endroit, pas des métriques : c'est le même fond que le GLOBAL SCANNER
		// (Bible §4), cadré sur l'emprise réellement acquise. Leaflet n'est
		// importé que si l'on a quelque chose à cadrer — la Home d'un opérateur
		// sans terrain ne le télécharge pas.
		const mapBox = document.createElement('div');
		mapBox.className = 'terminal-map';
		s.box.appendChild(mapBox);
		const bounds = flyArea ? previewBounds(flyArea) : null;
		if (bounds) {
			import('./mini-map.js')
				.then(({ mountMiniMap }) => {
					// L'écran a pu être démonté ou re-rendu pendant l'import.
					if (!mapBox.isConnected) return;
					miniMap = mountMiniMap(mapBox, { bounds });
				})
				.catch(() => { /* pas de carte, pas de drame : le reste tient */ });
		} else {
			const none = document.createElement('pre');
			none.className = 'terminal-map-none';
			none.textContent = flyArea ? 'NO MAP FOR THIS AREA' : 'NO LOCAL TERRAIN — ACQUIRE ONE';
			mapBox.appendChild(none);
		}

		// --- les deux seules choses qui décollent
		const acts = document.createElement('div');
		acts.className = 'terminal-acts';
		if (flyArea) {
			acts.appendChild(button(`FLY — ${flyArea.name.toUpperCase()}`, () => fly(flyArea.slug), 'terminal-cta'));
		}
		acts.appendChild(button('GLOBAL SCANNER', async () => {
			// Le scanner masque le terminal le temps de l'opération ; au retour la
			// Home est reconstruite, car une acquisition a pu changer le cache.
			s.el.hidden = true;
			const choice = await globalScanner(root);
			// Une zone cuite se vole par son slug ; un décollage en direct remonte
			// tel quel jusqu'à fieldLoop(), qui sait le faire traverser bootLive().
			if (choice?.slug) return fly(choice.slug);
			if (choice?.live) return flyLive(choice.live);
			scenes = await fetchScenes();
			s.el.hidden = false;
			render();
		}, 'terminal-cta terminal-scanner-cta'));
		s.box.appendChild(acts);

		// --- le cache terrain, juste sous la carte
		//
		// La liste SÉLECTIONNE, elle ne fait pas voler : cliquer une zone recadre
		// la carte et réétiquette le CTA. [ FLY ] reste la seule chose qui
		// décolle — deux façons de partir, ce serait deux axes sur un écran qui
		// n'en veut qu'un.
		if (areas.length) {
			const h = document.createElement('pre');
			h.className = 'terminal-sub';
			h.textContent = 'LOCAL TERRAIN';
			s.box.appendChild(h);

			const list = document.createElement('div');
			list.className = 'terminal-areas terminal-areas-compact';
			for (const sc of areas.slice(0, COMPACT_AREAS)) {
				const row = areaRow(sc, { onActivate: (picked) => { selected = picked.slug; render(); } });
				if (sc.slug === selected) row.dataset.selected = '1';
				list.appendChild(row);
			}
			s.box.appendChild(list);
		}

		// MORE… n'apparaît que s'il y a réellement plus à voir, ou de quoi
		// chercher/trier/supprimer — c'est l'écran complet, inchangé.
		const tail = [];
		if (areas.length) tail.push(['MORE…', async () => {
			const slug = await localTerrain(root, scenes);
			if (slug) fly(slug);
			else { scenes = await fetchScenes(); render(); }
		}]);
		tail.push(['ARCHIVE', async () => {
			s.el.hidden = true;
			const r = await archiveScreen(root, { model, api, scenes, settings });
			if (typeof r === 'string') return fly(r);
			if (r) return fly(r.slug, r.resume);
			s.el.hidden = false;
			// Une suppression a pu changer les compteurs du pied.
			render();
		}]);
		s.box.appendChild(navRow(tail));

		// --- le pied : ce qui n'est ni un lieu ni une action de vol
		s.box.appendChild(navRow([
			...(back ? [['MODE', () => leave()]] : []),
			['SETTINGS', () => settings?.toggleSettings(true)],
		]));

		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		s.box.appendChild(foot);
		nav?.focusAt(0);
	};

	// Toute sortie passe par ici : `s.remove()` détruit le nœud de la carte mais
	// pas les écouteurs que Leaflet a posés sur window. Sans map.remove(), une
	// Home ouverte trois fois laisse trois cartes vivantes derrière elle.
	const quit = (value) => { disposeMap(); nav?.detach(); s.remove(); resolveFly(value); };
	const fly = (slug, resume) => quit({ slug, resume });
	// Vol en direct : pas de slug, rien sur le disque. La Home ne fait que
	// transmettre — c'est fieldLoop() qui sait ce qu'un vol sans zone veut dire.
	const flyLive = (coords) => quit({ live: coords });
	// Remonter d'un cran : SELECT OPERATION MODE. Depuis PHASE 26 la Home n'est
	// plus la racine — mais elle l'est encore pour ?scene=, qui saute le choix
	// de mode, d'où le drapeau plutôt qu'un `back` inconditionnel.
	const leave = () => quit(null);
	render();
	nav = menuNav(s.el, back ? { back: leave } : {});
	return new Promise((resolve) => { resolveFly = resolve; });
}
