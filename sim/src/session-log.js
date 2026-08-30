// SESSION LOG / TARGET LOG (PHASE 17, Bible §28 et §30). Écrans client purs :
// `screen`/`button` de terminal.js, aucune dépendance Three/Rapier. Tout le
// formatage vit dans tools/session-log-model.mjs — ici, rien que du DOM.
//
// terminal.js importe ce module À LA DEMANDE (`await import`), comme il le fait
// déjà pour le scanner : un import statique fermerait un cycle, puisque ce
// fichier importe screen/button de terminal.js.
import { screen, button, fetchScenes } from './terminal.js';
import { menuNav, blockNav } from './menu-nav.js';
import * as operatorApi from './operator.js';
import {
	SESSION_FILTERS, filterSessions, sessionRow, sessionDetail,
	targetLogEntries, targetRow,
} from '../tools/session-log-model.mjs';

// Vignettes des captures. `dataUrl` n'existe que sur la réponse de la route
// dédiée (spec D4) — d'où le garde-fou : une session lue depuis le cache
// opérateur n'affiche simplement rien.
function gallery(photos) {
	const wrap = document.createElement('div');
	wrap.className = 'session-shots';
	for (const p of photos ?? []) {
		if (!p.dataUrl) continue;
		const img = document.createElement('img');
		img.src = p.dataUrl;
		img.alt = 'CAPTURE';
		wrap.appendChild(img);
	}
	return wrap;
}

// SESSION LOG (Bible §28). Liste filtrable, curseur ↑/↓, ←/→ change de filtre,
// Entrée ouvre la fiche, Échap revient — même grammaire que le TARGET SCAN.
// La grammaire vit dans menu-nav.js (issue #123) : chaque rangée est un vrai
// bouton, le curseur est le focus natif — cliquable, tabulable, lisible par
// une aide technique, et pilotable à la manette.
//
// Résout `undefined` (retour au terminal) ou un slug de zone (REVISIT AREA
// remonté depuis la fiche).
export function runSessionLog(root, { operator, scenes = null } = {}) {
	// Plus récent en haut : c'est ce que l'opérateur vient de vivre. Copie
	// locale, parce qu'une suppression la modifie sans toucher au cache.
	const all = [...(operator?.sessions ?? [])].reverse();

	return new Promise((resolve) => {
		let filter = 'ALL';
		let busy = false; // une fiche est ouverte : la liste ne réagit plus
		let done = false;
		let nav = null;

		const s = screen(root);
		const rows = () => filterSessions(all, filter);

		const finish = (value) => {
			if (done) return;
			done = true;
			nav?.detach();
			s.remove();
			resolve(value);
		};

		// `focusIdx` : la rangée où reposer le curseur après le re-rendu — celle
		// d'où l'on vient en refermant une fiche, la première sinon.
		const draw = (focusIdx = 0) => {
			const list = rows();
			s.box.innerHTML = '<pre>SESSION LOG</pre>';

			const wrap = document.createElement('div');
			wrap.className = 'terminal-list';
			if (list.length) {
				list.forEach((sess, i) => wrap.appendChild(button(sessionRow(sess), () => openAt(i), 'terminal-row')));
			} else {
				const empty = document.createElement('pre');
				empty.textContent = 'NO SESSIONS MATCH THIS FILTER';
				wrap.appendChild(empty);
			}
			s.box.appendChild(wrap);

			const filters = document.createElement('div');
			filters.className = 'terminal-nav';
			SESSION_FILTERS.forEach((f, i) => {
				if (i) filters.appendChild(document.createTextNode(' · '));
				// Le filtre actif se lit entre crochets — pas de classe dédiée, la
				// Home est calme (Bible §30).
				filters.appendChild(button(f === filter ? `[${f}]` : f, () => {
					filter = f;
					draw();
				}));
			});
			s.box.appendChild(filters);

			s.box.appendChild(button('BACK', () => finish(undefined), 'terminal-cta'));

			const rowEls = wrap.querySelectorAll('.terminal-row');
			(rowEls[Math.min(focusIdx, rowEls.length - 1)] ?? s.box.querySelector('button'))?.focus();
		};

		const openAt = async (i) => {
			if (busy || done) return;
			const sess = rows()[i];
			if (!sess) return;
			busy = true;
			s.el.style.display = 'none';
			const r = await runSessionDetail(root, sess.id, { scenes });
			if (r?.revisit) return finish(r.revisit);
			if (r?.deleted) {
				const k = all.findIndex((x) => x.id === r.deleted);
				if (k >= 0) all.splice(k, 1);
			}
			busy = false;
			s.el.style.display = '';
			draw(i);
		};

		nav = menuNav(s.el, {
			back: () => finish(undefined),
			// ←/→ change de filtre où que soit le curseur, comme avant.
			onDir: (dir) => {
				const d = dir === 'right' ? 1 : -1;
				const i = SESSION_FILTERS.indexOf(filter);
				filter = SESSION_FILTERS[(i + d + SESSION_FILTERS.length) % SESSION_FILTERS.length];
				draw();
				return true;
			},
			focusFirst: false, // draw() place lui-même le curseur
		});

		draw();
	});
}

