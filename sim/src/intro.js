// Intro demoscene au lancement (issue #106). Overlay plein écran monté par
// main.js AVANT la résolution opérateur/Home — sauf sur ?scene=, qui bypasse
// ce fichier entièrement (voir main.js, armBoot() reste le chemin dev/bookmark
// inchangé). Écran client pur : aucun Three/Rapier/physics, jamais importé
// par le moteur.
//
// PRESS ANY KEY (calme, palette UI) fait passer le geste utilisateur qui
// lance le cracktro (logo + plasma/raster + scrolltext, Bible §19 :
// cyan/magenta/violet/bleu électrique réservés à ce moment). Ce même geste
// ouvre l'AudioContext et lance l'ambiance du terminal (callback
// `onFirstGesture`) : le cracktro n'a plus de partition propre, mais il n'est
// plus joué dans le silence. Skippable à tout instant —
// n'importe quel geste coupe net (démontage complet) plutôt que d'attendre la
// fin.
import { INTRO_PHASES, INTRO_TOTAL_MS, RESOLUTION_AT_MS, phaseAt, SKIP_WRAP_MS } from '../tools/intro-model.mjs';
import { cosmeticSeed, RITUAL_PRIMITIVES } from './hack-grammars.js';

const TITLE = 'FPVTP!';
const GREETING = 'FPVTP! CREW PRESENTS … GREETINGS TO EVERY PILOT WHO EVER AUGERED IN — FLY IT LIKE YOU STOLE IT //';

const REVEAL_MS = INTRO_PHASES[0].durMs;

// Sinus-scroll du logo : une amplitude en pixels, une vitesse temporelle, un
// déphasage par colonne — le triptyque classique du "dot scroller" demoscene.
const LOGO_AMP_PX = 10;
const LOGO_OMEGA = 5.5;
const LOGO_KAPPA = 0.7;

// Un battement toutes les 500 ms pendant la plasma (4000 ms / 8 primitives =
// un cycle complet des 8 primitives de hack-grammars.js sur toute la phase).
const BEAT_MS = 500;
const PRIMITIVE_NAMES = Object.keys(RITUAL_PRIMITIVES);
const COLORS = ['cyan', 'magenta', 'violet', 'blue'];
const SEED = cosmeticSeed('intro'); // fixe : le motif n'a pas à varier d'un chargement à l'autre

