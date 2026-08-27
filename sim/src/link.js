// The 5.8 GHz video link, as a link budget in dB.
//
// No Rapier, no DOM, no three: this file only knows how far the drone is from
// the pilot and what sits on the straight line between them. Whoever measures
// those numbers is somebody else's problem
// (physics.js casts the rays, main.js wires it up) — same split as quad.js and
// flightController.js, and the reason this can be checked in tools/selftest.mjs
// without a browser.
//
// Everything below is dB because that is the only scale on which "twice as far"
// and "through a wall" are the same kind of quantity and can simply be added.

// Free-space reference distance. Loss is 0 dB here and climbs 20 dB per decade
// (20*log10(d/d0)) beyond it, which is plain inverse-square in field terms.
const D0 = 10;

// Where the picture starts to go, and where it is gone. The gap between them is
// the whole fade, so it is what sets how gradual the degradation looks.
//
// Calibrated so that distance alone is never really the problem inside a 1.2 km
// tile — which is honest, a 5.8 GHz link with a clear line of sight goes for
// kilometres — and occlusion is. At 900 m clear (corner to corner) the loss is
// 39 dB, i.e. quality 0.6: visibly noisy, entirely flyable. Four metres of
// building at 100 m is 52 dB, i.e. quality 0.24. That asymmetry is the point of
// the issue: a reason not to go behind a building, not a punishment for range.
const LOSS_CLEAN = 26;
const LOSS_DEAD = 60;

// Blocked at all, before any depth is counted. A ridge line or a thin roof is
// a single sheet of geometry with no far face, so its measured depth is
// honestly zero — and yet standing behind a hill costs you the link. This is
// the diffraction term: the signal bends around the edge and arrives weakened.
const KNIFE_EDGE_DB = 12;

// Per metre of material on the path, on top of the edge term. A concrete wall
// runs 10-20 dB at 5.8 GHz, so a couple of metres of Paris facade should
// already hurt badly and a whole building should be fatal. Capped because the
// two-sided raycast can report hundreds of metres through a city block, and
// past a point dead is dead.
const OBSTRUCTION_DB_PER_M = 8;
const OBSTRUCTION_CAP = 60;

// Received power at D0 with nothing in the way. Only used to report a number
// that looks like an RSSI; it plays no part in the quality calculation. Puts
// the cliff at -95 dBm, which is about where a real 5.8 GHz receiver gives up.
const RSSI_REF_DBM = -35;

// Asymmetric, because that is what a diversity receiver does: it loses lock
// almost immediately and takes its time coming back. Symmetric smoothing makes
// flying back out from behind a building feel instant and wrong.
const TAU_FALL = 0.05;
const TAU_RISE = 0.35;

// Amplitude of the idle wander, in dB. Without it the RSSI readout is perfectly
// still in a hover, which no radio ever is.
const NOISE_DB = 1.5;
const NOISE_TAU = 0.25;

// Digital receivers do not fade, they hold the last good frame and then drop
// it. Two thresholds and not one: at a single threshold the picture strobes
// between frozen and clean while you hover on the boundary.
const FREEZE_ENTER = 0.35;
const FREEZE_LEAVE = 0.45;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Small deterministic generator rather than Math.random, so a selftest run is
// reproducible and a fade can be replayed exactly.
function xorshift(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};
}

export class VideoLink {
	constructor(seed = 0x5eed) {
		this._rand = xorshift(seed);
		// 0..1: scales the losses. The slider, so 0 means "no link modelling at
		// all" and 1 means the link can genuinely break.
		this.severity = 1;
		this.out = { quality: 1, rssiDbm: RSSI_REF_DBM, lossDb: 0, frozen: false };
		this.reset();
	}

	reset() {
		this._loss = 0;
		this._noise = 0;
		this._frozen = false;
		this.out.quality = 1;
		this.out.rssiDbm = RSSI_REF_DBM;
		this.out.lossDb = 0;
		this.out.frozen = false;
	}

	setSeverity(s) {
		this.severity = clamp01(s);
	}

	// distance in metres; blocked/span straight out of
	// physics.obstructionBetween(). Mutates and returns the same object every
	// frame — this runs at frame rate.
	update({ distance, blocked, span, dt }) {
		const spread = 20 * Math.log10(Math.max(distance, D0) / D0);
		const shadow = blocked
			? Math.min(KNIFE_EDGE_DB + span * OBSTRUCTION_DB_PER_M, OBSTRUCTION_CAP)
			: 0;
		const target = (spread + shadow) * this.severity;

		// Rising loss is the link failing, falling loss is it coming back.
		const tau = target > this._loss ? TAU_FALL : TAU_RISE;
		const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
		this._loss += (target - this._loss) * k;

		// Ornstein-Uhlenbeck-ish wander: pulled back to zero, so it stays bounded
		// instead of drifting off the way a plain random walk would.
		const kn = dt > 0 ? 1 - Math.exp(-dt / NOISE_TAU) : 1;
		this._noise += ((this._rand() * 2 - 1) * NOISE_DB - this._noise) * kn;

		const loss = Math.max(0, this._loss + this._noise * this.severity);
		const quality = 1 - clamp01((loss - LOSS_CLEAN) / (LOSS_DEAD - LOSS_CLEAN));

		// Frame drops. Only the digital renderer uses this, but it belongs to the
		// receiver rather than to the shader, so it is decided here. The
		// probability is the fade depth itself: at quality 0 nothing gets through
		// and the last good frame simply stays up, which is what a dead digital
		// link looks like.
		const enter = this._frozen ? FREEZE_LEAVE : FREEZE_ENTER;
		this._frozen = quality < enter && this._rand() > quality / enter;

		this.out.quality = quality;
		this.out.lossDb = loss;
		// Floored at the receiver's sensitivity: below that it reports nothing at
		// all, not an ever more negative number.
		this.out.rssiDbm = Math.max(-100, RSSI_REF_DBM - loss);
		this.out.frozen = this._frozen;
		return this.out;
	}
}

export const LINK_MODES = ['analogique', 'numérique'];
