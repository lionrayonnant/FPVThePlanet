// The end-screen drone viewer, as numbers (D12). No Three, no DOM: the pace of
// the orbit and the size of the frame live here so they can be read and tested
// without a GPU. src/drone-viewer.js is the only thing that draws.
//
// The pace is deliberately the SVG portrait's (src/drone-portrait.js): the same
// machine, seen the same way, whether it is the archive fiche or the screen the
// flight ends on. Staging, not measurement.

export const VIEWER = {
	turnS: 24,      // one full turn — slow: this is what is left, not a demo reel
	pitchDeg: 28,   // seen slightly from above, like a workshop card
	startDeg: 30,   // three-quarter entry: neither face-on nor in profile
	size: 220,      // px, square. Bigger than the archive portrait (160): this one is the subject
};

// Keep the camera off the poles. At the pole the azimuth becomes meaningless
// and the machine spins on itself instead of turning.
const POLAR_LIMIT = 85;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Where the camera looks from at `tMs` into the sequence: the free rotation
// plus whatever drag the viewer has accumulated. `dragDeg` is either a bare
// number (azimuth only — a finger or a stick pushed sideways) or
// {az, polar}. Degrees, and the azimuth is intentionally NOT wrapped: a caller
// that wants a continuous angle gets one.
export function viewerOrbit({ tMs = 0, dragDeg = 0 } = {}) {
	const drag = typeof dragDeg === 'number' ? { az: dragDeg, polar: 0 } : (dragDeg ?? {});
	return {
		azimuthDeg: VIEWER.startDeg + (tMs / 1000 / VIEWER.turnS) * 360 + (drag.az ?? 0),
		polarDeg: clamp(VIEWER.pitchDeg + (drag.polar ?? 0), -POLAR_LIMIT, POLAR_LIMIT),
	};
}
