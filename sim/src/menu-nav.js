// Navigation clavier + manette des menus (issue #123). Généralise la
// convention écrite deux fois indépendamment (session-log.js, target-scan.js) :
// ↑/↓ déplacent un curseur, ←/→ règlent ou changent de filtre, Entrée active,
// Échap/Retour arrière remonte. Le curseur EST le focus natif du navigateur
// (element.focus()) : Tab, souris, clavier et manette racontent la même
// histoire, et le marqueur ▌ (peint par style.css sur :focus) ne peut jamais
// diverger de l'élément réellement actif. Ce module ne touche à aucun style.
//
// Un écran s'abonne EXPLICITEMENT via menuNav(). Trois contextes ne
// s'abonnent jamais, parce que les flèches y veulent dire autre chose :
// le CONTROL VECTOR (bootstrap.js) et le rituel (ritual.js), où la direction
// est la donnée saisie — ils posent un blockNav() pour rendre inertes les
// écrans restés montés dessous — et le vol (input.js), où c'est une commande.
// Les événements dont la cible est un champ de saisie texte sont ignorés
// (sauf Échap) : la recherche du scanner reste éditable.
import { readGamepadDir } from './gamepad-dir.js';

// ---------- logique pure (testée par tools/menu-nav-selftest.mjs) ----------

// Index suivant dans une liste circulaire. Sans élément courant (focus perdu
// après un re-rendu), on entre par le bord d'où vient le mouvement.
export function nextIndex(length, current, delta) {
	if (!length) return -1;
	if (current < 0) return delta > 0 ? 0 : length - 1;
	return (current + delta + length) % length;
}

// Valeur suivante d'un <input type=range> : un pas borné dans la direction
// demandée — la manette règle un slider exactement comme les flèches natives.
export function stepValue({ value, min, max, step }, dir) {
	const s = Number.isFinite(step) && step > 0 ? step : 1;
	const lo = Number.isFinite(min) ? min : 0;
	const hi = Number.isFinite(max) ? max : 100;
	const next = value + (dir === 'right' ? s : -s);
	return Math.min(hi, Math.max(lo, next));
}

// Les touches d'un champ où l'on tape du texte lui appartiennent (issue #123 :
// sans cette règle la recherche du scanner devient inéditable). Un range ou
// une checkbox n'est pas de la saisie de texte.
export function isTextEntryKind(tag, type) {
	if (tag === 'TEXTAREA') return true;
	if (tag !== 'INPUT') return false;
	return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
}

export function isTextEntry(el) {
	return !!el && isTextEntryKind(el.tagName, String(el.type ?? '').toLowerCase());
}

// ---------- pile d'écrans ----------

// Le nav actif est le plus haut de la pile dont l'écran est encore visible :
// un panneau ouvert par-dessus (Settings sur la Home, une fiche sur sa liste)
// prend la main sans que l'écran du dessous ait à se désabonner — il suffit
// que le dessous soit masqué ou monté plus tôt.
const stack = [];

const isShown = (el) => el.isConnected && (el.checkVisibility?.() ?? true);

function topNav() {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (isShown(stack[i].container)) return stack[i];
	}
	return null;
}

// Rend inertes tous les navs pendant qu'un écran non-abonné (capture du
// CONTROL VECTOR, rituel) est monté par-dessus. Retourne la fonction qui
// libère la pile.
export function blockNav(container) {
	const entry = { container, blocker: true };
	stack.push(entry);
	return () => {
		const i = stack.indexOf(entry);
		if (i >= 0) stack.splice(i, 1);
	};
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), '
	+ 'select:not(:disabled), textarea:not(:disabled)';

const KEY_TO_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// Boutons standard gamepad : 0 = A/sud (activer), 1 = B/est (remonter) —
// les mêmes que partout ailleurs sur la Standard Gamepad.
const PAD_CONFIRM = 0;
const PAD_BACK = 1;
const PAD_POLL_MS = 80; // même cadence que bootstrap.js / ritual.js

