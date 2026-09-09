// The `others` bus (issue #29): everything that is NOT the player's machine —
// the ambient drones (#250) and the swarm — shares ONE ceiling here.
//
//   ambient voices → ambient(trim) ┐
//                                  ├→ others → engineIn()
//   swarm voices   → swarm(trim)  ─┘
//
// THE BUDGET IS SHARED, NOT ADDED, and that is the whole point. The two trims
// are fixed and computed once (tools/swarm-audio-model.mjs): each branch is
// scaled so its own worst case is exactly its share of the ceiling — 12 dB
// below the player's idleLevel — so the SUM of the two worst cases IS the
// ceiling. Without this, twelve more voices would be free to eat the 1.6 dB of
// limiter headroom that docs/handoff-archive/son.md:92-98 measured as the whole
// margin of the mix.
//
// EXACTLY HOW STRONG EACH HALF OF THAT CLAIM IS — the two are not equal:
//
//  - SWARM side: a true supremum. SWARM_WORST is the maximum of the swarm's
//    own law over every distance and every size (the bed saturates at nMax on
//    purpose), and every branch of src/swarm-audio.js peaks at the gain that
//    was budgeted for it. Nothing the swarm can do reaches 0.3 · cap.
//  - AMBIENT side: a CONVENTION, not a supremum. AMBIENT_WORST is four voices
//    at VOICE.d0 (8 m) — the bound #250 gave itself — but gainFor() keeps
//    rising below d0, and a voice also carries its noise band on top of its
//    sine. Four voices at ZERO distance would be 4·gainFor(0)·(1 + NOISE_LEVEL)
//    = 0.075, i.e. 1.75 x this branch's share after trim (+4.9 dB). The
//    hypothesis that makes the bound hold is that an ambient is never born
//    close: R_SPAWN starts at 120 m, and only the small-scene path
//    (src/ambient.js:359, rMin = 0) can put one within a few metres. Nothing
//    in the code CHECKS that hypothesis — clamping gainFor() would be a second
//    edit to validated #250 sound code, which this tranche is not allowed to
//    make. It is written down here instead, and it is a real limit of the
//    ceiling, inherited rather than introduced.
//
// What the ceiling does NOT cover: the reverb return. src/space.js sends its
// wet straight back into the engine's `air` node (space.js:180), i.e. BESIDE
// this bus rather than through it, for the swarm and the ambients alike.
//
// The price, and it is a real one: the ambients' dry path comes out ~3 dB below
// what #250 validated, because they no longer own the budget alone. Their wet
// path, sent pre-trim and returning outside the bus, is unchanged — an
// asymmetry this tranche introduces and does not fix, for the same reason.
//
// WHO PAYS THAT PRICE, AND WHEN. A cluster falls one session in ten, so paying
// it in every flight would mean nine flights out of ten losing 3 dB of sky to
// provision a swarm that is not there. The ambient branch therefore has two
// gains and exactly one write per flight (setSwarmPresent(), called from
// openFlightSession() in src/main.js, where the swarm is decided — before a
// take-off, before an ambient is audible, and never per frame):
//
//   swarm present → TRIM.ambient  (the share; the ceiling is structural)
//   no swarm      → AMBIENT_ALONE (the whole ceiling; the level #250 validated)
//
// The declaration is not what the ceiling RESTS on, because a level that is
// only correct when someone remembers to call something is not a bound. The
// safety net is below: taking the swarm branch of the bus is itself the
// declaration, so the shared trim is in place before a swarm voice can be
// heard, whatever the call order and whatever main.js said. `swarmPresent`
// defaults to true for the same reason — sharing is the safe state.
//
// This module is deliberately tiny and owns no source. It is the only place
// that knows the split, and the only thing sources need to know about it is
// which branch they belong to.
import { TRIM, OTHERS_CAP, AMBIENT_WORST } from '../tools/swarm-audio-model.mjs';

// The ambient branch when nothing shares the ceiling with it: its own worst
// case IS the cap, which is exactly the level #250 gave itself. CHOSEN, not
// measured, like every relative level in this project (son.md:106-111).
export const AMBIENT_ALONE = OTHERS_CAP / AMBIENT_WORST;

let ctxRef = null;
let bus = null;
// Sharing is the safe state: an undeclared flight pays the swarm's share
// rather than risking the ceiling.
let swarmPresent = true;

function applyAmbientTrim() {
	if (bus) bus.ambient.gain.value = swarmPresent ? TRIM.ambient : AMBIENT_ALONE;
}

// Does this flight carry a swarm? ONE call per flight, from
// openFlightSession() (src/main.js). Writes a single gain value — it neither
// allocates nor reroutes anything, so it is safe before or after the graph is
// built, and it must never be called per frame.
export function setSwarmPresent(present) {
	swarmPresent = !!present;
	applyAmbientTrim();
}

// The bus for `ctx`, built once. `destination` is engineIn().
//
// WATCH OUT, and this is the trap of a mutable module singleton: the FIRST
// caller fixes the destination for the whole context, and a later caller
// passing a different node has that argument silently DROPPED — its voice
// still plays, but through the first caller's output. Harmless today (both
// sources pass engineIn(), and there is only ever one context), which is why
// this is a written warning and not a throw: refusing to build the bus would
// turn a routing mismatch into a dead flight. The returned `dest` is what the
// bus actually feeds, so a caller that cares can check.
export function othersBus(ctx, destination) {
	if (bus && ctxRef === ctx) return bus;
	const out = ctx.createGain();
	out.gain.value = 1;
	out.connect(destination);
	const ambient = ctx.createGain();
	const swarm = ctx.createGain();
	swarm.gain.value = TRIM.swarm;
	ambient.connect(out);
	swarm.connect(out);
	ctxRef = ctx;
	bus = {
		out, ambient, dest: destination, nodesCreated: 3,
		// Reading this branch IS the declaration, and that is what makes the
		// ceiling structural rather than a matter of call order: whoever
		// connects a swarm voice puts the shared trim in place by doing so,
		// even if setSwarmPresent() was never called or was told otherwise.
		// src/swarm-audio.js only ever reaches here when a swarm exists
		// (SwarmDrones.update() returns before start() without a model).
		get swarm() {
			if (!swarmPresent) { swarmPresent = true; applyAmbientTrim(); }
			return swarm;
		},
	};
	applyAmbientTrim();
	return bus;
}

// For the selftests, which build a fresh fake context per case.
export function _resetOthers() { ctxRef = null; bus = null; swarmPresent = true; }
