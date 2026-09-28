// Render selftest for the TARGET SCAN screen (src/target-scan.js).
//
// Since issue #49 the pre-hack sheet no longer exists: the list is the only
// screen, and activating a row CHOOSES the target. The following tests follow
// that shift — the issue #73 defect is no longer "two sheets stack up" but "a
// keystroke that arrives twice resolves twice", the same bug in its
// remaining form, still covered here.
//
// This checks the TREE and the WIRING, not the look — same intent as
// data-render-selftest.mjs.
//
// Run: node tools/target-scan-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

const { runTargetScan } = await import('../src/target-scan.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };

// A TARGET SCAN screen mounted on a fixed seed: the list is reproducible.
const open = () => {
	reset();
	const p = runTargetScan(dom.root, { seed: 'selftest::73', count: 4 });
	return p;
};

const rows = () => dom.root.querySelectorAll('.terminal-row');

await t('the list mounts one button per detected signal', async () => {
	const p = open();
	await tick();
	assert.equal(rows().length, 4, 'four signals, four buttons');
	assert.match(dom.root.textContent, /TARGET SCAN/);
	assert.match(dom.root.textContent, /SIGNALS DETECTED/);
	dom.key('Escape');
	await p;
});

await t('#49: the row carries the signal, the video mode AND the device', async () => {
	// What replaces the sheet must be REALLY readable on the row, not merely
	// present in the object scanLines() renders.
	const p = open();
	await tick();
	for (const row of rows()) {
		assert.match(row.textContent, /-\d+ dBm/, `signal missing from "${row.textContent}"`);
		assert.match(row.textContent, /ANALOG|DIGITAL|UNKNOWN/, `mode missing from "${row.textContent}"`);
		// The device is the only field with no fixed shape; what is checked
		// here is that something REMAINS after the other three.
		const rest = row.textContent.replace(/^\s*\d+\s+-\d+ dBm[^A-Z]*/, '')
			.replace(/^(ANALOG|DIGITAL|UNKNOWN)\s*/, '');
		assert.ok(rest.trim().length > 0, `device missing from "${row.textContent}"`);
	}
	// And none of the constant fields the sheet used to repeat survive.
	const text = dom.root.textContent;
	for (const gone of ['LOCATION', 'FLIGHT STATE', 'CONTROL', 'PARTIAL', 'CONFIRM']) {
		assert.ok(!text.includes(gone), `"${gone}" survives the sheet's removal`);
	}
	dom.key('Escape');
	await p;
});

await t('activating a row renders the chosen signal and tears everything down', async () => {
	const p = open();
	await tick();
	rows()[2].click();
	const choice = await p;
	assert.equal(choice.index, 2, 'the rendered index is the activated signal\'s');
	assert.ok(choice.seed, 'the scan\'s seed comes back with the choice');
	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'nothing left on screen');
});

await t('#73: a keystroke arriving twice only chooses ONCE', async () => {
	// The direct heir of the issue #73 defect. With no sheet there is nothing
	// left to stack, but both activation paths still exist: without a guard
	// the screen would be torn down twice, the second teardown working on a
	// tree already removed.
	const p = open();
	await tick();
	const row = rows()[0];
	row.click();
	row.click();            // the keystroke that used to arrive twice
	const choice = await p;
	assert.equal(choice.index, 0, 'the first choice is the one that counts');
	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'screen torn down only once');
});

await t('#29: a cluster\'s row says MESH, GROUP and COUNT — and nothing more', async () => {
	// swarmChance 1: the cluster is the strongest signal, so the first row.
	reset();
	const p = runTargetScan(dom.root, { seed: 'render::swarm', count: 4, swarmChance: 1 });
	await tick();
	const first = rows()[0].textContent;
	assert.match(first, /-\d+ dBm \(STRONGEST OF GROUP\)/);
	assert.match(first, /MESH — MULTIPLE EMITTERS/);
	assert.match(first, /COUNT UNKNOWN/);
	assert.ok(!first.includes('swarmNode'), 'the row never names the family');
	// The ordinary targets of the same scan mention no group at all.
	for (const row of rows().slice(1)) {
		assert.ok(!row.textContent.includes('COUNT'), `COUNT on an ordinary target: "${row.textContent}"`);
		assert.ok(!row.textContent.includes('GROUP'), `GROUP on an ordinary target: "${row.textContent}"`);
	}
	dom.key('Escape');
	await p;
});

await t('Escape on the list cancels without choosing', async () => {
	const p = open();
	await tick();
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { cancelled: true });
});

// --- clearance (issue #185, Signals lot 3)

await t('CLEARANCE line: absent with no clearance passed in', async () => {
	const p = open();
	await tick();
	assert.ok(!dom.root.textContent.includes('CLEARANCE'), 'no clearance passed in -> no line');
	dom.key('Escape');
	await p;
});

await t('CLEARANCE line: shows the level and the pool size out of 7', async () => {
	reset();
	const families = ['freestyle5', 'cinewhoop', 'toothpick'];
	const p = runTargetScan(dom.root, { seed: 'clearance::1', count: 4, families, clearance: 1 });
	await tick();
	assert.match(dom.root.textContent, /CLEARANCE 1 · 3 OF 7 MACHINE CLASSES/,
		dom.root.textContent);
	dom.key('Escape');
	await p;
});

await t('the choice carries families and clearance back to the caller', async () => {
	reset();
	const families = ['freestyle5'];
	const p = runTargetScan(dom.root, { seed: 'clearance::0', count: 4, families, clearance: 0 });
	await tick();
	rows()[0].click();
	const choice = await p;
	assert.deepEqual(choice.families, families, 'the pool the scan actually drew from comes back');
	assert.equal(choice.clearance, 0);
});

dom.restore();
console.log(`\n${n} tests target-scan-render OK`);
