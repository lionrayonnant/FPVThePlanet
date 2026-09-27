// Demoscene intro at launch (issue #106). A full-screen overlay mounted by
// main.js BEFORE the operator/Home resolution — except on ?scene=, which
// bypasses this file entirely (see main.js: armBoot() stays the unchanged
// dev/bookmark path). A pure client screen: no Three/Rapier/physics, never
// imported by the engine.
//
// It is also the only place in the game where the MARK is shown (#73): the
// stacked lockup of docs/brand.md — the symbol, then `F P V T P !` below it —
// which that document always reserved for "splash, boot". The symbol is traced
// module by module during the `reveal` phase, because the mark IS a frozen
// randomart (brand.md) and a randomart, in this game, gets traced (#57). It
// NEVER takes a demo colour, not even under the plasma: cyan and magenta belong
// to the screen, not to the logo (brand.md, "Forbidden").
//
// PRESS ANY KEY (calm, UI palette) takes the user gesture that launches the
// cracktro (logo + plasma/raster, Bible §19: cyan/magenta/violet/electric blue
// reserved for this moment). The same gesture opens the AudioContext and starts
// the terminal ambience (`onFirstGesture` callback): the cracktro has no score of
// its own any more, but it is no longer played in silence. Skippable at any
// moment — any gesture cuts it clean (full teardown) rather than waiting for the
// end.
import { INTRO_PHASES, INTRO_TOTAL_MS, RESOLUTION_AT_MS, phaseAt, SKIP_WRAP_MS } from '../tools/intro-model.mjs';
import { MARK_RECTS, revealCount, nameVisibleAt } from '../tools/brand-mark-model.mjs';
import { stackedLockup } from './brand-lockup.js';
import { cosmeticSeed, RITUAL_PRIMITIVES } from './hack-grammars.js';
import { reducedMotion } from './motion.js';
import { anyPadButtonDown } from './input.js';

const TITLE = 'FPVTP!';

const REVEAL_MS = INTRO_PHASES[0].durMs;

// Sine-scroll of the logo: an amplitude in pixels, a time speed, a per-column
// phase shift — the classic triptych of the demoscene "dot scroller".
const LOGO_AMP_PX = 10;
const LOGO_OMEGA = 5.5;
const LOGO_KAPPA = 0.7;

// One beat every 500 ms during the plasma (4000 ms / 8 primitives = one full
// cycle of hack-grammars.js's 8 primitives over the whole phase).
const BEAT_MS = 500;
const PRIMITIVE_NAMES = Object.keys(RITUAL_PRIMITIVES);
const COLORS = ['cyan', 'magenta', 'violet', 'blue'];
const SEED = cosmeticSeed('intro'); // fixed: the pattern has no reason to vary between loads