// `container` : l'élément racine de l'écran (généralement s.el). Options :
// - back    : Échap / Retour arrière / bouton B — remonter d'un écran.
// - onDir   : ←/→ quand le focus n'est pas sur un contrôle réglable — pour
//             les filtres du SESSION LOG. Retourne true si la direction est
//             consommée ; sinon ←/→ navigue comme ↑/↓.
// - focusFirst : poser le curseur sur le premier élément au montage (défaut).
//             À désactiver quand l'écran place lui-même son focus (scanner).
// - gamepad : brancher la manette (défaut). À désactiver quand les sticks
//             veulent déjà dire autre chose — le panneau Settings ouvert EN
//             VOL, où ils pilotent le drone et déplaceraient le curseur et les
//             sliders à chaque geste.
export function menuNav(container, { back = null, onDir = null, focusFirst = true, gamepad = true } = {}) {
	const nav = { container };

	const focusables = () => [...container.querySelectorAll(FOCUSABLE)].filter(isShown);

	const focused = () => {
		const el = document.activeElement;
		return el && container.contains(el) ? el : null;
	};

	const focusAt = (i) => { focusables()[i]?.focus(); };

	const move = (delta) => {
		const els = focusables();
		const i = nextIndex(els.length, els.indexOf(document.activeElement), delta);
		if (i >= 0) els[i].focus();
	};

	// ←/→ : règle le contrôle focalisé quand c'en est un (slider, select),
	// sinon l'écran décide (filtres), sinon navigue (issue #123, Settings).
	const adjust = (el, dir) => {
		if (!el) return false;
		if (el.matches('input[type="range"]')) {
			const next = stepValue({
				value: Number(el.value), min: Number(el.min), max: Number(el.max), step: Number(el.step),
			}, dir);
			if (next !== Number(el.value)) {
				el.value = String(next);
				// Le même événement que le geste souris : les oninput existants
				// (settings.js) persistent et ré-émettent sans rien savoir de nous.
				el.dispatchEvent(new Event('input', { bubbles: true }));
			}
			return true;
		}
		if (el.matches('select')) {
			const i = el.selectedIndex + (dir === 'right' ? 1 : -1);
			if (i >= 0 && i < el.options.length) {
				el.selectedIndex = i;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}
			return true;
		}
		return false;
	};

	const handleDir = (dir) => {
		if (dir === 'up' || dir === 'down') { move(dir === 'down' ? 1 : -1); return; }
		if (adjust(focused(), dir)) return;
		if (onDir?.(dir)) return;
		move(dir === 'right' ? 1 : -1);
	};

	const onKey = (e) => {
		if (topNav() !== nav) return;
		if (isTextEntry(e.target)) {
			// Échap sort quand même de l'écran : il n'édite rien. Tout le reste
			// (flèches, Retour arrière, Entrée) appartient au champ.
			if (e.key === 'Escape' && back) { e.preventDefault(); back(); }
			return;
		}
		const dir = KEY_TO_DIR[e.key];
		if (dir) { e.preventDefault(); handleDir(dir); return; }
		if ((e.key === 'Escape' || e.key === 'Backspace') && back) { e.preventDefault(); back(); }
		// Entrée n'est pas gérée ici : un bouton focalisé la reçoit nativement.
	};

	// Manette : mêmes directions que le clavier (readGamepadDir), plus A pour
	// activer l'élément focalisé et B pour remonter. Front montant seulement,
	// et l'état initial est « tenu » : le bouton qui a validé l'écran précédent
	// ne doit pas traverser jusqu'à celui-ci.
	let padPrev = null;
	const padHeld = { [PAD_CONFIRM]: true, [PAD_BACK]: true };
	const padPoll = !gamepad ? 0 : setInterval(() => {
		if (topNav() !== nav) { padPrev = null; return; }
		const d = readGamepadDir(padPrev);
		if (d && d !== '__hold') { padPrev = d; handleDir(d); }
		else if (!d) padPrev = null;

		const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
		for (const b of [PAD_CONFIRM, PAD_BACK]) {
			const down = !!pad?.buttons[b]?.pressed;
			if (down && !padHeld[b]) {
				if (b === PAD_BACK) back?.();
				else {
					const el = focused();
					if (el) el.click?.();
					else focusAt(0); // curseur perdu : A le repose d'abord
				}
			}
			padHeld[b] = down;
		}
	}, PAD_POLL_MS);

	nav.focusAt = focusAt;
	nav.detach = () => {
		clearInterval(padPoll);
		window.removeEventListener('keydown', onKey);
		const i = stack.indexOf(nav);
		if (i >= 0) stack.splice(i, 1);
	};

	window.addEventListener('keydown', onKey);
	stack.push(nav);
	if (focusFirst) focusAt(0);
	return nav;
}
