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
import { uiAudio } from './ui-audio.js';
import { mount, sayOnce } from './dialogue.js';
import { scanContext } from './dialogue-context.js';

// Bloc RTC partagé par la liste et la fiche : même markup que scanner.js
// (`.sc-block .sc-log-block .sc-rtc-block`), pour une seule langue visuelle
// entre toutes les voix du crew.
const rtcMarkup = '<pre class="sc-h">RTC // INTERNAL</pre><pre class="sc-log sc-rtc"></pre>';
function appendRtc(box) {
	const el = document.createElement('section');
	el.className = 'sc-block sc-log-block sc-rtc-block';
	el.innerHTML = rtcMarkup;
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
		let cursor = 0;
		let activeView = 'list'; // Track which view is showing: 'list' or 'sheet'

		const list = () => scan.candidates.map((c, i) => {
			const mark = i === cursor ? '>' : ' ';
			return `${mark} ${c.id}   ${String(c.rssiDbm).padStart(4)} dBm   ${c.mode}`;
		}).join('\n');

		const s = screen(root);
		// Piège : draw() tourne à chaque flèche. Si le RTC vivait dans ce <pre>,
		// la première frappe détruirait son nœud pendant que ses minuteurs
		// continuent d'écrire dans le vide. La liste vit donc dans son propre
		// <pre>, seul reconstruit par draw() — le RTC et le bouton SELECT sont
		// ajoutés une fois, hors de la zone redessinée.
		const listPre = document.createElement('pre');
		s.box.appendChild(listPre);
		const draw = () => {
			listPre.textContent = `TARGET SCAN

${condBlock ? `${condBlock.join('\n')}\n\n` : ''}SIGNALS DETECTED

${list()}`;
		};
		draw();
		// `cursor` est lu au clic, pas capturé : SELECT n'a pas besoin d'être
		// recréé à chaque déplacement.
		s.box.appendChild(button('SELECT', () => sheet(cursor), 'terminal-cta'));
		appendRtc(s.box);
		const stopScan = mount(s.box.querySelector('.sc-rtc'), {
			event: 'TARGET_SCAN',
			context: () => scanContext({ scan, weather }),
		});

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
			stopScan();
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
VIDEO          ${d.video}
CONTROL        ${d.control}
FLIGHT STATE   ${d.flightState}${condLine ? `\n\nCONDITIONS     ${condLine}` : ''}</pre>`;
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
			sheetConfirm = () => {
				if (done) return;
				done = true;
				uiAudio.play('TARGET_FOUND');
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
	});
}