// `onFirstGesture` is called ONCE, synchronously, inside the handler of the
// gesture that passes the gate. It is the only window in which the browser
// allows an AudioContext to start: main.js uses it to start the terminal
// ambience right then, rather than at the end of the cracktro.
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
		let markEl = null;
		let logoEl = null;
		// How many of the 19 rectangles are already in the document. The trace
		// never erases, it only adds: a counter is enough, and a skipped frame
		// catches up on its own at the next one.
		let painted = 0;

		// "PRESS ANY KEY" holds for the radio too (issue #123): any gamepad button
		// passes the gate, then skips the cracktro — the keyboard's rules. Rising
		// edge only, "held" at start: a button already down at load does not count.
		// ANY pad, not the first one: Chrome on Linux can list a keyboard receiver
		// ahead of the radio (see bestPad() in input.js), and the radio's buttons
		// then went unheard. Platform limit: a gamepad button is not a user gesture
		// for the AudioContext — the intro then stays silent until the first real
		// click or key.
		let padHeld = true;
		const padPoll = setInterval(() => {
			if (finished) return;
			const down = anyPadButtonDown(navigator.getGamepads?.());
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
			// A repeated keydown (held key, OS auto-repeat) is not a gesture —
			// input.js already applies that rule (e.repeat) to flight commands.
			// Without it, holding Enter at PRESS ANY KEY passes the gate THEN fires
			// this same skip ~250-500 ms later: the cracktro would die halfway under
			// the repeat of the press that just launched it. `e` is absent for a
			// click: `e?.repeat` is then undefined (false).
			if (e?.repeat) return;
			if (!started || finished || skipped) return;
			// SYNCHRONOUS removal, like onGate() below: a skip gets hammered in
			// practice (held key, double click), and finish() only runs after
			// SKIP_WRAP_MS — without this immediate removal, a second press in that
			// window would fire the skip a second time.
			skipped = true;
			// The skip lands on the resolution, where the mark is supposed to be in
			// place: finish it here rather than leave it half-written for the
			// remaining 250 ms.
			markComplete();
			window.removeEventListener('keydown', onSkip);
			wrap.removeEventListener('click', onSkip);
			// A short wrap-up rather than a visual cut to the millisecond: long
			// enough for the eye to catch the cut, not to replay the whole coda
			// (SKIP_WRAP_MS << the normal resolution length).
			setTimeout(finish, SKIP_WRAP_MS);
		}

		function renderLogo(elapsed, phase) {
			// Three regimes, and that is what keeps the lockup honest (#73). During
			// `reveal` the amplitude is ZERO: the symbol has just been traced, the
			// name writes itself below, and the gap between the two is exactly the
			// one docs/brand.md requires — that is where the mark is read. During
			// `plasma` the sine-scroll owns the screen and the lockup comes apart:
			// it is a demo, not a style guide. At the resolution the amplitude falls
			// back to zero, the logo settles in phase with the score as it joins
			// BOOT_SIGNATURE — and the lockup is right again for the last look.
			const amp = phase === 'reveal'
				? 0
				: phase === 'resolution'
					? LOGO_AMP_PX * Math.max(0, 1 - (elapsed - RESOLUTION_AT_MS) / (INTRO_TOTAL_MS - RESOLUTION_AT_MS))
					: LOGO_AMP_PX;
			const t = elapsed / 1000;
			for (let i = 0; i < logoSpans.length; i++) {
				const y = amp * Math.sin(t * LOGO_OMEGA + i * LOGO_KAPPA);
				logoSpans[i].style.transform = `translateY(${y.toFixed(2)}px)`;
			}
		}

		// Lays the missing rectangles up to `n`. Idempotent and monotonic: never
		// called with less than what is already there.
		const SVG_NS = 'http://www.w3.org/2000/svg';
		function paintMark(n) {
			for (; painted < n; painted++) {
				const r = MARK_RECTS[painted];
				const rect = document.createElementNS(SVG_NS, 'rect');
				rect.setAttribute('x', r.x);
				rect.setAttribute('y', r.y);
				rect.setAttribute('width', r.w);
				rect.setAttribute('height', r.h);
				markEl.appendChild(rect);
			}
		}

		// The name, once the mark is whole. The opacity transition (style.css) only
		// catches if the browser has already painted the initial state — which it
		// has here, the cracktro has been running for over a second.
		function showName() {
			logoEl.classList.add('intro-logo-in');
		}

		// Everything, at once. The skip and `prefers-reduced-motion` both go
		// through here: either way, a half-traced mark would be worse than no mark
		// at all.
		function markComplete() {
			paintMark(MARK_RECTS.length);
			showName();
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
			// The trace belongs to `reveal` and does not leave it: as soon as the
			// plasma starts, the mark is whole whatever happened to the frames.
			if (phase === 'reveal') {
				paintMark(revealCount(elapsed));
				if (nameVisibleAt(elapsed)) showName();
			} else markComplete();
			renderLogo(elapsed, phase);
			if (phase === 'plasma') renderBurst(elapsed);
			else burstEl.textContent = '';
			wrap.classList.toggle('intro-resolution', phase === 'resolution');
			raf = requestAnimationFrame(loop);
		}

		function startCracktro() {
			started = true;
			// The lockup comes from brand-lockup.js — one composition of the mark
			// in the whole game. The cracktro only empties its symbol: it repaints
			// it rectangle by rectangle during `reveal`.
			wrap.innerHTML =
				stackedLockup({ name: TITLE, extra: 'intro-lockup', splitName: true })
				+ '<pre class="intro-burst" aria-hidden="true"></pre>';
			markEl = wrap.querySelector('.lockup-mark');
			markEl.replaceChildren();
			logoEl = wrap.querySelector('.lockup-name');
			logoSpans = Array.from(wrap.querySelectorAll('.lockup-name span'));
			burstEl = wrap.querySelector('.intro-burst');
			// Reduced motion: the mark is laid down, not traced. Same rule as
			// everywhere else (motion.js) — jump to the final state rather than
			// animate more slowly.
			if (reducedMotion()) markComplete();
			window.addEventListener('keydown', onSkip);
			wrap.addEventListener('click', onSkip);
			raf = requestAnimationFrame(loop);
		}

		function onGate(e) {
			// Mirror of onSkip's filter above. `{ once: true }` already makes it moot
			// in practice (the browser does not re-fire a listener it has just
			// unregistered), but keeping it here stops a future removal of `once`
			// from bringing the same bug back on the gate side.
			if (e?.repeat) return;
			// `{ once: true }` only unregisters the listener that fired: without this
			// manual removal of the other one, a click after a keyboard pass (or the
			// reverse) would run startCracktro() a second time mid-score.
			window.removeEventListener('keydown', onGate);
			wrap.removeEventListener('click', onGate);
			// Before startCracktro(): still inside the gesture's call stack, which
			// the autoplay policy requires. An audio error must not stop the intro
			// from starting.
			try { onFirstGesture?.(); } catch (err) { console.warn('[intro]', err); }
			startCracktro();
		}
		window.addEventListener('keydown', onGate, { once: true });
		wrap.addEventListener('click', onGate, { once: true });
	});
}
