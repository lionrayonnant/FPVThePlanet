import RAPIER from '@dimforge/rapier3d-compat';
import { QUAD, GRAVITY, Propulsion, HOVER_THRUST } from './quad.js';

export { QUAD, HOVER_THRUST };

// Kept for callers that still want a single "how hard can it push" number.
export const MAX_THRUST = 4 * QUAD.maxThrustPerMotor;
export const DRONE = QUAD;      // old name, still used by tools/

export async function initPhysics() {
	await RAPIER.init();
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

export class Physics {
	constructor(collision, spawn, options = {}) {
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
				.setCcdEnabled(true)
				// Damping is left at zero: every force the quad feels — thrust,
				// rotor drag, airframe drag — is a real force computed in quad.js.
				// A damping term on top would be the same drag counted twice.
				.setLinearDamping(0)
				.setAngularDamping(0)
				.setCanSleep(false)
				// A quad is not a ball. Roll and pitch inertia are about half what
				// the collision sphere implies and yaw is nearly twice roll, and
				// that asymmetry is most of the difference between "this handles
				// like a quad" and "this handles like a thrown rock".
				.setAdditionalMassProperties(
					QUAD.mass, ZERO,
					{ x: QUAD.inertia.x, y: QUAD.inertia.y, z: QUAD.inertia.z },
					IDENTITY,
				),
		);

		// The collider stays a sphere of the arm radius even though the airframe
		// is a flat X. Two reasons: camera.near is pinned to this radius, so a
		// shape that can get closer to the camera than 0.15 m would put geometry
		// inside the near plane; and a 5" quad with its props is closer to a disc
		// than to a box anyway. Density 0 so only the mass properties above count.
		this.collider = this.world.createCollider(
			RAPIER.ColliderDesc.ball(QUAD.radius)
				.setDensity(0)
				.setRestitution(0.35)
				.setFriction(0.8)
				.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
				.setContactForceEventThreshold(30),
			this.body,
		);
		this.events = new RAPIER.EventQueue(true);

		this.propulsion = new Propulsion();
		this.meanWind = options.wind ? { ...options.wind } : { x: 0, y: 0, z: 0 };
		this.propulsion.gustStrength = options.gusts ?? 0;

		// Ground effect only reaches a rotor diameter or so, and a raycast at the
		// full 250 Hz against 3.7M triangles is wasted work. 25 Hz is far faster
		// than the quad can cross that band.
		this._aglEvery = 10;
		this._aglCounter = 0;
		this._agl = null;
		this.airspeed = 0;

		// castRay only sees colliders once the query pipeline has been built.
		this.world.step();
		this.reset();

		this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
		// Its own Ray: groundBelow() mutates _ray on every physics step, and the
		// link query runs from the render loop, in between.
		this._linkRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
		this._obstruction = { blocked: false, span: 0 };
	}

	reset() {
		this.body.setTranslation(this.spawn, true);
		this.body.setRotation(IDENTITY, true);
		this.body.setLinvel(ZERO, true);
		this.body.setAngvel(ZERO, true);
		this.propulsion.reset();
		this._agl = null;
		this._aglCounter = 0;
		this.airspeed = 0;
	}

	get position() { return this.body.translation(); }
	get rotation() { return this.body.rotation(); }
	get velocity() { return this.body.linvel(); }
	get angularVelocity() { return this.body.angvel(); }
	get battery() { return this.propulsion.battery; }

	setWind(mean, gusts) {
		if (mean) this.meanWind = { ...mean };
		if (gusts !== undefined) this.propulsion.gustStrength = gusts;
	}

	// One fixed step. `motors` is four commands in 0..1 straight from the mixer.
	// Returns the largest contact force seen during the step, for crash detection.
	step(motors, dt = this.world.timestep) {
		// Rapier keeps user forces until they are cleared; without this every
		// previous step's thrust stays applied and the quad rockets off.
		this.body.resetForces(false);
		this.body.resetTorques(false);

		const q = this.body.rotation();
		const v = this.body.linvel();
		const p = this.body.translation();

		if (this._aglCounter-- <= 0) {
			this._aglCounter = this._aglEvery;
			const g = this.groundBelow(p.x, p.y, p.z, 6);
			this._agl = g === null ? null : p.y - g;
		}

		// Airspeed, not ground speed: the aerodynamics only ever see the air.
		const wind = this.propulsion.updateWind(this.meanWind, dt);
		const ax = v.x - wind.x, ay = v.y - wind.y, az = v.z - wind.z;
		const vBody = unrotateVec(q, ax, ay, az);
		// Kept around because the wind rush the pilot hears follows the air, not
		// the ground: with a tailwind a fast quad can be nearly silent.
		this.airspeed = Math.hypot(ax, ay, az);

		const { force, torque } = this.propulsion.step(motors, vBody, this._agl, dt);

		const fw = rotateVec(q, force.x, force.y, force.z);
		this.body.addForce(fw, true);
		const tw = rotateVec(q, torque.x, torque.y, torque.z);
		this.body.addTorque(tw, true);

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

	// What sits on the straight line between two points: whether anything does at
	// all, and how many metres deep it is. Returns a reused object — this runs at
	// frame rate.
	//
	// Two rays, one from each end: the first hit going out is where the material
	// starts, the first hit coming back is where it ends, so the span between
	// them is how much of it the signal has to cross. One ray would only ever say
	// "something is in the way", and a link that switches off the instant a roof
	// edge clips the line is a switch, not an attenuation — clipping the corner
	// of a roof and having a whole building in between are not the same event.
	//
	// `blocked` is separate from `span` because a photogrammetry mesh is a
	// surface soup, not a solid: a building shell has a near wall and a far wall
	// and reports its real depth, but terrain and a thin roof are a single sheet
	// with no far face at all, so their span is legitimately zero. Zero span is
	// not a clear path, and only the flag can tell the two apart.
	obstructionBetween(ax, ay, az, bx, by, bz) {
		const r = this._obstruction;
		r.blocked = false;
		r.span = 0;

		const dx = bx - ax, dy = by - ay, dz = bz - az;
		const distance = Math.hypot(dx, dy, dz);
		if (distance < 1e-3) return r;

		// Normalised, so times of impact come back in metres like groundBelow's.
		const nx = dx / distance, ny = dy / distance, nz = dz / distance;
		const ray = this._linkRay;

		ray.origin.x = ax; ray.origin.y = ay; ray.origin.z = az;
		ray.dir.x = nx; ray.dir.y = ny; ray.dir.z = nz;
		// The drone's own sphere contains the origin; without excluding it the
		// answer would be "blocked by yourself, always".
		const out = this.world.castRay(ray, distance, true, undefined, undefined, this.collider);
		if (!out) return r;
		r.blocked = true;

		ray.origin.x = bx; ray.origin.y = by; ray.origin.z = bz;
		ray.dir.x = -nx; ray.dir.y = -ny; ray.dir.z = -nz;
		const back = this.world.castRay(ray, distance, true, undefined, undefined, this.collider);
		// No return hit means the two casts disagree; take the far endpoint as the
		// far face rather than reporting a negative depth.
		r.span = back
			? Math.max(0, distance - out.timeOfImpact - back.timeOfImpact)
			: Math.max(0, distance - out.timeOfImpact);
		return r;
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
