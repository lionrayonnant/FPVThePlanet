// Selftest for the end-of-flight exit (#20). No DOM, no network: the flush and
// the navigation are injected, and the clock is driven by hand so a flush that
// never answers costs the test nothing.
// Run: node tools/flight-exit-selftest.mjs
import assert from 'node:assert/strict';
import { FlightExit, FLUSH_CAP_MS, STALL_WATCHDOG_MS } from '../src/flight-exit.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// A clock the test owns. Timers fire only when tick() says so, in due order.
function fakeClock() {
	let now = 0, seq = 0;
	const timers = new Map();
	return {
		setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
		clearTimer: (id) => { timers.delete(id); },
		// Advances to `now + ms`, firing everything due, then lets the
		// microtask queue drain so an awaited race actually settles.
		async tick(ms) {
			now += ms;
			for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at <= now) { timers.delete(id); timer.fn(); }
			}
			await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		},
		get pending() { return timers.size; },
	};
}

// A promise the test resolves when it feels like it — or never.
function held() {
	let settle;
	const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
	return { promise, ...settle };
}

const quiet = () => {};

function build(over = {}) {
	const clock = fakeClock();
	const calls = { navigate: 0 };
	const exit = new FlightExit({
		flush: async () => {},
		navigate: () => { calls.navigate++; },
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		warn: quiet,
		...over,
	});
	return { exit, clock, calls };
}

await t('nominal: the flush lands, the page is asked to leave, once', async () => {
	const { exit, calls } = build();
	assert.equal(await exit.run(), true);
	assert.equal(calls.navigate, 1);
	assert.equal(exit.stage, 'navigating');
	// Still latched: the page is on its way out, a second gesture must not
	// start another exit behind it.
	assert.equal(exit.busy, true);
});

await t('a flush that never answers does not keep the player here', async () => {
	const forever = held();
	const { exit, clock, calls } = build({ flush: () => forever.promise });
	const run = exit.run();
	await clock.tick(1);
	assert.equal(calls.navigate, 0, 'nothing has timed out yet');
	await clock.tick(FLUSH_CAP_MS);
	await run;
	assert.equal(calls.navigate, 1);
});

await t('a flush that rejects does not keep the player here either', async () => {
	const { exit, calls } = build({ flush: async () => { throw new Error('HTTP 500'); } });
	await exit.run();
	assert.equal(calls.navigate, 1);
});

await t('the ceiling timer is cleared when the flush lands in time', async () => {
	const flush = held();
	const { exit, clock } = build({ flush: () => flush.promise });
	const run = exit.run();
	flush.resolve();
	await run;
	// Only the stall watchdog may still be armed; a leaked ceiling would keep
	// a Node process alive past the exit.
	assert.equal(clock.pending, 1);
});

await t('a second gesture during the flush is folded into the first exit', async () => {
	const flush = held();
	const { exit, clock, calls } = build({ flush: () => flush.promise });
	const first = exit.run();
	assert.equal(await exit.run(), false, 'the second call reports that it did nothing');
	flush.resolve();
	await first;
	await clock.tick(0);
	assert.equal(calls.navigate, 1, 'one navigation, not two');
});

await t('a navigation that does not take the page away hands the gesture back', async () => {
	const { exit, clock, calls } = build({ navigate: () => { calls.navigate++; } });
	await exit.run();
	assert.equal(exit.busy, true);
	await clock.tick(STALL_WATCHDOG_MS);
	assert.equal(exit.stage, 'stalled');
	assert.equal(exit.busy, false, 'this is the bug of #20: the latch must come back down');
	// And the next gesture really does try again.
	assert.equal(await exit.run(), true);
	assert.equal(calls.navigate, 2);
});

await t('a navigation that throws is still a stall, not a dead end', async () => {
	let navigate = 0;
	const { exit, clock } = build({ navigate: () => { navigate++; throw new Error('blocked'); } });
	await exit.run();
	assert.equal(navigate, 1);
	await clock.tick(STALL_WATCHDOG_MS);
	assert.equal(exit.busy, false);
});

await t('the watchdog stays quiet once the page has actually left', async () => {
	// The real navigate() never returns: the page is gone before the watchdog
	// is due, so nothing here may report a stall on a healthy exit.
	const { exit, clock } = build();
	await exit.run();
	await clock.tick(STALL_WATCHDOG_MS - 1);
	assert.equal(exit.stage, 'navigating');
	assert.equal(exit.busy, true);
});

await t('the ceilings are the documented ones', () => {
	assert.equal(FLUSH_CAP_MS, 1500);
	assert.equal(STALL_WATCHDOG_MS, 3000);
	assert.ok(FLUSH_CAP_MS < STALL_WATCHDOG_MS, 'the flush must give up before the navigation is judged');
});

console.log(`\n${n} vérifications, tout passe.`);
