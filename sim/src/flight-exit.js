// Leaving a flight, and the guarantee that leaving always terminates (#20).
//
// PURE: no DOM, no Three, no Rapier — the flush and the navigation are both
// injected, so tools/flight-exit-selftest.mjs can hold them open for as long
// as it likes. It lives outside main.js for the reason tools/dev-flags.mjs
// states about itself: a rule that only exists inside main.js is a rule
// nobody can test, and this one shipped a defect that stranded a player on a
// screen with no way out.
//
// The defect: main.js latched `exiting = true` and only THEN did the two
// things that can fail to come back — a best-effort network flush, and the
// navigation itself. The latch is there so a held key or a second event does
// not fire two reloads; it was never meant to outlive a failed exit. It did,
// and every later Escape, Enter, click and pad button returned on it in
// silence.
//
// So the latch is now bounded on both sides:
//  - the flush is best-effort, so it gets a CEILING. A promise that never
//    settles is not a rejection: a try/catch cannot see it, and the flight
//    was already willing to leave without the write landing.
//  - if the navigation has not taken the page away, the latch is RELEASED.
//    The player gets their gesture back and can ask again, which is the whole
//    principle of this screen — nothing exits the flight on the player's
//    behalf, so nothing may take the exit away from them either.

// The flight is over and the player is waiting: this is the longest the write
// may hold the exit. Long enough for a healthy PATCH on a local server, short
// enough to read as part of the exit rather than as a freeze.
export const FLUSH_CAP_MS = 1500;

// How long a navigation gets to take the page away before we call it stalled.
// Generous on purpose: releasing the latch while the page is genuinely
// unloading would let a second exit start on the way out.
export const STALL_WATCHDOG_MS = 3000;

// `flush` and `navigate` are the two acts; everything else is injected only so
// the selftest can drive the clock. `navigate` is expected NOT to return in
// practice — the page goes away under it.
export class FlightExit {
	constructor({
		flush,
		navigate,
		flushCapMs = FLUSH_CAP_MS,
		stallMs = STALL_WATCHDOG_MS,
		setTimer = (fn, ms) => setTimeout(fn, ms),
		clearTimer = (id) => clearTimeout(id),
		warn = (...a) => console.warn(...a),
	} = {}) {
		this._flush = flush ?? (async () => {});
		this._navigate = navigate ?? (() => {});
		this._flushCapMs = flushCapMs;
		this._stallMs = stallMs;
		this._setTimer = setTimer;
		this._clearTimer = clearTimer;
		this._warn = warn;
		// 'idle' -> 'flush' -> 'navigating' -> ('stalled' when it did not take).
		// Read by __sim.endState(): the latch says an exit left, the stage says
		// how far it got.
		this.stage = 'idle';
		this._busy = false;
		this._stallTimer = null;
	}

	// True while an exit is in flight. This is the idempotence latch — and,
	// unlike the old one, it always comes back down.
	get busy() { return this._busy; }

	// Returns true when this call is the one that ran the exit, false when it
	// was folded into an exit already under way. Callers that need to know
	// (a held key, a second pad edge) get an honest answer instead of a reload
	// they cannot see.
	async run() {
		if (this._busy) return false;
		this._busy = true;

		this.stage = 'flush';
		try {
			await this._withCeiling(this._flush(), this._flushCapMs);
		} catch (e) {
			// A rejected write and a write that never answers are the same thing
			// to a flight that is leaving: neither may keep the player here.
			this._warn('[exit] end-of-flight flush failed, leaving anyway', e);
		}

		this.stage = 'navigating';
		// Armed BEFORE navigate(), which normally never returns.
		this._stallTimer = this._setTimer(() => this._stalled(), this._stallMs);
		try {
			this._navigate();
		} catch (e) {
			// Nothing left to try here, but the watchdog below still hands the
			// gesture back rather than leaving the screen inert.
			this._warn('[exit] navigation threw', e);
		}
		return true;
	}

	// The page is still here. Give the player their exit gesture back: the next
	// Escape, Enter, click or pad button starts a fresh attempt.
	_stalled() {
		this._stallTimer = null;
		if (this.stage !== 'navigating') return;
		this.stage = 'stalled';
		this._busy = false;
		this._warn(`[exit] navigation did not take the page away in ${this._stallMs} ms — latch released, the next gesture tries again`);
	}

	// Resolves with the promise, or on the ceiling, whichever comes first. The
	// timer is cleared on the fast path so a Node selftest is not held open by
	// a pending timeout.
	_withCeiling(promise, ms) {
		let timer = null;
		const capped = new Promise((resolve, reject) => {
			timer = this._setTimer(
				() => reject(new Error(`flush did not settle within ${ms} ms`)),
				ms,
			);
		});
		return Promise.race([promise, capped]).finally(() => {
			if (timer !== null) this._clearTimer(timer);
		});
	}
}
