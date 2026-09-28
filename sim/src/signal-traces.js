// The traces controller (issue #185 lot 4, spec
// docs/superpowers/specs/2026-09-28-signals-traces-design.md rules 1, 2, 4, 5):
// one trace in the world at a time — the nearest open, non-encrypted tier II/III
// signal within 300 m — probed, built, validated (3 attempts), then followed;
// re-validated after each collider flush and lifted over what the refined
// world puts in its way. A signal whose trace cannot be laid falls back to the
// hold capture for the rest of the flight (`failed`).
//
// The rays and the line are injected (main.js passes physics methods as
// closures and a TraceLine), so tools/signal-traces-selftest.mjs runs it
// against a fake world. No THREE, no Rapier, no DOM.
//
// Budget: one phase per frame — probing (PROBE_RAYS) or validating
// (VALIDATE_RAYS + 2 lift rays) — never both: ≤ 40 rays per frame.
import { buildTrace, shapeOf, TraceFollower, MAX_ATTEMPTS } from '../tools/trace-model.mjs';
import { TraceProbe, liftStart, VALIDATE_CLEAR, VALIDATE_PENDING } from './trace-probe.js';

export const TRACE_RANGE_M = 300;     // horizontal, drone → anchor: a trace is laid
export const DROP_RANGE_M = 450;      // a trace not entered yet is dropped past this
export const PROBE_RAYS = 24;
export const VALIDATE_RAYS = 16;
export const PICK_S = 0.5;            // how often a new trace is looked for
export const RETRY_S = 1;             // a partial profile: the window may stream meanwhile
export const LIFT_CLEAR_M = 6;        // a lift clears the surface under the block by this
export const MIN_LIFT_M = 2;
export const MAX_LIFT_M = 60;         // more: the place is not what the trace thought — hold
export const MAX_LIFTS = 8;
const LIFT_PROBE_ABOVE_M = 300;

export class SignalTraces {
	// anchorOf(id) -> {x, y, z} | null (the signal's anchor, src/signal-anchor.js).
	// line: a TraceLine (show/setProgress/hide), or null.
	constructor({ groundBelow, rayUp, obstructionBetween, anchorOf, line = null }) {
		this.probe = new TraceProbe({ groundBelow, rayUp, obstructionBetween, raysPerFrame: PROBE_RAYS });
		this._ground = groundBelow;
		this._anchorOf = anchorOf;
		this.line = line;
		this.failed = new Set();       // ids back on the hold capture for this flight
		this.active = null;
		this._pickS = 0;
		// Events of the last update(): the id whose trace was flown to the end
		// (with its shape and seconds on it), gave up (-> hold), or was dropped.
		this.out = { done: null, doneShape: null, doneS: 0, failed: null, dropped: null };
	}

	get id() { return this.active?.signal.id ?? null; }
	get shape() { return this.active?.shape ?? null; }
	get trace() { return this.active?.phase === 'ready' ? this.active.trace : null; }
	get follower() { return this.active?.phase === 'ready' ? this.active.follower : null; }

	// Flight end, disarm, bench: nothing survives into the next flight.
	reset() {
		this._drop();
		this.failed.clear();
		this._pickS = 0;
		const o = this.out;
		o.done = null; o.doneShape = null; o.doneS = 0; o.failed = null; o.dropped = null;
	}

	// A live collider flush: the world under the trace has changed. The unflown
	// part is checked again from the follower's segment on (rule 2).
	collidersChanged() {
		if (this.active?.phase !== 'ready') return;
		this.probe.resetValidation();
		this.active.revalidate = true;
	}

	// dt: the generation clock (0 frozen). followDt: the follower's (0 when the
	// drone is not transmitting — disarmed, frozen). pos: the drone {x, y, z}.
	// signals: the flight's Signal[]; isOpen(id): not resolved.
	update({ dt, followDt = dt, pos, signals, isOpen }) {
		const o = this.out;
		o.done = null; o.doneShape = null; o.doneS = 0; o.failed = null; o.dropped = null;
		if (!pos) return o;
		const a = this.active;
		if (!a) {
			this._pickS -= dt;
			if (this._pickS <= 0 && dt > 0) {
				this._pickS = PICK_S;
				this._pick(pos, signals, isOpen);
			}
			return o;
		}
		const id = a.signal.id;
		if (!isOpen(id) || a.signal.encrypted) { this._drop(); o.dropped = id; return o; }
		const away = Math.hypot(pos.x - a.anchor.x, pos.z - a.anchor.z) > DROP_RANGE_M;
		if (away && (a.phase !== 'ready' || a.follower.out.state === 'waiting')) {
			this._drop(); o.dropped = id; return o;
		}
		switch (a.phase) {
			case 'wait':
				a.waitS -= dt;
				if (a.waitS <= 0) this._startProbe();
				break;
			case 'probe': {
				const profile = this.probe.step(PROBE_RAYS);
				if (!profile) break;
				if (profile.partial) { this._failAttempt(true); break; }
				a.profile = profile;
				this._build(pos);
				break;
			}
			case 'validate': {
				const r = this.probe.validate(a.trace, 0, VALIDATE_RAYS);
				if (r === VALIDATE_PENDING) break;
				if (r === VALIDATE_CLEAR) {
					a.phase = 'ready';
					a.follower = new TraceFollower({ trace: a.trace });
					this.line?.show(a.trace);
				} else if (this._failAttempt(false)) this._build(pos);
				break;
			}
			case 'ready':
				this._ready(a, followDt, pos);
				break;
		}
		return o;
	}

