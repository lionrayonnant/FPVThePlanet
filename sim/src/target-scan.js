// TARGET SCAN (PHASE 08, Bible §15). A short interaction: a list of signals,
// the player picks one. Only what is really known before the flight is
// shown — never the family, the camera, the rates, the battery.
//
// A single screen since issue #49: the pre-hack sheet is gone and what was
// useful in it fits on the row (tools/target-model.mjs:scanLines). Four of
// its seven fields were the same constants for every target and never
// distinguished two signals; CONDITIONS is already at the top of the screen.
// Activating a row therefore CHOOSES the target — one keystroke, not two.
//
// A pure client screen: rendered with the terminal look (screen/button from
// terminal.js), no Three/Rapier dependency. The generation comes from
// tools/target-model.mjs, bundled by Vite. The Up/Down + Enter grammar lives
// in menu-nav.js (issue #123): every signal is a real button, the cursor is
// native focus — clickable, tabbable, and drivable from a gamepad.
import { screen, button, keyHints } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { generateTargetScan, scanLines, TARGET_FAMILIES } from '../tools/target-model.mjs';
import { conditionsBlock } from './weather.js';
import { uiAudio } from './ui-audio.js';
import { mountHangar } from './hangar.js';
import { swarmAllowed } from '../tools/signal-clearance-model.mjs';

// No more crew chatter on TARGET SCAN since #243.
// The crew no longer comments on the screen you are looking at — it speaks on
// the root, and as a toast during the hack and the acquisition. TARGET_SCAN,
// TARGET_SELECTED and WEATHER stay in the root's mixed feed.

// `weather`: the world's weather snapshot for this area (issue #76), resolved
// before the scan by main.js. `null` if the area has no coordinates — no
// weather is then invented, the CONDITIONS block is simply absent.
// `swarmChance` (issue #29): the caller computes it from the operator state
// (the early guarantee) and it must be the SAME value it sends to the server,
// so the screen hands it back with the choice rather than keeping it.
// `families`/`clearance` (issue #185): the caller computes the draw pool ONCE
// per flight choice from the operator's clearance, and this screen must draw
// from the SAME pool as main.js and the server, or the choice the player made
// here would not be the target the server resolves. `clearance` itself is not
// used to draw anything — it only feeds the CLEARANCE line and travels back
// with the choice for the session POST.
// `store` (the operator's uplinked signals) draws the hangar under the list:
// every flight shows the machines this clearance can hack, and the ones it
// will. Absent, there is no hangar.
export function runTargetScan(root, { seed, count, weather = null, swarmChance, families, clearance, store }) {
	const scan = generateTargetScan({ seed, count, swarmChance, families });
	const condBlock = conditionsBlock(weather);
	return new Promise((resolve) => {
		const s = screen(root);
		// createElement rather than innerHTML, like screen() itself: this is
		// what makes the screen mountable on the fake DOM, so testable without
		// a browser (tools/target-scan-render-selftest.mjs, issue #73).
		const head = document.createElement('pre');
		head.textContent = `TARGET SCAN\n\n${condBlock ? `${condBlock.join('\n')}\n\n` : ''}SIGNALS DETECTED`;
		s.box.appendChild(head);

		const wrap = document.createElement('div');
		wrap.className = 'terminal-list';
		// The rows are computed as one block: column alignment is a property
		// of the whole set, and a cluster's row is much longer than the
		// others. The screen displays, it does not format.
		scanLines(scan.candidates).forEach((line, i) => {
			wrap.appendChild(button(line, () => choose(i), 'terminal-row'));
		});
		s.box.appendChild(wrap);

		// The hangar (issue #185), compact: the machines of every clearance,
		// the open ones turning, the locked ones as silhouettes.
		const hangar = store !== undefined ? mountHangar(s.box, { store, compact: true }) : null;

		// The clearance line (issue #185, spec §2): under the list, faint —
		// information, not an instruction, like keyHints() below it. 7 = the
		// six ordinary families plus the swarm. The swarm is not in `families`
		// (it is drawn by swarmChance, not from the pool), so it is counted
		// here once the clearance allows it.
		if (Number.isInteger(clearance)) {
			const line = document.createElement('pre');
			line.className = 'terminal-clearance-line';
			const classes = scan.families.length + (swarmAllowed(clearance) ? 1 : 0);
			line.textContent = `CLEARANCE ${clearance} · ${classes} OF ${TARGET_FAMILIES.length + 1} MACHINE CLASSES`;
			s.box.appendChild(line);
		}

		// D15: Escape backs out, and it says so. The list has no BACK button —
		// choosing a signal is the only gesture it offers — so the key hint is
		// the SCREEN'S ONLY VISIBLE way out.
		s.box.appendChild(keyHints([['ESC', 'BACK']]));

		// The guard from issue #73, in its remaining form. The original bug was
		// that the same keystroke reached both the focused button and a second
		// activation path: `sheet()` was called twice and two sheets stacked
		// up. With no sheet there is nothing left to stack, but both paths
		// still exist — without this flag the screen would be torn down
		// twice, the second teardown working on a tree already removed, and
		// the choice sound would play twice.
		let done = false;

		// Escape / the B button backs out to the zone choice. The screen does
		// not know what that costs — by this point main.js has already
		// started preloading the map — so it merely signals it and lets the
		// caller decide: screens stay pure clients.
		const cancel = () => {
			if (done) return;
			done = true;
			listNav.detach();
			hangar?.destroy();
			s.remove();
			resolve({ cancelled: true });
		};

		const listNav = menuNav(s.el, { back: cancel });

		const choose = (index) => {
			if (done) return;
			done = true;
			listNav.detach();
			uiAudio.play('TARGET_FOUND');
			hangar?.destroy();
			s.remove();
			resolve({
				seed: scan.seed, count: scan.count, index,
				swarmChance: scan.swarmChance, swarmAt: scan.swarmAt,
				families: scan.families, clearance,
			});
		};
	});
}
