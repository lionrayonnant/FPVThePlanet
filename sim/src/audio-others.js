// The `others` bus (issue #29): everything that is NOT the player's machine —
// the ambient drones (#250) and the swarm — shares ONE ceiling here.
//
//   ambient voices → ambient(trim) ┐
//                                  ├→ others → engineIn()
//   swarm voices   → swarm(trim)  ─┘
//
// THE BUDGET IS SHARED, NOT ADDED, and that is the whole point. The two trims
// are fixed and computed once (tools/swarm-audio-model.mjs): each branch is
// scaled so its own worst case is exactly its share of the ceiling, so the SUM
// of the two worst cases IS the ceiling — 12 dB below the player's idleLevel —
// whatever the swarm's size and wherever its units are. Without this, twelve
// more voices would be free to eat the 1.6 dB of limiter headroom that
// docs/handoff-archive/son.md:92-98 measured as the whole margin of the mix.
//
// The price, and it is a real one: the ambients come out ~3 dB below what #250
// validated, because they no longer own the budget alone.
//
// This module is deliberately tiny and owns no source. It is the only place
// that knows the split, and the only thing sources need to know about it is
// which branch they belong to.
import { TRIM } from '../tools/swarm-audio-model.mjs';

let ctxRef = null;
let bus = null;

// The bus for `ctx`, built once. `destination` is engineIn(); it is read only
// on the call that builds the bus — every source on this path shares one
// output by construction.
export function othersBus(ctx, destination) {
	if (bus && ctxRef === ctx) return bus;
	const out = ctx.createGain();
	out.gain.value = 1;
	out.connect(destination);
	const ambient = ctx.createGain();
	ambient.gain.value = TRIM.ambient;
	ambient.connect(out);
	const swarm = ctx.createGain();
	swarm.gain.value = TRIM.swarm;
	swarm.connect(out);
	ctxRef = ctx;
	bus = { out, ambient, swarm, nodesCreated: 3 };
	return bus;
}

// For the selftests, which build a fresh fake context per case.
export function _resetOthers() { ctxRef = null; bus = null; }
