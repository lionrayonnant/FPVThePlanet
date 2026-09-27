// node tools/osd-input-lost-selftest.mjs — the "controller lost" warning of the
// local OSD layer (src/fpvtp-osd.js).
//
// Losing the pad in flight — a flat Bluetooth battery, a yanked cable — used to
// be SILENT: input.js handed the keyboard back and the commands simply
// disappeared. The warning goes through #fo-hint, the element that already
// carries the transient line in that corner (the same channel as the D16
// briefing line), rather than through an overlay of its own.
//
// Why the root is stubbed rather than mounted: the OSD builds its tree with
// insertAdjacentHTML, which tools/lib/fake-dom.mjs deliberately does not support
// (a fake HTML parser would let a test pass on markup no browser ever renders).
// So the layer is built on a root that swallows that call and hands back real
// fake-dom elements, and what is checked is the PRIORITY and the SWITCHING —
// which is all this code decides.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

const { FpvtpOsd } = await import('../src/fpvtp-osd.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

function mount() {
	const osd = new FpvtpOsd({
		insertAdjacentHTML() {},
		querySelector: () => document.createElement('div'),
	});
	// The real markup carries `hidden` on #fo-hint: the line starts invisible.
	osd.el.hint.hidden = true;
	return { osd, hint: osd.el.hint };
}

t('a lost controller is written on the transient line, and names the device', () => {
	const { osd, hint } = mount();
	// input.js decides the WORDS (deviceLostLine); this layer only paints them,
	// exactly like setCut().
	osd.setInputLost('CONTROLLER LOST — TBS TANGO 2 · KEYBOARD ACTIVE');
	assert.equal(hint.hidden, false);
	assert.match(hint.textContent, /CONTROLLER LOST/);
	assert.match(hint.textContent, /TANGO 2/);
});

t('the warning takes priority over the briefing line, and gives it back', () => {
	// Losing the sticks is never less urgent than a reminder. main.js calls
	// setHint() sixty times a second on a first flight: the warning must not be
	// erased by the next frame.
	const { osd, hint } = mount();
	osd.setHint('[TAB] SETTINGS');
	assert.equal(hint.textContent, '[TAB] SETTINGS');

	osd.setInputLost('CONTROLLER LOST · KEYBOARD ACTIVE');
	osd.setHint('[TAB] SETTINGS');
	assert.match(hint.textContent, /CONTROLLER LOST/, 'the frame after does not erase it');

	osd.setInputLost(null);
	assert.equal(hint.textContent, '[TAB] SETTINGS', 'and the briefing line comes back');
});

t('the warning takes itself away when its time is up', () => {
	// It expires on its own so that nothing has to remember to clear it — including
	// on a flight where setHint() is never called again (any flight but the first).
	const { osd, hint } = mount();
	osd.setInputLost('CONTROLLER LOST · KEYBOARD ACTIVE');
	assert.match(hint.textContent, /CONTROLLER LOST/);
	// The clock, wound forward rather than waited out.
	osd._lostUntil = performance.now() - 1;
	osd._paintHint();
	assert.equal(hint.textContent, '', 'nothing is left over the flight');
	assert.equal(hint.hidden, true);
});

t('with a briefing line underneath, the expiry uncovers it', () => {
	const { osd, hint } = mount();
	osd.setHint('THROTTLE UP');
	osd.setInputLost('CONTROLLER LOST · KEYBOARD ACTIVE');
	osd._lostUntil = performance.now() - 1;
	osd._paintHint();
	assert.equal(hint.textContent, 'THROTTLE UP');
});

t('an empty warning changes nothing, and nothing throws', () => {
	const { osd, hint } = mount();
	osd.setInputLost('');
	assert.equal(hint.textContent, '');
	assert.equal(hint.hidden, true);
});

dom.restore();

console.log(`\nosd-input-lost: ${n} tests ok`);
