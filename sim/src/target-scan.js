// TARGET SCAN (PHASE 08, Bible §15). Interaction courte : une liste de signaux,
// le joueur en choisit un. On n'affiche QUE ce qui est réellement connu avant
// le vol — jamais la famille, la caméra, les rates, la batterie.
//
// Écran client pur : rendu avec le look terminal (screen/button de terminal.js),
// aucune dépendance Three/Rapier. La génération vient de tools/target-model.mjs,
// bundlée par Vite. La grammaire ↑/↓ + Entrée vit dans menu-nav.js (issue
// #123) : chaque signal est un vrai bouton, le curseur est le focus natif —
// cliquable, tabulable, et pilotable à la manette.
import { screen, button } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { generateTargetScan, describeTarget } from '../tools/target-model.mjs';
import { conditionsBlock, conditionsLine } from './weather.js';
import { uiAudio } from './ui-audio.js';
import { mount, sayOnce } from './dialogue.js';
import { scanContext } from './dialogue-context.js';

// Bloc RTC partagé par la liste et la fiche : même markup que scanner.js
// (`.sc-block .sc-log-block .sc-rtc-block`), pour une seule langue visuelle
// entre toutes les voix du crew.
function appendRtc(box) {
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
	return el;
}

// `weather` : le snapshot du monde pour cette zone (issue #76), résolu avant le
// scan par main.js. `null` si la zone n'a pas de coordonnées — on n'invente
// alors pas de météo, le bloc CONDITIONS est simplement absent.
export function runTargetScan(root, { seed, count, weather = null }) {
	const scan = generateTargetScan({ seed, count });
	const condBlock = conditionsBlock(weather);
	const condLine = conditionsLine(weather);
	return new Promise((resolve) => {
		const s = screen(root);
		// createElement plutôt qu'innerHTML, comme screen() lui-même : c'est ce
		// qui rend l'écran montable sur le faux DOM, donc testable sans
		// navigateur (tools/target-scan-render-selftest.mjs, issue #73).
		const head = document.createElement('pre');
		head.textContent = `TARGET SCAN\n\n${condBlock ? `${condBlock.join('\n')}\n\n` : ''}SIGNALS DETECTED`;
		s.box.appendChild(head);

		const wrap = document.createElement('div');
		wrap.className = 'terminal-list';
		scan.candidates.forEach((c, i) => {
			const row = `${c.id}   ${String(c.rssiDbm).padStart(4)} dBm   ${c.mode}`;
			wrap.appendChild(button(row, () => sheet(i), 'terminal-row'));
		});
		s.box.appendChild(wrap);

		// Le RTC vit sous la liste. Depuis l'issue #123 la liste n'est plus
		// redessinée — chaque signal est un vrai bouton et le curseur est le
		// focus natif — donc ce nœud survit jusqu'au démontage explicite.
		appendRtc(s.box);
		const stopScan = mount(s.box.querySelector('.sc-rtc'), {
			event: 'TARGET_SCAN',
			context: () => scanContext({ scan, weather }),
		});

		// Échap / bouton B ressort vers le choix de zone. L'écran ne sait pas ce
		// que ça coûte — à cet instant main.js a déjà lancé le préchargement de
		// la carte — donc il se contente de le signaler et laisse l'appelant
		// décider : les écrans restent des clients purs.
		const cancel = () => {
			listNav.detach();
			stopScan();
			s.remove();
			resolve({ cancelled: true });
		};

		const listNav = menuNav(s.el, { back: cancel });

		// Vue courante de l'écran. Une fiche déjà ouverte interdit d'en ouvrir
		// une seconde (issue #73) : quand la même frappe atteint à la fois le
		// bouton focalisé et un autre chemin d'activation, `sheet()` était
		// appelée deux fois et deux fiches s'empilaient sur la liste. Récupérable
		// au BACK, mais l'écran mentait sur l'endroit où on se trouve.
		let activeView = 'list';

		const finish = (index) => {
			listNav.detach();
			stopScan();
			s.remove();
			resolve({ seed: scan.seed, count: scan.count, index });
		};

		const sheet = (index) => {
			if (activeView !== 'list') return;
			activeView = 'sheet';
			s.el.style.display = 'none'; // la liste attend derrière la fiche

			const d = describeTarget(scan.candidates[index]);
			const s2 = screen(root);
			const sheetPre = document.createElement('pre');
			sheetPre.textContent = [
				`TARGET ${scan.candidates[index].id}`,
				'',
				`LOCATION       ${d.location}`,
				`SIGNAL         ${d.signal}`,
				`DEVICE         ${d.device}${d.deviceHint ? `  (EST. ${d.deviceHint})` : ''}`,
				`VIDEO          ${d.video}`,
				`CONTROL        ${d.control}`,
				`FLIGHT STATE   ${d.flightState}${condLine ? `\n\nCONDITIONS     ${condLine}` : ''}`,
			].join('\n');
			s2.box.appendChild(sheetPre);
			appendRtc(s2.box);

			// Un seul échange à l'ouverture de la fiche. La météo est déjà affichée
			// juste au-dessus par CONDITIONS : on ne la fait commenter par le crew
			// que si la cible n'a rien dit — cascade sur le `null` que sayOnce rend
			// déjà pour « silence », sans exposer la mémoire hors de dialogue.js.
			// Ni l'un ni l'autre n'est attendu : ça ne bloque jamais CONFIRM/BACK.
			const paint = (lines) => {
				const el = s2.box.querySelector('.sc-rtc');
				if (!el) return;
				for (const l of lines) el.appendChild(document.createTextNode(`\n> ${l.speaker}\n${l.text}\n`));
				el.scrollTop = el.scrollHeight;
			};
			sayOnce('TARGET_SELECTED', scanContext({ scan, weather, candidate: scan.candidates[index] }))
				.then((lines) => lines
					? paint(lines)
					: sayOnce('WEATHER', scanContext({ scan, weather })).then((w) => w && paint(w)));

			let done = false;
			const confirm = () => {
				if (done) return;
				done = true;
				sheetNav.detach();
				uiAudio.play('TARGET_FOUND');
				s2.remove();
				finish(index);
			};
			const back = () => {
				if (done) return;
				done = true;
				activeView = 'list';
				sheetNav.detach();
				s2.remove();
				s.el.style.display = ''; // la liste reprend la main (pile de navs)
				listNav.focusAt(index);
			};
			s2.box.appendChild(button('CONFIRM', confirm, 'terminal-cta'));
			s2.box.appendChild(button('BACK', back, 'terminal-cta'));
			// Le curseur se pose sur CONFIRM : « ↑/↓ + Entrée … Deux frappes, pas
			// plus » (spec D5) reste vrai, au clavier comme à la manette.
			const sheetNav = menuNav(s2.el, { back });
		};
	});
}