// Détail d'une session (Bible §28). Charge la session COMPLÈTE via la route
// dédiée : c'est le seul endroit du jeu qui rapatrie les images.
//
// Résout `undefined` (retour), `{ revisit: slug }` ou `{ deleted: sessionId }`.
export async function runSessionDetail(root, sessionId, { scenes = null } = {}) {
	const s = screen(root);
	s.box.innerHTML = '<pre>SESSION\n\nREADING LOG…</pre>';

	// Pendant le chargement, cette fiche n'a encore rien à naviguer mais des
	// écrans restés visibles dessous en ont : bloquer la pile évite qu'une
	// flèche ou un bouton manette n'agisse derrière READING LOG… (issue #123).
	const unblock = blockNav(s.el);

	let session = null;
	let error = null;
	try { session = await operatorApi.getSession(sessionId); }
	catch (e) { error = e; }

	// L'écran a pu être démonté pendant la requête.
	if (!s.el.isConnected) { unblock(); return undefined; }

	if (error) {
		unblock();
		s.box.querySelector('pre').textContent = `SESSION\n\nLOG UNREADABLE — ${error.message}`;
		return new Promise((resolve) => {
			const close = () => { nav.detach(); s.remove(); resolve(undefined); };
			s.box.appendChild(button('BACK', close, 'terminal-cta'));
			const nav = menuNav(s.el, { back: close });
		});
	}

	// REVISIT n'est proposé que si la zone est encore sur disque. `scenes` vaut
	// `null` quand l'appelant ne l'a pas déjà : on le demande alors nous-mêmes.
	const known = scenes ?? await fetchScenes().catch(() => null);
	const areaKnown = Array.isArray(known) && known.some((sc) => sc.slug === session.area);
	if (!s.el.isConnected) { unblock(); return undefined; }
	unblock();

	return new Promise((resolve) => {
		let done = false;
		let nav = null;
		const finish = (value) => {
			if (done) return;
			done = true;
			nav?.detach();
			s.remove();
			resolve(value);
		};

		s.box.innerHTML = `<pre>${sessionDetail(session)}</pre>`;
		if (session.photos?.length) s.box.appendChild(gallery(session.photos));

		if (areaKnown) {
			// REVISIT AREA ne rejoue PAS la session (issue #54) : il rend le slug au
			// terminal, qui repart par le chemin de vol normal — TARGET SCAN frais,
			// météo courante, entry state neuf, terrain relu sur disque.
			s.box.appendChild(button('REVISIT AREA', () => finish({ revisit: session.area }), 'terminal-cta'));
		}
		s.box.appendChild(button('DELETE SESSION', async () => {
			if (done) return;
			try { await operatorApi.deleteSession(session.id); }
			catch (e) {
				console.warn('[session-log] suppression refusée', e);
				const warn = document.createElement('pre');
				warn.textContent = `\nDELETE REFUSED — ${e.message}`;
				s.box.appendChild(warn);
				return;
			}
			finish({ deleted: session.id });
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', () => finish(undefined), 'terminal-cta'));

		nav = menuNav(s.el, { back: () => finish(undefined) });
	});
}

// TARGET LOG (Bible §28, spec D5). Historique en LECTURE SEULE.
//
// Cet écran ne reçoit AUCUNE fonction de navigation vers le vol et n'en
// construit aucune : « aucune interaction du Target Log ne remet un drone en
// vol » (issue #54) est donc vrai par construction, pas par discipline. Ne pas
// y ajouter de bouton qui résout un slug.
export function runTargetLog(root, { operator } = {}) {
	const entries = targetLogEntries(operator?.sessions);
	const s = screen(root);
	const body = entries.length
		? entries.map((e) => `  ${targetRow(e)}`).join('\n')
		: '  NO TARGETS LOGGED';
	s.box.innerHTML = `<pre>TARGET LOG

A TARGET IS A TRACE. A CRASHED TARGET IS LOST, A LANDED ONE IS DONE.

${body}</pre>`;
	return new Promise((resolve) => {
		let done = false;
		let nav = null;
		const finish = () => {
			if (done) return;
			done = true;
			nav?.detach();
			s.remove();
			resolve(undefined);
		};
		s.box.appendChild(button('BACK', finish, 'terminal-cta'));
		nav = menuNav(s.el, { back: finish });
	});
}
