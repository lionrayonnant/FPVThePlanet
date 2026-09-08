// The briefing (D16). Four terminal screens, once, right after the operator is
// registered — and on demand from SETTINGS > SYSTEM.
//
// It is NOT a tutorial: nothing here waits for the player to perform a gesture,
// nothing gates the game behind it, and every row states a fact rather than
// giving an order (Bible, pilier 1, revised 2026-09-08). Escape skips the whole
// thing at any moment, and the operator is marked as briefed either way — a
// briefing you refused is a briefing you were offered.
//
// What is displayed is decided by tools/briefing-model.mjs; this file only
// mounts it, in the same face as the bootstrap (revealLines + dotted rows).
import { screen, button, keyHints } from './terminal.js';
import { revealLines, dotted } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { briefingScreens } from '../tools/briefing-model.mjs';

// Which Settings tab each action opens, and what the button says. The briefing
// names a thing and offers the way to it — it never sends the player looking.
const ACTIONS = {
	calibrate: { label: 'CALIBRATE', tab: 'controller' },
	mapKeys: { label: 'MAP KEYS', tab: 'keyboard' },
};

// The widest label of a screen decides its dot column: a screen whose rows all
// fit stays tight, and a screen with CONTROL VECTOR in it does not fold.
function rowWidth(rows) {
	return Math.min(24, Math.max(12, ...rows.map(([label]) => label.length + 1)));
}

// One screen. Resolves with 'next' when CONTINUE is pressed; the caller is what
// unmounts it, so an [ ESC ] arriving mid-reveal can tear it down from outside.
async function showScreen(root, spec, { openSettings, interval, onMounted }) {
	const s = screen(root, 'briefing');
	onMounted(s);
	const width = rowWidth(spec.rows);
	const lines = [spec.title, '', ...spec.rows.map(([label, value]) => dotted(label, value, width))];
	await revealLines(s.box, lines, interval === undefined ? {} : { interval });
	return new Promise((resolve) => {
		for (const id of spec.actions) {
			if (id === 'continue') continue;
			const action = ACTIONS[id];
			if (!action) continue;
			s.box.appendChild(button(action.label, async () => {
				// The panel is a layer of its own: the briefing stays mounted
				// underneath and is still there when the panel closes.
				await openSettings?.(action.tab);
			}, 'terminal-cta'));
		}
		s.box.appendChild(button('CONTINUE', () => resolve('next'), 'terminal-cta'));
		s.box.appendChild(keyHints([['ESC', 'SKIP BRIEFING']]));
		// No `back`: Escape belongs to the briefing as a whole, not to a screen
		// (menu-nav only takes Escape when it is given somewhere to go).
		const nav = menuNav(s.el, {});
		s.nav = nav;
	});
}

// `input` is { kind: 'gamepad' | 'keyboard', name }, `keyRows` the live
// keyMapRows() of input.js, `openSettings(tab)` opens the panel and resolves
// when it closes. `interval` is only for the selftest, which has no patience.
export async function runBriefing(root, { input = null, keyRows = [], openSettings = null, interval } = {}) {
	const screens = briefingScreens({ input, keyRows });
	let mounted = null;
	const unmount = () => {
		if (!mounted) return;
		mounted.nav?.detach();
		mounted.remove();
		mounted = null;
	};

	let skip = null;
	const onKey = (e) => {
		if (e.key !== 'Escape') return;
		e.preventDefault?.();
		skip?.();
	};
	window.addEventListener('keydown', onKey);

	try {
		for (const spec of screens) {
			const skipped = await Promise.race([
				showScreen(root, spec, { openSettings, interval, onMounted: (s) => { mounted = s; } }),
				new Promise((resolve) => { skip = () => resolve('skip'); }),
			]);
			unmount();
			if (skipped === 'skip') return;
		}
	} finally {
		skip = null;
		window.removeEventListener('keydown', onKey);
		unmount();
	}
}