	_pick(pos, signals, isOpen) {
		let best = null, bestD = TRACE_RANGE_M, bestAt = null;
		for (const s of signals ?? []) {
			if ((s.tier !== 2 && s.tier !== 3) || s.encrypted || this.failed.has(s.id) || !isOpen(s.id)) continue;
			const at = this._anchorOf(s.id);
			if (!at) continue;
			const d = Math.hypot(pos.x - at.x, pos.z - at.z);
			if (d <= bestD) { best = s; bestD = d; bestAt = at; }
		}
		if (!best) return;
		this.active = {
			signal: best, anchor: { x: bestAt.x, y: bestAt.y, z: bestAt.z }, shape: shapeOf(best),
			attempt: 0, phase: 'probe', waitS: 0, profile: null, trace: null, follower: null,
			revalidate: false, lifts: 0,
		};
		this._startProbe();
	}

	_startProbe() {
		const a = this.active;
		a.phase = 'probe';
		a.profile = null;
		this.probe.start(a.anchor, { axis: a.shape === 'under' });
	}

	_build(pos) {
		const a = this.active;
		a.trace = buildTrace({
			signal: a.signal, anchor: a.anchor, profile: a.profile, tier: a.signal.tier,
			approach: { x: pos.x, z: pos.z }, attempt: a.attempt,
		});
		if (a.trace) { a.shape = a.trace.shape; a.phase = 'validate'; return; }
		if (this._failAttempt(false)) this._build(pos);
	}

	// -> true when another attempt follows at once (a rebuild on the same
	// profile); false when it waits for a new probe, or the signal gave up.
	_failAttempt(reprobe) {
		const a = this.active;
		a.attempt++;
		if (a.attempt >= MAX_ATTEMPTS) { this._giveUp(); return false; }
		if (reprobe) { a.phase = 'wait'; a.waitS = RETRY_S; return false; }
		return true;
	}

	_giveUp() {
		const id = this.active.signal.id;
		this.failed.add(id);
		this._drop();
		this.out.failed = id;
	}

	_ready(a, followDt, pos) {
		const f = a.follower;
		if (a.revalidate) {
			const from = f.out.index;
			const r = this.probe.validate(a.trace, from, VALIDATE_RAYS);
			if (r === VALIDATE_CLEAR) a.revalidate = false;
			else if (r !== VALIDATE_PENDING) {
				const dy = this._liftFor(a.trace, r);
				if (++a.lifts > MAX_LIFTS || dy === null) { this._giveUp(); return; }
				this.probe.lift(a.trace, liftStart(a.trace, r, from), dy, r);
				// The line copied the positions: it is rebuilt from the lifted trace.
				this.line?.show(a.trace);
			}
		}
		const o = f.update({ dt: followDt, pos });
		this.line?.setProgress(o.progress01, o.state, o.fade01);
		if (o.state === 'done') {
			const out = this.out;
			out.done = a.signal.id; out.doneShape = a.shape; out.doneS = o.elapsedS;
			this._drop();
		}
	}

	// How much the trace must rise at the blocked segment `i`: the surface
	// under both its ends plus LIFT_CLEAR_M. null past MAX_LIFT_M.
	_liftFor(trace, i) {
		const P = trace.points, last = P.length / 3 - 1;
		let dy = MIN_LIFT_M, seen = false;
		for (const j of [i, Math.min(i + 1, last)]) {
			const x = P[3 * j], y = P[3 * j + 1], z = P[3 * j + 2];
			const g = this._ground(x, y + LIFT_PROBE_ABOVE_M, z, LIFT_PROBE_ABOVE_M * 2);
			if (g === null || !Number.isFinite(g)) continue;
			seen = true;
			dy = Math.max(dy, g + LIFT_CLEAR_M - y);
		}
		if (!seen) dy = LIFT_CLEAR_M;
		return dy > MAX_LIFT_M ? null : dy;
	}

	_drop() {
		if (!this.active) return;
		this.probe.cancel();
		this.probe.resetValidation();
		this.line?.hide();
		this.active = null;
		this._pickS = 0;
	}
}
