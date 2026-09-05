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

// Plus de RTC sur TARGET SCAN depuis #243 : ni sur la liste, ni sur la fiche.
// Le crew ne commente plus l'écran qu'on regarde — il parle sur la racine, et
// en toast pendant le hack et l'acquisition. TARGET_SCAN, TARGET_SELECTED et
// WEATHER restent dans le flux mêlé de la racine.

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

		// Échap / bouton B ressort vers le choix de zone. L'écran ne sait pas ce
		// que ça coûte — à cet instant main.js a déjà lancé le préchargement de
		// la carte — donc il se contente de le signaler et laisse l'appelant
		// décider : les écrans restent des clients purs.
		const cancel = () => {
			listNav.detach();
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
