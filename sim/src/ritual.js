// Rituel CONTROL VECTOR (PHASE 10, Bible §14/18). Remplace le [ JACK IN ]
// provisoire de PHASE 09 : le joueur tape son vecteur (fixe, propre à
// l'opérateur — voir bootstrap.js pour sa définition, hors périmètre ici),
// tolérant, sans pénalité en cas d'erreur ; puis 1 à 4 secondes de folie demo
// scene (variante V1-V4 tirée au hasard, Bible §18-19) ; puis CONTROL
// ACQUIRED ; puis coupure immédiate — aucun bouton, aucune touche à presser
// pour cette dernière étape.
//
// Monté en overlay plein viewport DANS le conteneur que lui passe hack.js
// (fixed, casse le cadre terminal étroit de l'écran AUTOMATED ANALYSIS
// derrière lui). Écran client pur : aucune dépendance Three/Rapier/physics.
// Jamais importé par le moteur.
import { readGamepadDir } from './gamepad-dir.js';
import { blockNav } from './menu-nav.js';
import { cosmeticSeed, RITUAL_PRIMITIVES, FAMILY_PRIMITIVES } from './hack-grammars.js';
import { pickVariant, checkInput } from '../tools/ritual-model.mjs';
import { music } from './music.js';
import { uiAudio } from './ui-audio.js';

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
		// Pendant le rituel les flèches sont la donnée saisie : aucun nav resté
		// monté dessous ne doit naviguer ni recevoir un bouton manette (issue
		// #123 — un écran s'abonne explicitement, celui-ci ne s'abonne jamais).
		const unblock = blockNav(wrap);
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
				uiAudio.play('ERROR');
				// La tension retombe avec l'erreur : audible, pas un mute sec — la
				// pénalité est dans l'oreille, jamais dans une remise à zéro brutale
				// (Bible §14, issue #47 : pas de game over).
				uiAudio.ritualTension(0);
				renderPrompt();
				wrap.classList.remove('ritual-shake');
				// force le replay de l'animation même sur des erreurs consécutives
				void wrap.offsetWidth;
				wrap.classList.add('ritual-shake');
				setTimeout(() => wrap.classList.remove('ritual-shake'), SHAKE_MS);
				return;
			}
			typed.push(dir);
			// Chaque flèche juste fait monter la tension d'un cran : le pilote doit
			// sentir la pression grimper pendant qu'il tape, pas seulement au moment
			// où l'explosion part.
			uiAudio.ritualTension(typed.length / vector.length);
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

		let lastBeatIdx = -1;

		function startBurst() {
			stage = 'burst';
			promptEl.classList.add('ritual-prompt-done');
			wrap.classList.add('ritual-live');
			// L'explosion prend le relais : la tension n'a plus rien à préparer.
			uiAudio.killRitualTension();
			// La musique se retire le temps du rituel. Chaque hack a sa propre
			// signature sonore (Bible §36) et c'est ELLE qui doit culminer ; une
			// musique à plein régime par-dessus rendrait les six rituels
			// indiscernables. Elle revient juste après, pour le drop.
			music.duck();
			// Programmée d'un coup sur l'horloge audio : le rythme ne doit pas
			// dépendre des frames, que le chargement de la carte peut faire sauter.
			uiAudio.playRitual(hackType, variant.ms);
			raf = requestAnimationFrame(loop);
		}

		function loop(now) {
			if (burstT0 === null) burstT0 = now;
			const elapsed = now - burstT0;
			if (elapsed >= variant.ms) { finishBurst(); return; }
			const beatIdx = Math.min(variant.beats - 1, Math.floor(elapsed / beatMs));
			const primitive = RITUAL_PRIMITIVES[primitives[beatIdx % primitives.length]];
			burstEl.className = `ritual-burst ritual-burst--${RITUAL_COLORS[beatIdx % RITUAL_COLORS.length]}`;
			// `dur` = fenêtre visible du battement (beatMs), pas la culmination
			// entière : chaque primitive n'est affichée qu'un battement à la
			// fois, pulseRing/vectorSweep bouclent leur période sur cette base.
			primitive(burstEl, { t: elapsed / 1000, seed: numSeed, dur: beatMs / 1000 });
			if (beatIdx !== lastBeatIdx) {
				// Un coup à chaque battement : le rituel doit frapper l'écran, pas
				// juste changer de motif dessus (retour utilisateur PR #80).
				lastBeatIdx = beatIdx;
				wrap.classList.remove('ritual-boom');
				void wrap.offsetWidth;
				wrap.classList.add('ritual-boom');
			}
			raf = requestAnimationFrame(loop);
		}

		function finishBurst() {
			cancelAnimationFrame(raf);
			stage = 'acquired';
			wrap.classList.remove('ritual-live', 'ritual-boom');
			burstEl.textContent = '';
			burstEl.className = 'ritual-burst';
			promptEl.textContent = 'CONTROL ACQUIRED';
			promptEl.className = 'ritual-prompt ritual-acquired';
			setTimeout(teardown, ACQUIRED_MS);
		}

		function teardown() {
			cancelAnimationFrame(raf);
			clearInterval(padPoll);
			window.removeEventListener('keydown', onKey);
			// Garde-fou : un rituel abandonné en pleine saisie (changement de scène,
			// navigation) ne doit jamais laisser un riser tourner derrière l'écran
			// suivant. Sans effet si l'explosion l'a déjà coupée dans startBurst().
			uiAudio.killRitualTension();
			unblock();
			wrap.remove();
			resolve();
		}
	});
}
