// D11 — where the CHASE camera stands. Pure geometry on plain vectors: no
// Three, no DOM, no physics, so main.js is the only place that knows how a
// quaternion becomes a heading and the placement itself stays testable.
//
// Coordinates are local ENU metres: X = east, Y = up, Z = south. The flight
// camera looks down the body's -Z, so yaw 0 means "nose to the north".

export const CHASE = {
	// A 5-inch quad is 0.25 m across. At 1.6 m it reads as a machine in a
	// place — chassis, livery and props legible — instead of the close-up the
	// old free cam gave, and the flight near plane (0.15 m) stays well behind
	// it. The 0.6 m rise puts the horizon under the drone rather than through
	// it, which is what makes the ground read while flying low.
	back: 1.6,
	up: 0.6,
	// Time constant of the follow. Short enough that a fast yaw does not leave
	// the camera trailing, long enough that propwash jitter is not amplified.
	tau: 0.12,
};

// The horizontal unit vector the nose points along, for a given yaw.
export function headingVector(yawRad) {
	return { x: Math.sin(yawRad), y: 0, z: -Math.cos(yawRad) };
}

// Where the chase camera would ideally stand this frame: behind the heading,
// slightly above. The smoothing is what actually places it (chaseStep).
export function chaseTarget(dronePos, yawRad, { back = CHASE.back, up = CHASE.up } = {}) {
	const f = headingVector(yawRad);
	return {
		x: dronePos.x - f.x * back,
		y: dronePos.y + up,
		z: dronePos.z - f.z * back,
	};
}

// Frame-rate independent exponential smoothing towards `desired`. dt = 0
// returns `current` unchanged (a frozen frame must not move the camera), and a
// long frame saturates at the target instead of overshooting past it.
export function chaseStep(current, desired, dt, tau = CHASE.tau) {
	if (!(dt > 0)) return current;
	const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
	return {
		x: current.x + (desired.x - current.x) * k,
		y: current.y + (desired.y - current.y) * k,
		z: current.z + (desired.z - current.z) * k,
	};
}