// `onFirstGesture` est appelé UNE fois, de façon synchrone, dans le handler du
// geste qui passe le gate. C'est la seule fenêtre où le navigateur autorise le
// démarrage d'un AudioContext : main.js s'en sert pour lancer l'ambiance du
// terminal dès cet instant, plutôt qu'à la fin du cracktro.
export function runIntro(root, { onFirstGesture = null } = {}) {
	return new Promise((resolve) => {
		const wrap = document.createElement('div');
		wrap.className = 'intro';
		wrap.innerHTML = '<pre class="intro-gate">FPVTP! // PRESS ANY KEY</pre>';
		root.appendChild(wrap);

		let raf = 0;
		let t0 = null;
		let started = false;
		let finished = false;
		let logoSpans = [];
		let burstEl = null;

		// « PRESS ANY KEY » vaut aussi pour la radio (issue #123) : n'importe quel
		// bouton de manette passe le gate, puis saute le cracktro — mêmes règles
		// que le clavier. Front montant seulement, « tenu » au départ : un bouton
		// déjà pressé au chargement ne compte pas. Limite de plateforme : un
		// bouton de manette n'est pas un geste utilisateur pour l'AudioContext —
		// l'intro reste alors muette jusqu'au premier vrai clic ou touche.
		let padHeld = true;
		const padPoll = setInterval(() => {
			if (finished) return;
			const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
			const down = !!pad?.buttons.some((b) => b.pressed);
			if (down && !padHeld) {
				if (!started) onGate();
				else onSkip();
			}
			padHeld = down;
		}, 80);

		function teardown() {
			finished = true;
			cancelAnimationFrame(raf);
			clearInterval(padPoll);
			window.removeEventListener('keydown', onGate);
			wrap.removeEventListener('click', onGate);
			window.removeEventListener('keydown', onSkip);
			wrap.removeEventListener('click', onSkip);
			wrap.remove();
		}

		function finish() {
			if (finished) return;
			teardown();
			resolve();
		}

		let skipped = false;

		function onSkip(e) {
			// Un keydown répété (touche tenue, auto-repeat de l'OS) n'est pas un
			// geste — input.js applique déjà cette règle (e.repeat) pour les
			// commandes de vol. Sans elle, tenir Enter au PRESS ANY KEY passe le
			// gate PUIS déclenche ce même skip ~250-500ms plus tard : le cracktro
			// mourrait à mi-course sous la répétition du clic qui vient de le lancer.
			// `e` est absent pour un clic : `e?.repeat` reste alors undefined (faux).
			if (e?.repeat) return;
			if (!started || finished || skipped) return;
			// Retrait SYNCHRONE, comme onGate() plus bas : un skip se martèle en
			// pratique (touche tenue, double clic), et finish() ne tourne qu'après
			// SKIP_WRAP_MS — sans ce retrait immédiat, une deuxième frappe dans cette
			// fenêtre relancerait le skip une deuxième fois.
			skipped = true;
			window.removeEventListener('keydown', onSkip);
			wrap.removeEventListener('click', onSkip);
			// Un dénouement bref plutôt qu'un cut visuel à la milliseconde près :
			// le temps que l'œil accroche la coupure, pas le temps de rejouer la
			// coda entière (SKIP_WRAP_MS << la durée de résolution normale).
			setTimeout(finish, SKIP_WRAP_MS);
		}

		function renderLogo(elapsed, phase) {
			// L'amplitude retombe à zéro pendant la résolution : le logo se pose,
			// en phase avec la partition qui se résout sur BOOT_SIGNATURE.
			const amp = phase === 'resolution'
				? LOGO_AMP_PX * Math.max(0, 1 - (elapsed - RESOLUTION_AT_MS) / (INTRO_TOTAL_MS - RESOLUTION_AT_MS))
				: LOGO_AMP_PX;
			const t = elapsed / 1000;
			for (let i = 0; i < logoSpans.length; i++) {
				const y = amp * Math.sin(t * LOGO_OMEGA + i * LOGO_KAPPA);
				logoSpans[i].style.transform = `translateY(${y.toFixed(2)}px)`;
			}
		}

		function renderBurst(elapsed) {
			const localMs = elapsed - REVEAL_MS;
			const beatIdx = Math.max(0, Math.min(PRIMITIVE_NAMES.length - 1, Math.floor(localMs / BEAT_MS)));
			const primitive = RITUAL_PRIMITIVES[PRIMITIVE_NAMES[beatIdx % PRIMITIVE_NAMES.length]];
			burstEl.className = `intro-burst intro-burst--${COLORS[beatIdx % COLORS.length]}`;
			primitive(burstEl, { t: elapsed / 1000, seed: SEED });
		}

		function loop(now) {
			if (finished) return;
			if (t0 === null) t0 = now;
			const elapsed = now - t0;
			if (elapsed >= INTRO_TOTAL_MS) { finish(); return; }
			const phase = phaseAt(elapsed);
			renderLogo(elapsed, phase);
			if (phase === 'plasma') renderBurst(elapsed);
			else burstEl.textContent = '';
			wrap.classList.toggle('intro-resolution', phase === 'resolution');
			raf = requestAnimationFrame(loop);
		}

		function startCracktro() {
			started = true;
			wrap.innerHTML =
				`<div class="intro-logo" aria-hidden="true">${TITLE.split('').map((ch) => `<span>${ch}</span>`).join('')}</div>`
				+ '<pre class="intro-burst" aria-hidden="true"></pre>'
				+ `<div class="intro-scroll" aria-hidden="true"><span>${GREETING}</span></div>`;
			logoSpans = Array.from(wrap.querySelectorAll('.intro-logo span'));
			burstEl = wrap.querySelector('.intro-burst');
			// La transition d'opacité (style.css) n'accroche que si le navigateur a
			// déjà peint l'état initial : une frame de battement avant d'ajouter la
			// classe qui la déclenche.
			requestAnimationFrame(() => wrap.querySelector('.intro-logo').classList.add('intro-logo-in'));
			window.addEventListener('keydown', onSkip);
			wrap.addEventListener('click', onSkip);
			raf = requestAnimationFrame(loop);
		}

		function onGate(e) {
			// Symétrique du filtre de onSkip ci-dessus. `{ once: true }` le rend
			// déjà moot en pratique (le navigateur ne redéclenche pas un écouteur
			// qu'il vient de désinscrire), mais le garder ici évite qu'un futur
			// retrait de `once` ne réintroduise le même bug côté gate.
			if (e?.repeat) return;
			// `{ once: true }` ne désinscrit QUE l'écouteur qui a déclenché : sans
			// ce retrait manuel de l'autre, un clic après un passage au clavier (ou
			// l'inverse) relancerait startCracktro() une seconde fois en pleine
			// partition.
			window.removeEventListener('keydown', onGate);
			wrap.removeEventListener('click', onGate);
			// Avant startCracktro() : on est encore dans la pile d'appel du
			// geste, ce que l'autoplay policy exige. Une erreur côté audio ne
			// doit pas empêcher l'intro de se lancer.
			try { onFirstGesture?.(); } catch (err) { console.warn('[intro]', err); }
			startCracktro();
		}
		window.addEventListener('keydown', onGate, { once: true });
		wrap.addEventListener('click', onGate, { once: true });
	});
}
