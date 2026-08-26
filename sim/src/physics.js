import RAPIER from '@dimforge/rapier3d-compat';

export const DRONE = {
	mass: 0.6,          // kg, a typical 5" freestyle quad
	radius: 0.15,       // m, collision sphere
	thrustToWeight: 4.0,
	dragArea: 0.011,    // Cd*A, tuned for ~30 m/s terminal speed in level flight
};

const AIR_DENSITY = 1.225;
const GRAVITY = 9.81;
export const MAX_THRUST = DRONE.thrustToWeight * DRONE.mass * GRAVITY;

export async function initPhysics() {
	await RAPIER.init();
}

export class Physics {
	constructor(collision, spawn) {
		this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
		this.world.timestep = 1 / 250;

		const groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
		this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(collision.vertices, collision.indices)
				.setFriction(0.9)
				.setRestitution(0.15),
			groundBody,
		);

		this.spawn = { ...spawn };
		this.body = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(spawn.x, spawn.y, spawn.z)
				.setCcdEnabled(true)          // 30 m/s covers 12cm per substep
				.setLinearDamping(0.02)       // real drag is applied as a force below
				.setAngularDamping(0.4)
				.setCanSleep(false),
		);
		this.collider = this.world.createCollider(
			RAPIER.ColliderDesc.ball(DRONE.radius)
				.setMass(DRONE.mass)
				.setRestitution(0.35)
				.setFriction(0.8)
				.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
				.setContactForceEventThreshold(30),
			this.body,
		);
		this.events = new RAPIER.EventQueue(true);

		// castRay only sees colliders once the query pipeline has been built.
		this.world.step();
		this.reset();

		this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
	}

	reset() {
		this.body.setTranslation(this.spawn, true);
		this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
		this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
	}

	get position() { return this.body.translation(); }
	get rotation() { return this.body.rotation(); }
	get velocity() { return this.body.linvel(); }
	get angularVelocity() { return this.body.angvel(); }

	// Runs one fixed step. `command` is {thrust (N, body +Y), torque (world N*m)}.
	step(command) {
		// Rapier keeps user forces until they are cleared, so without this the
		// thrust from every previous step stays applied and the drone rockets off.
		this.body.resetForces(false);
		this.body.resetTorques(false);

		const q = this.body.rotation();
		// Body +Y rotated into world: the thrust axis.
		const up = rotateVec(q, 0, 1, 0);
		this.body.addForce({
			x: up.x * command.thrust,
			y: up.y * command.thrust,
			z: up.z * command.thrust,
		}, true);

		// Quadratic aerodynamic drag; Rapier only offers linear damping.
		const v = this.body.linvel();
		const speed = Math.hypot(v.x, v.y, v.z);
		if (speed > 0.01) {
			const k = 0.5 * AIR_DENSITY * DRONE.dragArea * speed;
			this.body.addForce({ x: -k * v.x, y: -k * v.y, z: -k * v.z }, true);
		}

		this.body.addTorque(command.torque, true);

		let impact = 0;
		this.world.step(this.events);
		this.events.drainContactForceEvents((e) => {
			impact = Math.max(impact, e.totalForceMagnitude());
		});
		return impact;
	}

	// Height of the surface directly below a point, or null if nothing is there.
	groundBelow(x, y, z, maxDistance = 500) {
		this._ray.origin.x = x; this._ray.origin.y = y; this._ray.origin.z = z;
		const hit = this.world.castRay(this._ray, maxDistance, true, undefined, undefined, this.collider);
		return hit ? y - hit.timeOfImpact : null;
	}
}

export function rotateVec(q, x, y, z) {
	// v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
	const tx = 2 * (q.y * z - q.z * y);
	const ty = 2 * (q.z * x - q.x * z);
	const tz = 2 * (q.x * y - q.y * x);
	return {
		x: x + q.w * tx + (q.y * tz - q.z * ty),
		y: y + q.w * ty + (q.z * tx - q.x * tz),
		z: z + q.w * tz + (q.x * ty - q.y * tx),
	};
}

// Rotates a world vector into the body frame (conjugate rotation).
export function unrotateVec(q, x, y, z) {
	return rotateVec({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z);
}
