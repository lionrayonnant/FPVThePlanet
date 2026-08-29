// Rituel CONTROL VECTOR (PHASE 10, Bible §14/18). Remplace le [ JACK IN ]
// provisoire de PHASE 09 : le joueur tape son vecteur (fixe, propre à
// l'opérateur — voir bootstrap.js pour sa définition, hors périmètre ici),
// tolérant, sans pénalité en cas d'erreur ; puis 1 à 4 secondes de folie demo
// scene (variante V1-V4 tirée au hasard, Bible §18-19) ; puis CONTROL
// ACQUIRED ; puis coupure immédiate — aucun bouton, aucune touche à presser
// pour cette dernière étape.
//
// Monté DANS le conteneur que lui passe hack.js (pas un nouvel écran plein
// cadre via terminal.js:screen — le rituel prolonge l'écran AUTOMATED
// ANALYSIS déjà à l'affichage). Écran client pur : aucune dépendance
// Three/Rapier/physics. Jamais importé par le moteur.
import { readGamepadDir } from './gamepad-dir.js';
import { cosmeticSeed, RITUAL_PRIMITIVES, FAMILY_PRIMITIVES } from './hack-grammars.js';
import { pickVariant, checkInput } from '../tools/ritual-model.mjs';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };
const KEY_TO_DIR = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
const RITUAL_COLORS = ['cyan', 'magenta', 'violet', 'blue']; // Bible §19 — réservées à ce moment
const SHAKE_MS = 220;
const ACQUIRED_MS = 400; // fixe, hors variante — juste le temps de lire le mot

const GENERIC_PRIMITIVES = ['glitchShift', 'pulseRing'];

export function runRitual(container, { hackType, vector, seed } = {}) {
	return new Promise((resolve) => {
		const wrap = document.createElement('div');
		wrap.className = 'ritual';
		wrap.innerHTML = '<pre class="ritual-prompt"></pre><pre class="ritual-burst" aria-hidden="true"></pre>';
		container.appendChild(wrap);
		const promptEl = wrap.querySelector('.ritual-prompt');
		const burstEl = wrap.querySelector('.ritual-burst');

		const numSeed = cosmeticSeed(seed ?? hackType ?? 'ritual');
		const variant = pickVariant(seed ?? hackType);
		const primitives = FAMILY_PRIMITIVES[hackType] ?? GENERIC_PRIMITIVES;
		const beatMs = variant.ms / variant.beats;

		let typed = [];
		let stage = 'entry'; // 'entry' -> 'burst' -> 'acquired'
		let raf = 0;
		let burstT0 = null; // fixé au premier tick rAF (voir loop) : "now" du rAF
		// peut précéder le performance.now() pris juste avant de le programmer.
		let padPrev = null;

		const renderPrompt = () => {
			promptEl.textContent = vector.map((_, i) => (i < typed.length ? ARROW[typed[i]] : '_')).join(' ');
		};
		renderPrompt();

		const onInput = (dir) => {
			if (stage !== 'entry') return;
			const r = checkInput(vector, typed, dir);
			if (r.status === 'mismatch') {
				typed = [];
				renderPrompt();
				wrap.classList.remove('ritual-shake');
				// force le replay de l'animation même sur des erreurs consécutives
				void wrap.offsetWidth;
				wrap.classList.add('ritual-shake');
				setTimeout(() => wrap.classList.remove('ritual-shake'), SHAKE_MS);
				return;
			}
			typed.push(dir);
			renderPrompt();
			if (r.status === 'complete') startBurst();
		};

		const onKey = (e) => {
			const dir = KEY_TO_DIR[e.key];
			if (dir) { e.preventDefault(); onInput(dir); }
		};
		window.addEventListener('keydown', onKey);

		const padPoll = setInterval(() => {
			const d = readGamepadDir(padPrev);
			if (d === '__hold') return;
			if (d) { padPrev = d; onInput(d); } else { padPrev = null; }
		}, 80);

		function startBurst() {
			stage = 'burst';
			promptEl.classList.add('ritual-prompt-done');
			raf = requestAnimationFrame(loop);
		}

		function loop(now) {
			if (burstT0 === null) burstT0 = now;
			const elapsed = now - burstT0;
			if (elapsed >= variant.ms) { finishBurst(); return; }
			const beatIdx = Math.min(variant.beats - 1, Math.floor(elapsed / beatMs));
			const primitive = RITUAL_PRIMITIVES[primitives[beatIdx % primitives.length]];
			burstEl.className = `ritual-burst ritual-burst--${RITUAL_COLORS[beatIdx % RITUAL_COLORS.length]}`;
			primitive(burstEl, { t: elapsed / 1000, seed: numSeed });
			raf = requestAnimationFrame(loop);
		}

		function finishBurst() {
			cancelAnimationFrame(raf);
			stage = 'acquired';
			burstEl.textContent = '';
			burstEl.className = 'ritual-burst';
			promptEl.textContent = 'CONTROL ACQUIRED';
			promptEl.classList.add('ritual-acquired');
			setTimeout(teardown, ACQUIRED_MS);
		}

		function teardown() {
			cancelAnimationFrame(raf);
			clearInterval(padPoll);
			window.removeEventListener('keydown', onKey);
			wrap.remove();
			resolve();
		}
	});
}
