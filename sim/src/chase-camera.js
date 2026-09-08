// D11 — where the CHASE camera stands. Pure geometry on plain vectors: no
// Three, no DOM, no physics, so main.js is the only place that knows how a
// quaternion becomes a heading and the placement itself stays testable.
//
// Coordinates are local ENU metres: X = east, Y = up, Z = south. The flight
// camera looks down the body's -Z, so yaw 0 means "nose to the north".

export const CHASE = {
	// A 5-inch quad is 0.25 m across. At 1.6 m, through the 120-degree lens the
	// flight camera wears, it read as a mark on the sky rather than a machine
	// (V6) — hence both numbers below and fovDeg.
	//
	// 1.1 m keeps chassis, livery and props legible while leaving the flight
	// near plane (0.15 m) well behind the camera. The 0.45 m rise puts the
	// horizon under the drone rather than through it, which is what makes the
	// ground read while flying low.
	back: 1.1,
	up: 0.45,
	// Chase is NOT the video feed: it is an outside camera, so it has no reason
	// to wear the target's wide FPV optics. At 120 degrees a 0.25 m machine at
	// 1.1 m covers 6% of the frame; at 75 it covers 15%, which is the
	// difference between a mark and a machine. The flight FOV is restored on
	// the way back to FPV, and this is only ever a CAP — a target with a
	// narrower lens keeps its own.
	fovDeg: 75,
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
