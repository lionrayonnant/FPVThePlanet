// SESSION LOG / TARGET LOG (PHASE 17, Bible §28 et §30). Écrans client purs :
// `screen`/`button` de terminal.js, aucune dépendance Three/Rapier. Tout le
// formatage vit dans tools/session-log-model.mjs — ici, rien que du DOM.
//
// terminal.js importe ce module À LA DEMANDE (`await import`), comme il le fait
// déjà pour le scanner : un import statique fermerait un cycle, puisque ce
// fichier importe screen/button de terminal.js.
import { screen, button, fetchScenes } from './terminal.js';
import * as operatorApi from './operator.js';
import { sessionDetail } from '../tools/session-log-model.mjs';

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

// Détail d'une session (Bible §28). Charge la session COMPLÈTE via la route
// dédiée : c'est le seul endroit du jeu qui rapatrie les images.
//
// Résout `undefined` (retour), `{ revisit: slug }` ou `{ deleted: sessionId }`.
export async function runSessionDetail(root, sessionId, { scenes = null } = {}) {
	const s = screen(root);
	s.box.innerHTML = '<pre>SESSION\n\nREADING LOG…</pre>';

	let session = null;
	let error = null;
	try { session = await operatorApi.getSession(sessionId); }
	catch (e) { error = e; }

	// L'écran a pu être démonté pendant la requête.
	if (!s.el.isConnected) return undefined;

	if (error) {
		s.box.querySelector('pre').textContent = `SESSION\n\nLOG UNREADABLE — ${error.message}`;
		return new Promise((resolve) => {
			s.box.appendChild(button('BACK', () => { s.remove(); resolve(undefined); }, 'terminal-cta'));
		});
	}

	// REVISIT n'est proposé que si la zone est encore sur disque. `scenes` vaut
	// `null` quand l'appelant ne l'a pas déjà : on le demande alors nous-mêmes.
	const known = scenes ?? await fetchScenes().catch(() => null);
	const areaKnown = Array.isArray(known) && known.some((sc) => sc.slug === session.area);
	if (!s.el.isConnected) return undefined;

	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			window.removeEventListener('keydown', onKey);
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

		function onKey(e) {
			if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); finish(undefined); }
		}
		window.addEventListener('keydown', onKey);
	});
}
