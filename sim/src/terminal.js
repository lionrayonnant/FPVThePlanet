// Operator Terminal (PHASE 02, Bible §11–17). Remplace le menu « Choisir une
// carte » (ancien Hud.showMenu) et l'ancienne Home minimale (home.js supprimé).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD y est
// déjà. Tout le texte d'interface est en anglais (D5).
import * as operatorApi from './operator.js';
import { captureControlVector, bootstrap } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';
import { worldWeather, formatForecast, headline, severity as weatherSeverity, today as weatherToday } from './weather.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

export function screen(root, cls = '') {
	const el = document.createElement('div');
	el.className = `bootstrap terminal ${cls}`.trim();
	el.innerHTML = '<div class="bootstrap-box terminal-box"></div>';
	root.appendChild(el);
	return { el, box: el.querySelector('.terminal-box'), remove: () => el.remove() };
}

export function button(label, onClick, cls = 'terminal-link') {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = cls === 'terminal-cta' ? `[ ${label} ]` : label;
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
// l'opérateur ouvre le scanner. Résout un slug (→ vol) ou undefined.
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

// ---------- LOCAL TERRAIN ----------

// Résout un slug (→ vol) ou undefined (→ retour au terminal).
function localTerrain(root, scenes) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		const done = (slug) => { nav?.detach(); s.remove(); resolve(slug); };
		if (scenes === null || scenes.length === 0) {
			// Pas de renvoi vers une page d'acquisition : le scanner EST l'entrée.
			s.box.innerHTML = `<pre>LOCAL TERRAIN\n\n${scenes === null
				? 'TERRAIN CACHE UNREACHABLE' : 'NO LOCAL TERRAIN — ACQUIRE ONE'}</pre>`;
			s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
			nav = menuNav(s.el, { back: () => done() });
			return;
		}
		s.box.innerHTML = '<pre>LOCAL TERRAIN</pre>';
		const list = document.createElement('div');
		list.className = 'terminal-areas';
		for (const sc of scenes) {
			const row = document.createElement('div');
			row.className = 'terminal-area';
			const name = document.createElement('span');
			name.textContent = sc.name;
			const size = document.createElement('span');
			size.className = 'terminal-area-size';
			size.textContent = formatBytes(sc.bytes);
			// Le temps qu'il fait là-bas, pas un réglage : la ligne se remplit
			// quand le world state répond, et reste vide s'il ne répond pas.
			const sky = document.createElement('span');
			sky.className = 'terminal-area-weather';
			sky.textContent = '…';
			worldWeather({ lat: sc.lat, lon: sc.lon })
				.then((snap) => {
					const t = snap && weatherToday(snap);
					sky.textContent = t ? headline(t) : '';
					// La couleur ne sort que si les conditions changent la décision
					// de voler (PHASE 19, Bible §38) : `nominal` ne pose rien et la
					// ligne reste en encre neutre.
					const sev = t ? weatherSeverity(t) : 'nominal';
					if (sev !== 'nominal') sky.dataset.severity = sev;
					else delete sky.dataset.severity;
				})
				.catch(() => { sky.textContent = ''; delete sky.dataset.severity; });
			row.append(name, size, sky,
				button('FORECAST', () => forecastScreen(root, sc)),
				button('OPEN', () => done(sc.slug), 'terminal-cta'));
			list.appendChild(row);
		}
		s.box.appendChild(list);
		s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
		nav = menuNav(s.el, { back: () => done() });
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
		s.box.appendChild(button('SWITCH OPERATOR', async () => {
			// Masqué pendant la sélection et un éventuel bootstrapping : la pile
			// de navs (menu-nav.js) rend la main à l'écran monté par-dessus.
			s.el.hidden = true;
			const list = await api.listOperators();
			const pick = await operatorSelect(root, list);
			if (pick.create) await bootstrap(root);
			else await api.selectOperator(pick.id);
			s.el.hidden = false;
			render();
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', close, 'terminal-cta'));
		nav?.focusAt(0);
	};
	render();
	nav = menuNav(s.el, { back: close });
	return new Promise((resolve) => { resolveScreen = resolve; });
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
export async function runTerminal(root, { settings, api = operatorApi } = {}) {
	let scenes = await fetchScenes();
	const s = screen(root, 'terminal-home');
	let resolveFly;

	let nav = null;
	const render = () => {
		const model = terminalModel({ operator: api.getOperator(), scenes });
		s.box.innerHTML = `<pre>FPVTP! // 0.97b
OPERATOR // ${model.operatorName}</pre>`;

		// Voler est ce qu'on fait à chaque session : l'action la plus fréquente a
		// une entrée directe et le curseur au repos (issue #123, point 5) — la
		// zone de la dernière session si elle est encore sur disque, sinon la
		// première zone locale. Sans terrain, le scanner reste l'entrée.
		const flyArea = model.areas.find((a) => a.slug === model.lastSession?.area) ?? model.areas[0];
		if (flyArea) {
			s.box.appendChild(button(`FLY — ${flyArea.name.toUpperCase()}`, () => fly(flyArea.slug), 'terminal-cta'));
		}

		s.box.appendChild(navRow([
			['LAST SESSION', async () => {
				const r = await lastSessionScreen(root, model);
				if (typeof r === 'string') fly(r);
				else if (r) fly(r.slug, r.resume);
				else nav?.focusAt(0);
			}],
			['LOCAL TERRAIN', async () => {
				const slug = await localTerrain(root, scenes);
				if (slug) fly(slug);
				else nav?.focusAt(0);
			}],
			['CONTROL VECTOR', async () => { await controlVectorScreen(root, api); render(); }],
		]));

		s.box.appendChild(button('GLOBAL SCANNER', async () => {
			// Le scanner masque le terminal le temps de l'opération ; au retour la
			// Home est reconstruite, car une acquisition a pu changer le cache.
			s.el.hidden = true;
			const slug = await globalScanner(root);
			if (slug) return fly(slug);
			scenes = await fetchScenes();
			s.el.hidden = false;
			render();
		}, 'terminal-cta'));

		s.box.appendChild(navRow([
			['SESSION LOG', async () => {
				s.el.hidden = true;
				const { runSessionLog } = await import('./session-log.js');
				const slug = await runSessionLog(root, { operator: api.getOperator(), scenes });
				if (slug) return fly(slug);
				s.el.hidden = false;
				// Une suppression a pu changer les compteurs du footer.
				render();
			}],
			['TARGET LOG', async () => {
				s.el.hidden = true;
				const { runTargetLog } = await import('./session-log.js');
				await runTargetLog(root, { operator: api.getOperator() });
				s.el.hidden = false;
				render();
			}],
			['SETTINGS', () => settings?.toggleSettings(true)],
			['OPERATOR', async () => { await operatorScreen(root, api); render(); }],
		]));

		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		s.box.appendChild(foot);
		nav?.focusAt(0);
	};

	const fly = (slug, resume) => { nav?.detach(); s.remove(); resolveFly({ slug, resume }); };
	render();
	// Pas de `back` : la Home est la racine, il n'y a rien au-dessus.
	nav = menuNav(s.el, {});
	return new Promise((resolve) => { resolveFly = resolve; });
}
