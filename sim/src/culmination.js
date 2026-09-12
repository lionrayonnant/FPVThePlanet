// The hack culmination (PHASE 10, Bible §18-19). One to four seconds of demo
// scene madness between [ JACK IN ] and CONTROL ACQUIRED: the gesture has to
// land on something.
//
// This is what src/ritual.js used to play once the player had typed their
// CONTROL VECTOR. The entry stage was removed (#33) — it asked the player to
// memorise a secret outside the game and punished forgetting it with a total
// block — but its removal took the culmination with it, leaving [ JACK IN ]
// cutting straight to the result. The burst came back alone (#101): it starts
// on its own when the screen mounts, it resolves on its own, nothing is typed.
//
// Mounted as a full-viewport overlay INSIDE the container hack.js passes it
// (fixed, breaking out of the narrow terminal frame behind it — a real event,
// not one more screen in the same box). Pure client screen: no Three/Rapier/
// physics dependency. Never imported by the engine.
import { menuNav } from './menu-nav.js';
import { cosmeticSeed, RITUAL_PRIMITIVES, FAMILY_PRIMITIVES } from './hack-grammars.js';
import { pickVariant } from '../tools/culmination-model.mjs';
import { reducedMotion } from './motion.js';
import { music } from './music.js';
import { radio } from './radio.js';
import { uiAudio } from './ui-audio.js';

const COLORS = ['cyan', 'magenta', 'violet', 'blue']; // Bible §19 — reserved for this moment
const GENERIC_PRIMITIVES = ['glitchShift', 'pulseRing'];

// prefers-reduced-motion gets the event, not the strobe: one beat, one
// pattern, no boom and no breathing halo (those live in CSS, which stops
// animating on its own). Short and fixed — the variant is what flickers.
const REDUCED_MS = 700;

export function runCulmination(container, { hackType, seed } = {}) {
	return new Promise((resolve) => {
		const wrap = document.createElement('div');
		wrap.className = 'culmination';
		const burstEl = document.createElement('pre');
		burstEl.className = 'culmination-burst';
		burstEl.setAttribute('aria-hidden', 'true');
		wrap.appendChild(burstEl);
		container.appendChild(wrap);

		const calm = reducedMotion();
		const numSeed = cosmeticSeed(seed ?? hackType ?? 'culmination');
		const variant = pickVariant(seed ?? hackType);
		const primitives = FAMILY_PRIMITIVES[hackType] ?? GENERIC_PRIMITIVES;
		const totalMs = calm ? REDUCED_MS : variant.ms;
		const beats = calm ? 1 : variant.beats;
		const beatMs = totalMs / beats;

		let raf = 0;
		let done = false;
		let nav = null;
		let t0 = null; // set on the first rAF tick: the rAF "now" can precede the
		// performance.now() taken just before scheduling it.
		let lastBeatIdx = -1;

		// The music steps back for the culmination. Each hack has its own audio
		// signature (Bible §36) and it is THAT which must peak; music at full
		// level over it would make the six culminations indistinguishable. It
		// comes back right after, for the drop (music.drop() in main.js).
		//
		// NOT while the radio holds the air (issue #120). The duck and the
		// unduck are ONE gesture belonging to ONE owner: main.js already skips
		// the drop for the radio, so ducking here would leave it at 0.55 for the
		// rest of the session — silently, after a single FIELD hack.
		if (!radio.owns) music.duck();
		// Scheduled in one go on the audio clock: the rhythm must not depend on
		// frames, which the map still loading can drop.
		uiAudio.playCulmination(hackType, totalMs);

		function loop(now) {
			if (done) return;
			if (t0 === null) t0 = now;
			const elapsed = now - t0;
			if (elapsed >= totalMs) { teardown(); return; }
			const beatIdx = Math.min(beats - 1, Math.floor(elapsed / beatMs));
			const primitive = RITUAL_PRIMITIVES[primitives[beatIdx % primitives.length]];
			burstEl.className = `culmination-burst culmination-burst--${COLORS[beatIdx % COLORS.length]}`;
			// `dur` is the visible window of the beat, not the whole culmination:
			// each primitive is on screen one beat at a time, and pulseRing/
			// vectorSweep loop their period on that basis.
			primitive(burstEl, { t: elapsed / 1000, seed: numSeed, dur: beatMs / 1000 });
			if (beatIdx !== lastBeatIdx) {
				// A hit on every beat: the culmination has to strike the screen, not
				// just change the pattern on it (user feedback PR #80).
				lastBeatIdx = beatIdx;
				wrap.classList.remove('culmination-boom');
				void wrap.offsetWidth;
				wrap.classList.add('culmination-boom');
			}
			raf = requestAnimationFrame(loop);
		}

		function teardown() {
			if (done) return;
			done = true;
			cancelAnimationFrame(raf);
			nav?.detach();
			nav = null;
			delete globalThis.__culminationTestFinish;
			wrap.remove();
			resolve();
		}

		// Escape SKIPS the beat instead of aborting, exactly like the acquired
		// screen behind it: control is taken, there is no way back to the scan.
		nav = menuNav(wrap, { back: teardown, focusFirst: false });

		// Same hook as the hack screens: a render test has no business waiting
		// seconds for a timer. Nothing in the game reads this.
		globalThis.__culminationTestFinish = () => teardown();

		raf = requestAnimationFrame(loop);
	});
}
