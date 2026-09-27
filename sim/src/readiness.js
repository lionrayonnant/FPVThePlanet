// RECOMMENDED SETUP — the launch readout that names the two things the game
// cannot tell you about itself: what you fly it with, and what you fly it in.
//
// Mounted by main.js in chooseScene(), after the intro and BEFORE the operator
// is resolved: this is hardware, not identity, so an operator registered months
// ago meets it too. It never runs on the ?scene= / ?live= paths — those are
// development entrances.
//
// What is DISPLAYED is decided by tools/readiness-model.mjs; this file only
// mounts it, in the same face as the bootstrap (revealLines + dotted rows).
//
// The live pad probe is the point of the screen. The Gamepad API reveals a
// device only after an input on it, so the screen opens honest ("NOT DETECTED
// YET") and corrects itself the moment a stick moves — gamepadconnected, plus a
// poll at menu-nav's own cadence because Firefox fires that event late and
// Chromium fires it once per page, not once per screen.
import { mountScreen, screenButton } from './screen.js';
import { revealLines, dotted } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { padKind } from './input.js';
import {
	readinessReport, readinessLines, browserFamily, browserBrand,
	markReadinessDismissed, READINESS_AUTO_MS,
} from '../tools/readiness-model.mjs';

// The same 80 ms as src/menu-nav.js. Not imported: it is not exported there, and
// this file must not be the reason it becomes part of that module's surface.
const PAD_POLL_MS = 80;

// The dot column of the two rows. Both labels are short; the width is fixed so
// the values line up with the bootstrap's own readout.
const ROW_WIDTH = 22;

function firstPad(nav) {
	try { return (nav?.getGamepads?.() ?? []).find(Boolean) ?? null; }
	catch { return null; }
}

// What the environment currently looks like, read once. Every `navigator` access
// of this screen goes through here, which is what keeps the model pure.
function probe(nav) {
	const pad = firstPad(nav);
	return {
		browserFamily: browserFamily(nav?.userAgentData, nav?.userAgent),
		browserName: browserBrand(nav?.userAgentData, nav?.userAgent),
		padId: pad?.id ?? '',
		padKind: pad ? padKind(pad.id) : 'generic',
	};
}

// `store` and `nav` are injected so the selftest can hand over a broken store or
// a pad that appears halfway through. `interval` and `autoMs` are only for that
// selftest, which has no patience — `pollMs` too. `last` closes the screen with
// the backwards print that carries the black background away; it does not by
// default, because the bootstrap or the terminal is mounted right behind it and
// the black must hold until then (see the close() comments in src/screen.js).
export async function runReadiness(root, {
	nav = typeof navigator === 'undefined' ? null : navigator,
	store = typeof localStorage === 'undefined' ? null : localStorage,
	interval,
	autoMs = READINESS_AUTO_MS,
	pollMs = PAD_POLL_MS,
	last = false,
} = {}) {
	const s = mountScreen(root, { cls: 'readiness' });
	let report = readinessReport(probe(nav));

	const pre = await revealLines(s.box, readinessLines(report, (l, v) => dotted(l, v, ROW_WIDTH)),
		interval === undefined ? {} : { interval });

	return new Promise((resolve) => {
		let done = false;
		let nav_ = null;
		let poll = null;
		let timer = null;
		const offs = [];

		const finish = (dismiss) => {
			if (done) return;
			done = true;
			if (dismiss) markReadinessDismissed(store);
			if (poll !== null) clearInterval(poll);
			if (timer !== null) clearTimeout(timer);
			for (const off of offs) off();
			// detach() before the screen leaves: a nav left attached to a removed
			// container keeps an 80 ms poll and a window listener that nothing can
			// ever reap — exactly what briefing-render-selftest.mjs counts.
			nav_?.detach();
			nav_ = null;
			(last ? s.close({ revealBehind: true }) : s.close()).then(resolve, resolve);
		};

		// --- the live pad probe -------------------------------------------------
		// A device appearing turns the warning into a reading. The reverse is not
		// done: a screen that took a verdict back would be noise, and a pad that
		// unplugs itself during these two seconds is not a case worth a branch.
		const refresh = () => {
			if (done || report.allClear) return;
			const next = readinessReport(probe(nav));
			if (next.input.state === report.input.state) return;
			report = next;
			pre.textContent = readinessLines(report, (l, v) => dotted(l, v, ROW_WIDTH)).join('\n');
			// The screen is no longer waiting on anything: it becomes the readout
			// it would have been, and takes itself away.
			if (report.allClear) {
				clearInterval(poll);
				poll = null;
				for (const b of s.box.querySelectorAll('button')) b.remove();
				nav_?.detach();
				nav_ = null;
				timer = setTimeout(() => finish(false), autoMs);
			}
		};
		if (!report.allClear) {
			poll = setInterval(refresh, pollMs);
			const onConnect = () => refresh();
			window.addEventListener('gamepadconnected', onConnect);
			offs.push(() => window.removeEventListener('gamepadconnected', onConnect));
		}

		// --- the two behaviours -------------------------------------------------
		if (report.allClear) {
			// A readout, not a question: no button, and anything at all takes it
			// away before the two seconds are up.
			timer = setTimeout(() => finish(false), autoMs);
			const any = () => finish(false);
			window.addEventListener('keydown', any);
			window.addEventListener('mousedown', any);
			window.addEventListener('gamepadconnected', any);
			offs.push(() => {
				window.removeEventListener('keydown', any);
				window.removeEventListener('mousedown', any);
				window.removeEventListener('gamepadconnected', any);
			});
			// A gamepad BUTTON is not an event: the only way to hear one is to
			// look. Same cadence as the rest of the house.
			let base = null;
			poll = setInterval(() => {
				const pad = firstPad(nav);
				const now = (pad?.buttons ?? []).map((b) => (typeof b === 'object' ? !!b.pressed : !!b));
				if (base === null) { base = now; return; }
				if (now.some((p, i) => p && !base[i])) finish(false);
				base = now;
			}, pollMs);
			return;
		}

		s.box.appendChild(screenButton('CONTINUE', () => finish(false), 'bootstrap-btn'));
		s.box.appendChild(screenButton("DON'T SHOW AGAIN", () => finish(true), 'bootstrap-btn'));
		// Keyboard AND pad navigation, the house way. No `back`: there is nowhere
		// above this screen, and Escape here would be a third answer to a
		// two-answer question.
		nav_ = menuNav(s.el, {});
	});
}
