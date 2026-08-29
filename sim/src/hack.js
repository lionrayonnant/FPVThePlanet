// AUTOMATED ANALYSIS (PHASE 09, Bible §16–18). S'intercale entre le TARGET SCAN
// (PHASE 08) et le vol. Joue un log automatique fixe, un motif visuel propre à
// la famille de hack, puis se fige sur MANUAL OVERRIDE REQUIRED + un bouton
// [ JACK IN ] PROVISOIRE, armé seulement une fois le log joué — un Entrée
// maintenu/répété depuis le TARGET SCAN ne peut plus zapper l'écran (le rituel réel — CONTROL VECTOR + QTE — est PHASE 10).
//
// Écran client pur : look terminal (screen/button de terminal.js), AUCUNE
// dépendance Three/Rapier/physics. Jamais importé par le moteur.
//
// Règle de sécurité (spec PHASE 09) : le log est un texte fixe de quatre lignes
// (deux lignes de statut, une ligne vide, la sommation MANUAL OVERRIDE), les motifs
// sont des animations décoratives. Aucune trame, aucun outil, aucune séquence
// exploitable.
import { screen, button } from './terminal.js';
import { HACK_TYPES, HACK_LOG_LINES } from '../tools/hack-model.mjs';
import { GRAMMARS, drawNeutral } from './hack-grammars.js';

const LINE_MS = 150;

// Petit hash déterministe famille -> graine cosmétique (varie le bruit d'un vol
// à l'autre, ne révèle jamais la famille au joueur).
function cosmeticSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < String(str).length; i++) {
		h ^= String(str).charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

export function runHack(root, { hackType, family } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : 'UNKNOWN';
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);

	const s = screen(root, 'hack');
	s.box.innerHTML = `<pre class="hack-head">HACK // ${type}</pre>
<pre class="hack-log"></pre>
<pre class="hack-grammar" aria-hidden="true"></pre>`;
	const logEl = s.box.querySelector('.hack-log');
	const gramEl = s.box.querySelector('.hack-grammar');

	return new Promise((resolve) => {
		let raf = 0;
		let timer = 0;
		let done = false;
		const t0 = performance.now();

		// Log ligne à ligne.
		let shown = 0;
		const tick = () => {
			if (done) return;
			shown++;
			logEl.textContent = HACK_LOG_LINES.slice(0, shown).join('\n');
			if (shown >= HACK_LOG_LINES.length) {
				logEl.classList.add('hack-log-armed'); // hook JS : le log est joué
				arm();
				return;
			}
			timer = setTimeout(tick, LINE_MS);
		};
		timer = setTimeout(tick, LINE_MS);

		// Boucle d'animation unique du motif.
		const loop = (now) => {
			if (done) return;
			draw(gramEl, { t: (now - t0) / 1000, seed });
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);

		const finish = () => {
			if (done) return;
			done = true;
			cancelAnimationFrame(raf);
			clearTimeout(timer);
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve();
		};
		const onKey = (e) => {
			if (e.repeat) return; // ignore l'auto-repeat clavier
			if (e.key === 'Enter') { e.preventDefault(); finish(); }
		};

		// Affordances de sortie armées seulement une fois le log entièrement joué.
		let armed = false;
		const arm = () => {
			if (armed || done) return;
			armed = true;
			window.addEventListener('keydown', onKey);
			s.box.appendChild(button('JACK IN', finish, 'terminal-cta'));
		};
	});
}
