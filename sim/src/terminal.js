// Operator Terminal (PHASE 02, Bible §11–17). Remplace le menu « Choisir une
// carte » (ancien Hud.showMenu) et l'ancienne Home minimale (home.js supprimé).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD y est
// déjà. Tout le texte d'interface est en anglais (D5).
import * as operatorApi from './operator.js';
import { captureControlVector, bootstrap } from './bootstrap.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

function screen(root, cls = '') {
	const el = document.createElement('div');
	el.className = `bootstrap terminal ${cls}`.trim();
	el.innerHTML = '<div class="bootstrap-box terminal-box"></div>';
	root.appendChild(el);
	return { el, box: el.querySelector('.terminal-box'), remove: () => el.remove() };
}

function button(label, onClick, cls = 'terminal-link') {
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

async function fetchScenes() {
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
		s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
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

// ---------- LOCAL TERRAIN ----------

// Résout un slug (→ vol) ou undefined (→ retour au terminal).
function localTerrain(root, scenes) {
	const s = screen(root);
	return new Promise((resolve) => {
		if (scenes === null) {
			s.box.innerHTML = '<pre>LOCAL TERRAIN\n\nTERRAIN CACHE UNREACHABLE</pre>';
			s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
			return;
		}
		if (scenes.length === 0) {
			s.box.innerHTML = '<pre>LOCAL TERRAIN\n\nNO LOCAL TERRAIN — ACQUIRE ONE</pre>';
			// Pas de renvoi vers une page d'acquisition : le scanner EST l'entrée.
			s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
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
			row.append(name, size, button('OPEN', () => { s.remove(); resolve(sc.slug); }, 'terminal-cta'));
			list.appendChild(row);
		}
		s.box.appendChild(list);
		s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
	});
}

// ---------- CONTROL VECTOR ----------

async function controlVectorScreen(root, api) {
	const s = screen(root);
	let revealed = false;
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
			const v = await captureControlVector(root, op.controlVector?.length || 6);
			api.patch('controlVector', v);
			try { await api.flush(); } catch { /* réessai automatique côté operator.js */ }
			revealed = true;
			render();
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', () => { s.remove(); resolveScreen(); }, 'terminal-cta'));
	};
	let resolveScreen;
	render();
	return new Promise((resolve) => { resolveScreen = resolve; });
}

// ---------- LAST SESSION ----------

// Résout un slug (REVISIT AREA) ou undefined.
function lastSessionScreen(root, model) {
	const s = screen(root);
	return new Promise((resolve) => {
		const ls = model.lastSession;
		if (!ls) {
			s.box.innerHTML = '<pre>LAST SESSION — NONE YET</pre>';
			s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
			return;
		}
		const area = ls.area ?? ls.slug ?? null;
		const when = ls.endedAt ?? ls.startedAt ?? ls.at ?? '';
		s.box.innerHTML = `<pre>LAST SESSION

AREA     ${area ?? 'UNKNOWN'}
WHEN     ${String(when).replace('T', ' ').slice(0, 16) || 'UNKNOWN'}</pre>`;
		s.box.appendChild(button('VIEW SESSION', async () => {
			await stub(root, 'VIEW SESSION', 'Session detail screen lands in PHASE 15.');
		}, 'terminal-cta'));
		if (area && model.areas.some((a) => a.slug === area)) {
			s.box.appendChild(button('REVISIT AREA', () => { s.remove(); resolve(area); }, 'terminal-cta'));
		}
		s.box.appendChild(button('BACK', () => { s.remove(); resolve(); }, 'terminal-cta'));
	});
}

// ---------- OPERATOR ----------

async function operatorScreen(root, api) {
	const s = screen(root);
	let resolveScreen;
	const render = () => {
		const op = api.getOperator();
		s.box.innerHTML = `<pre>OPERATOR // ${op.name.toUpperCase()}

REGISTERED   ${String(op.createdAt).replace('T', ' ').slice(0, 16)}
SESSIONS     ${op.sessions?.length ?? 0}
TARGETS      ${op.targetLog?.length ?? 0}</pre>
			<div class="op-portrait" hidden></div>`;
		s.box.appendChild(button('SWITCH OPERATOR', async () => {
			const list = await api.listOperators();
			const pick = await operatorSelect(root, list);
			if (pick.create) await bootstrap(root);
			else await api.selectOperator(pick.id);
			render();
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', () => { s.remove(); resolveScreen(); }, 'terminal-cta'));
	};
	render();
	return new Promise((resolve) => { resolveScreen = resolve; });
}

// ---------- OPERATOR SELECT (repris de l'ancienne home.js) ----------

export async function operatorSelect(root, choices) {
	const s = screen(root);
	s.box.innerHTML = '<pre>OPERATOR SELECT</pre>';
	return new Promise((resolve) => {
		for (const c of choices) {
			s.box.appendChild(button(c.name.toUpperCase(), () => { s.remove(); resolve({ id: c.id }); }, 'terminal-cta'));
		}
		s.box.appendChild(button('+ NEW OPERATOR', () => { s.remove(); resolve({ create: true }); }, 'terminal-cta'));
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

	const render = () => {
		const model = terminalModel({ operator: api.getOperator(), scenes });
		s.box.innerHTML = `<pre>FPVTP! // 0.97b
OPERATOR // ${model.operatorName}</pre>`;

		s.box.appendChild(navRow([
			['LAST SESSION', async () => { const slug = await lastSessionScreen(root, model); if (slug) fly(slug); }],
			['LOCAL TERRAIN', async () => { const slug = await localTerrain(root, scenes); if (slug) fly(slug); }],
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
			['SESSION LOG', () => stub(root, 'SESSION LOG', 'NO SESSIONS YET — the session log lands in PHASE 15.')],
			['TARGET LOG', () => stub(root, 'TARGET LOG', 'NO TARGETS LOGGED — the target log lands in PHASE 17.')],
			['SETTINGS', () => settings?.toggleSettings(true)],
			['OPERATOR', async () => { await operatorScreen(root, api); render(); }],
		]));

		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		s.box.appendChild(foot);
	};

	const fly = (slug) => { s.remove(); resolveFly(slug); };
	render();
	return new Promise((resolve) => { resolveFly = resolve; });
}
