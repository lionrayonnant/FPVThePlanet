// L'écran JUKEBOX (issue #120). Une VUE sur src/radio.js, rien de plus : il
// s'abonne, il repeint, et il ne possède jamais la lecture. Fermer cet écran
// n'arrête pas la radio — c'est tout l'intérêt de la fonctionnalité.
//
// Même grammaire que src/session-log.js : une liste de vrais boutons, le
// curseur EST le focus natif, Échap remonte. Deux différences assumées :
//
//   1. ←/→ pilotent la TRANSPORT et non le filtre. C'est l'idiome radio, et
//      c'est ce que « comme une radio » veut dire. Le filtre de pool reste une
//      rangée de boutons qu'on atteint au curseur.
//   2. draw() et paint() sont séparés. L'enchaînement automatique survient
//      pendant que l'opérateur parcourt la liste : un replaceChildren() à cet
//      instant lui arracherait le curseur des mains en plein défilement. paint()
//      ne réécrit que du texte.
import { screen, button, keyHints } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { radio } from './radio.js';
import {
	libraryFilters, filterLibrary, jukeboxRow, nowPlayingLine, librarySummary,
} from '../tools/jukebox-model.mjs';

// Résout quand on remonte au choix de voie. Ne rend rien : il n'y a rien à
// rapporter d'une écoute.
export function runJukebox(root) {
	return new Promise((resolve) => {
		let done = false;
		let nav = null;
		let off = () => {};
		let library = [];
		let shown = [];
		let filter = 'ALL';
		let rowEls = [];
		let nowEl = null;
		let toggleEl = null;

		const s = screen(root, 'terminal-jukebox');

		const finish = () => {
			if (done) return;
			done = true;
			nav?.detach();
			// Sans ce désabonnement, la fermeture laisserait un rappel retenir un
			// arbre DOM détaché pour le reste de la session.
			off();
			s.remove();
			resolve();
		};

		// À l'antenne : c'est la radio qui le sait, pas l'écran.
		const onAir = (track) => radio.owns && radio.current?.id === track.id;

		// Ne réécrit QUE du texte — aucun nœud n'est créé ni remplacé.
		const paint = () => {
			if (done) return;
			if (nowEl) nowEl.textContent = nowPlayingLine(radio.owns ? radio.current : null);
			if (toggleEl) toggleEl.textContent = radio.playing ? 'STOP' : 'PLAY';
			shown.forEach((track, i) => {
				const el = rowEls[i];
				if (el) el.textContent = jukeboxRow(track, { playing: onAir(track) });
			});
		};

		const draw = (focusIdx = 0) => {
			shown = filterLibrary(library, filter);
			s.box.replaceChildren();

			const title = document.createElement('pre');
			title.textContent = 'JUKEBOX';
			s.box.appendChild(title);

			const summary = document.createElement('pre');
			summary.className = 'terminal-foot';
			summary.textContent = librarySummary(library);
			s.box.appendChild(summary);

			// terminal-log porte déjà le niveau DATA et les chiffres tabulaires :
			// la ligne d'antenne s'aligne sur les rangées sans une règle de plus.
			nowEl = document.createElement('pre');
			nowEl.className = 'terminal-log';
			s.box.appendChild(nowEl);

			const wrap = document.createElement('div');
			wrap.className = 'terminal-list';
			if (shown.length) {
				shown.forEach((track, i) => {
					wrap.appendChild(button(
						jukeboxRow(track, { playing: onAir(track) }),
						// La liste AFFICHÉE devient la programmation : filtrer sur
						// RACE5 puis lancer donne une radio race5.
						() => { radio.playAt(i, shown).catch(() => {}); },
						'terminal-row',
					));
				});
			} else {
				const empty = document.createElement('pre');
				empty.textContent = library.length ? 'NO TRACK IN THIS POOL' : 'NO MUSIC LIBRARY';
				wrap.appendChild(empty);
			}
			s.box.appendChild(wrap);
			rowEls = wrap.querySelectorAll('.terminal-row');

			const filters = document.createElement('div');
			filters.className = 'terminal-nav';
			libraryFilters(library).forEach((f, i) => {
				if (i) filters.appendChild(document.createTextNode(' · '));
				const label = f.toUpperCase();
				// Le filtre actif se lit entre crochets, comme le SESSION LOG :
				// pas de classe dédiée, la maison est calme (Bible §30).
				filters.appendChild(button(f === filter ? `[${label}]` : label, () => {
					filter = f;
					draw();
				}));
			});
			s.box.appendChild(filters);

			const transport = document.createElement('div');
			transport.className = 'terminal-nav';
			transport.appendChild(button('PREV', () => { radio.prev().catch(() => {}); }));
			transport.appendChild(document.createTextNode(' · '));
			toggleEl = button('PLAY', () => { radio.toggle().catch(() => {}); });
			transport.appendChild(toggleEl);
			transport.appendChild(document.createTextNode(' · '));
			transport.appendChild(button('NEXT', () => { radio.next().catch(() => {}); }));
			s.box.appendChild(transport);

			s.box.appendChild(button('BACK', () => finish(), 'terminal-cta'));
			// Le JUKEBOX est directement sous la racine : Échap y remonte, et il le
			// dit — comme le banc (src/bench.js).
			s.box.appendChild(keyHints([['ESC', 'OPERATION MODE'], ['←/→', 'PREV / NEXT']]));

			paint();
			(rowEls[Math.min(focusIdx, rowEls.length - 1)] ?? s.box.querySelector('button'))?.focus();
		};

		nav = menuNav(s.el, {
			back: () => finish(),
			// La transport, où que soit le curseur.
			onDir: (dir) => {
				if (dir === 'right') radio.next().catch(() => {});
				else if (dir === 'left') radio.prev().catch(() => {});
				else return false;
				return true;
			},
			focusFirst: false,   // draw() place lui-même le curseur
		});

		off = radio.onChange(paint);

		draw();
		// La bibliothèque est presque toujours déjà là (la musique de menu a
		// chargé le manifeste au premier geste) : ready() est mémoïsé et rend la
		// main dans une microtâche. Le premier draw() évite l'écran vide dans le
		// cas contraire.
		radio.ready().then((lib) => {
			if (done) return;
			library = lib;
			draw();
		});
	});
}
