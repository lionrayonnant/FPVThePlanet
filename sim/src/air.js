// Air density (spec §8.3).
//
// The value is the ISA sea-level constant and does not vary yet. The ALTITUDE
// IS THE POINT: §8.3 requires the callers to hand it over now, so that a
// barometric law can be dropped in here later without touching a single call
// site. A call that passes nothing gets sea level.
//
// Altitude is metres above sea level. Scene coordinates are local ENU metres
// (X east, Y up, Z south) with an arbitrary origin, so a caller with only Y has
// to add the scene's own altitude before calling — which is exactly the
// conversion that would otherwise be forgotten the day the law lands.

export const SEA_LEVEL_AIR_DENSITY = 1.225;   // kg/m^3, ISA at 15 degC

export function airDensity(altitudeM = 0) {
	void altitudeM;
	return SEA_LEVEL_AIR_DENSITY;
}
