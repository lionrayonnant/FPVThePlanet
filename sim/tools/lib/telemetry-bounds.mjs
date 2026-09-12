// What a flight is allowed to claim.
//
// Telemetry comes from the browser — `PATCH /__operator/<id>/sessions/<sid>`
// carries it straight from the tab — so « finite and >= 0 » is not a bound:
// 1e308 satisfies it, and `1e308 + 1e308` is Infinity. A session stored with
// that value could never be closed again (closeSession merges, validateSession
// then refuses the result, and the flight stays PENDING forever), and the DATA
// screen reported a career of Infinity seconds: num() guards each input, never
// the sum (#83).
//
// These are ceilings, not expectations — nothing a real flight produces comes
// near them. One recorded track holds MAX_SAMPLES (18000) × SAMPLE_S (0.2) =
// 3600 s, and a session can be resumed, so a day of flight in a single session
// is already twenty-four times what the recorder can hold.
//
// Its own file rather than session-model's, because the DATA screen applies the
// same bounds on read and session-model imports node:crypto.
export const TELEMETRY_MAX = {
	durationS: 86400,        // 24 h of flight in one session
	distanceM: 2e7,          // that duration at maxSpeedMs, rounded up
	maxSpeedMs: 200,         // 720 km/h, several times anything this sim flies
	maxRateDps: 10000,       // 28 turns per second
	maxAltitudeM: 1e5,       // the Kármán line; the geofence stops a flight far below
};

// A telemetry that is finite, positive and inside the ceilings, whatever was
// stored. Used on read by the screens; the server refuses out-of-bounds values
// at the door rather than clamping them.
export function clampTelemetry(t) {
	const src = (t && typeof t === 'object') ? t : {};
	const out = {};
	for (const [k, max] of Object.entries(TELEMETRY_MAX)) {
		const v = src[k];
		out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
	}
	return out;
}
