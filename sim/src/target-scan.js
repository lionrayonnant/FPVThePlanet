// TARGET SCAN (PHASE 08, Bible §15). Interaction courte : une liste de signaux,
// le joueur en choisit un. On n'affiche QUE ce qui est réellement connu avant
// le vol — jamais la famille, la caméra, les rates, la batterie.
//
// Écran client pur : rendu avec le look terminal (screen/button de terminal.js),
// aucune dépendance Three/Rapier. La génération vient de tools/target-model.mjs,
// bundlée par Vite.
import { screen, button } from './terminal.js';
import { generateTargetScan, describeTarget } from '../tools/target-model.mjs';
import { conditionsBlock, conditionsLine } from './weather.js';

// `weather` : le snapshot du monde pour cette zone (issue #76), résolu avant le
// scan par main.js. `null` si la zone n'a pas de coordonnées — on n'invente
// alors pas de météo, le bloc CONDITIONS est simplement absent.
export function runTargetScan(root, { seed, count, weather = null }) {
	const scan = generateTargetScan({ seed, count });
	const condBlock = conditionsBlock(weather);
	const condLine = conditionsLine(weather);
	return new Promise((resolve) => {
		let cursor = 0;
		let activeView = 'list'; // Track which view is showing: 'list' or 'sheet'

		const list = () => scan.candidates.map((c, i) => {
			const mark = i === cursor ? '>' : ' ';
			return `${mark} ${c.id}   ${String(c.rssiDbm).padStart(4)} dBm   ${c.mode}`;
		}).join('\n');

		const s = screen(root);
		const draw = () => {
			s.box.innerHTML = `<pre>TARGET SCAN

${condBlock ? `${condBlock.join('\n')}\n\n` : ''}SIGNALS DETECTED

${list()}</pre>`;
			s.box.appendChild(button('SELECT', () => sheet(cursor), 'terminal-cta'));
		};

		// Actions de la fiche : câblées à la fois aux boutons et au clavier (spec D5,
		// « ↑/↓ + Entrée … Deux frappes, pas plus »). Réassignées à chaque ouverture
		// de fiche pour capturer l'index et le handle d'écran courants.
		let sheetConfirm = null;
		let sheetBack = null;

		const onKey = (e) => {
			if (activeView === 'sheet') {
				// Fiche affichée : Entrée = CONFIRM, Échap/Retour = BACK, flèches inertes
				// (mais preventDefault pour que la page ne défile pas).
				if (e.key === 'Enter') { e.preventDefault(); sheetConfirm?.(); }
				else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); sheetBack?.(); }
				else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); }
				return;
			}

			if (e.key === 'ArrowDown') {
				e.preventDefault();
				cursor = (cursor + 1) % scan.candidates.length;
				draw();
			}
			else if (e.key === 'ArrowUp') {
				e.preventDefault();
				cursor = (cursor - 1 + scan.candidates.length) % scan.candidates.length;
				draw();
			}
			else if (e.key === 'Enter') {
				sheet(cursor);
			}
		};
		window.addEventListener('keydown', onKey);

		const finish = (index) => {
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve({ seed: scan.seed, count: scan.count, index });
		};

		const sheet = (index) => {
			activeView = 'sheet';
			s.el.style.display = 'none'; // Hide list screen while sheet is shown

			const d = describeTarget(scan.candidates[index]);
			const s2 = screen(root);
			s2.box.innerHTML = `<pre>TARGET ${scan.candidates[index].id}

LOCATION       ${d.location}
SIGNAL         ${d.signal}
DEVICE         ${d.device}${d.deviceHint ? `  (EST. ${d.deviceHint})` : ''}
VIDEO          ${d.video}${d.videoHint ? `  (EST. ${d.videoHint})` : ''}
CONTROL        ${d.control}
FLIGHT STATE   ${d.flightState}${condLine ? `\n\nCONDITIONS     ${condLine}` : ''}</pre>`;

			let done = false;
			sheetConfirm = () => {
				if (done) return;
				done = true;
				s2.remove();
				finish(index);
			};
			sheetBack = () => {
				if (done) return;
				done = true;
				s2.remove();
				activeView = 'list'; // Switch back to list
				s.el.style.display = ''; // Restore list visibility
				sheetConfirm = null;
				sheetBack = null;
				draw();
			};
			s2.box.appendChild(button('CONFIRM', () => sheetConfirm(), 'terminal-cta'));
			s2.box.appendChild(button('BACK', () => sheetBack(), 'terminal-cta'));
		};

		draw();
	});
}
