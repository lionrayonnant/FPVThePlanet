import { QUAD, GRAVITY, Propulsion, HOVER_THRUST, hoverThrust } from './quad.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';
import { hoverThrottle } from './flightController.js';
import { WindField, PROBE_COUNT, PROBE_RANGE, PROBE_DOWN, probeDirection } from './wind.js';

// Radius of the spherical collider. Always 0.15 m, every family (camera.near
// is pinned to it) — named here because the ground friction needs it to go
// from linear to angular.
const COLLIDER_RADIUS = 0.15;

// Friction coefficient of the drone's feet on the ground, used by the ground
// hold (see step()). Justified there.
const MU_GROUND = 0.6;

export { QUAD, HOVER_THRUST, hoverThrust };
export const maxThrust = (profile = QUAD) => 4 * profile.maxThrustPerMotor;

// Kept for callers that still want a single "how hard can it push" number.
export const MAX_THRUST = 4 * QUAD.maxThrustPerMotor;
export const DRONE = QUAD;      // old name, still used by tools/

// Rapier arrives through a dynamic import(), not a static one (#21): the
// `-compat` package embeds its WASM as base64, about 2 MB of the 2.9 MB main
// bundle. Statically imported, the menu, the terminal and the scanner all
// waited on its download and compilation before they could exist. Loaded
// here, Vite makes it a separate chunk, requested at the first initPhysics()
// — and overlapped with the live rocktree traversal (bootLive), with a baked
// scene's tiles (preloadScene), or prewarmed from the menu.
//
// EVERY use of RAPIER goes through initPhysics() first: that was already the
// contract (RAPIER.init() is required before any World at all), it has just
// become structural. The promise is memoised: concurrent or repeated calls
// load it only once.
let RAPIER = null;
let rapierReady = null;
export function initPhysics() {
	return (rapierReady ??= import('@dimforge/rapier3d-compat').then(async (mod) => {
		const R = mod.default ?? mod;
		await R.init();
		RAPIER = R;
	}));
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// Detaches an ArrayBuffer (transfers it to nobody): its memory is handed back
// immediately, without waiting for the garbage collector. No effect on a
// SharedArrayBuffer or an already-detached buffer; never throws.
export function detachBuffer(buf) {
	if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
	try { structuredClone(buf, { transfer: [buf] }); } catch { /* already detached, or not transferable */ }
}
const ZERO = { x: 0, y: 0, z: 0 };

export class Physics {
	constructor(collision, spawn, options = {}) {
		// The airframe family (src/drone-profiles.js). Defaults to the 5"
		// freestyle build; a session (PHASE 06+) passes its target's profile.
		this.profile = options.profile ?? DEFAULT_PROFILE;
		this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
		// Mirrored on the JS side because Rapier keeps its timestep as an f32:
		// reading world.timestep back gives 0.004000000189989805 for 1/250, so
		// comparing against it would report a change on every single step, and
		// the default value of step()'s `dt` would drift off the grid the rest
		// of the sim works on.
		this._timestep = 1 / 250;
		this.world.timestep = this._timestep;

		this.groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
		// ?live= mode (#168, #170): no collision.bin, so a scene trimesh with 0
		// vertices. Rapier does not accept an empty trimesh (wasm RuntimeError
		// "unreachable" inside ColliderDesc.trimesh) — skip the creation in that
		// case and leave groundBody bare, ready to receive rocktree node
		// colliders through addNodeCollider().
		this.groundCollider = null;
		if (collision.vertices.length > 0 && collision.indices.length > 0) {
			this.groundCollider = this.world.createCollider(
				RAPIER.ColliderDesc.trimesh(collision.vertices, collision.indices)
					.setFriction(0.9)
					.setRestitution(0.15),
				this.groundBody,
			);
		}
		// Progressive rocktree colliders (#168, #170): one trimesh per node
		// received in flight, on this SAME fixed body — Rapier accepts several
		// colliders per body natively, no need for one body per node.
		this._nodeColliders = new Map();

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
					this.profile.mass, ZERO,
					{ x: this.profile.inertia.x, y: this.profile.inertia.y, z: this.profile.inertia.z },
					IDENTITY,
				),
		);

		// The collider stays a sphere of the arm radius even though the airframe
		// is a flat X. Two reasons: camera.near is pinned to this radius, so a
		// shape that can get closer to the camera than 0.15 m would put geometry
		// inside the near plane; and a 5" quad with its props is closer to a disc
		// than to a box anyway. Density 0 so only the mass properties above count.
		// Always 0.15 m, every family: camera.near is pinned to it.
		this.collider = this.world.createCollider(
			RAPIER.ColliderDesc.ball(COLLIDER_RADIUS)
				.setDensity(0)
				// A quad does not bounce: soft feet, props, a carbon frame that takes
				// the hit. 0.35 made it ricochet like a ball and made any landing
				// impossible.
				//
				// PHASE 08: PHASE 06 had set 0.05 / 1.0, measured on freestyle5 alone
				// (06 predates the families). Crossed with PHASE 07's 6-family sweep,
				// that pair makes the toothpick (ultra-light) slide at 1.55 m/s on the
				// sloped mesh, above the "sits still" threshold of tools/selftest.mjs.
				// Re-swept restitution x friction against that selftest (tour-eiffel):
				// 0.15 / 1.0 puts the toothpick back at 0.99 m/s, keeps every family
				// green and "a gentle landing" at 483 N (much less than 1500). 0.15 is
				// still frankly bounce-free — far from the 0.35 that ricocheted.
				.setRestitution(0.15)
				.setFriction(1.0)
				.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
				.setContactForceEventThreshold(30),
			this.body,
		);
		this.events = new RAPIER.EventQueue(true);

		this._seed = options.seed;
		this.propulsion = new Propulsion({ profile: this.profile, seed: options.seed });
		this.wind = new WindField(options.windSeed);
		if (options.weather) this.wind.setParams(options.weather);
		// Reused, so the per-step call into quad.js does not allocate.
		// `worldVy` and `altitude` are not airspeeds: see quad.js:step().
		this._air = { v: null, omega: null, agl: null, shake: 0, worldVy: 0, altitude: 0 };

		// Ground effect only reaches a rotor diameter or so, and a raycast at the
		// full 250 Hz against 3.7M triangles is wasted work. 25 Hz is far faster
		// than the quad can cross that band.
		this._aglEvery = 10;
		this._aglCounter = 0;
		this._agl = null;
		this.airspeed = 0;

		// The wind probe. Ten rays instead of one, so a lower rate — 20.8 Hz,
		// about what the video link already spends against the same mesh, and
		// nine of the ten stop at 30 m so they leave the BVH far sooner than the
		// link's kilometre-long casts do. The counter starts offset from the AGL
		// one so the two never fire on the same step: the worst case should be
		// one probe, not one probe plus a ground query.
		this._windEvery = 11;
		this._windCounter = 6;
		this._probe = new Float32Array(PROBE_COUNT);
		this._probeDir = { x: 0, y: 0, z: 0 };
		this._probed = false;

		// castRay only sees colliders once the query pipeline has been built.
		this.world.step();
		this.reset();

		this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
		// Its own Ray: groundBelow() mutates _ray on every physics step, and the
		// link query runs from the render loop, in between.
		this._linkRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
		// And a third, for the same reason again: the wind rosette fires inside
		// step() between the ground query and the world step.
		this._windRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
		this._obstruction = { blocked: false, span: 0 };
		// Vertical force budget (diagnostics). Null until beginForceBudget().
		this._budget = null;
	}

	// Swap the airframe family without rebuilding the trimesh world — the wasm
	// heap only has room for one. Used by tools/selftest.mjs to run the flight
	// checks across every family. The collider stays a 0.15 m sphere.
	setProfile(profile) {
		this.profile = profile;
		this.propulsion = new Propulsion({ profile, seed: this._seed });
		this.body.setAdditionalMassProperties(
			profile.mass, ZERO,
			{ x: profile.inertia.x, y: profile.inertia.y, z: profile.inertia.z },
			IDENTITY, true,
		);
	}

	// Releases the JS arrays that were used to build the scene trimesh (issue
	// #249). Rapier has made its own copy in WASM memory; on the JS side all
	// that is left is the Collider's `_shape` cache, which holds the
	// `vertices`/`indices` views and therefore the whole collision.bin (36 MB on
	// paristest, 100+ on the large zones) for the lifetime of the page. Rapier
	// reloads that cache on demand (ensureShapeIsCached), so emptying it has no
	// effect on queries — and nobody here reads `collider.shape`. The buffer is
	// then DETACHED so it is handed back at once, without waiting for a GC that,
	// under memory pressure, arrives too late.
	releaseSourceArrays(collision) {
		if (this.groundCollider && '_shape' in this.groundCollider) this.groundCollider._shape = null;
		detachBuffer(collision?.vertices?.buffer);
	}

	// #168, #170: converts the geometry of ONE freshly decoded rocktree node
	// into a Rapier collider, on the same groundBody as the scene trimesh (if
	// there is one) or on its own (?live= mode, no collision.bin). Same
	// friction/restitution settings as the scene trimesh — ground that behaves
	// the same on both sides, baked or streamed.
	addNodeCollider(path, vertices, indices) {
		if (this._nodeColliders.has(path)) {
			throw new Error(`addNodeCollider: "${path}" is already loaded — removeNodeCollider() first`);
		}
		// A 0-triangle trimesh (a node whose geometry truncates entirely at
		// layerBounds[3], or whose triangles are all degenerate/excluded) crashes
		// Rapier's WASM — RuntimeError: unreachable, NOT a clean JS exception —
		// instead of raising an error for empty indices. Reproduced outside the
		// browser: ColliderDesc.trimesh(v, new Uint32Array(0)) is enough. Nothing
		// to collide with anyway: path stays registered (collider null) so that
		// removeNodeCollider() stays symmetric, without ever calling trimesh().
		if (indices.length < 3) {
			console.warn(`[physics] addNodeCollider("${path}"): 0 triangles after truncation, collider skipped`);
			this._nodeColliders.set(path, null);
			return;
		}
		// WITHOUT a parent body (#184): a collider attached to groundBody forces
		// Rapier to recompute the body's mass properties on the next step by
		// summing ALL of its trimeshes — measured at ~57 ms per step as soon as a
		// streaming wave adds nodes on every frame (accumulator catch-up spiral:
		// frames of 700-1700 ms). A collider with no parent is static in the
		// world, has no mass properties to recompute, and behaves identically
		// towards the drone.
		const collider = this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(vertices, indices)
				.setFriction(0.9)
				.setRestitution(0.15),
		);
		this._nodeColliders.set(path, collider);
		this._queryDirty = true;
	}

	removeNodeCollider(path) {
		if (!this._nodeColliders.has(path)) throw new Error(`removeNodeCollider: "${path}" is not loaded`);
		// null: a path registered by addNodeCollider() for a 0-triangle node (see
		// above) — never handed to Rapier, nothing to remove from it.
		const collider = this._nodeColliders.get(path);
		if (collider) this.world.removeCollider(collider, true);
		this._nodeColliders.delete(path);
		this._queryDirty = true;
	}

	// Rapier only refreshes the query acceleration structure (castRay and the
	// rest) inside world.step() — a collider added or removed outside step()
	// stays invisible to groundBelow() until the update is forced. But forcing
	// it on EVERY operation cost ~0.4 ms per operation (164 ms in total measured
	// over a wave of 400 nodes, #187): add/remove raise a flag instead, and the
	// caller (processLiveNodeWork, bootLive's wait-for-ground loop) pays for ONE
	// refit per batch, here.
	flushNodeColliders() {
		if (!this._queryDirty) return;
		this._queryDirty = false;
		this.world.queryPipeline.update(this.world.colliders);
	}

	reset() {
		this.body.setTranslation(this.spawn, true);
		this.body.setRotation(IDENTITY, true);
		this.body.setLinvel(ZERO, true);
		this.body.setAngvel(ZERO, true);
		this.propulsion.reset();
		this.propulsion.primeFor(
			hoverThrottle(this.profile, IDENTITY, this.propulsion.battery.voltage),
		);
		this.wind.reset();
		this._agl = null;
		this._aglCounter = 0;
		this._windCounter = 6;
		this._probed = false;
		this._groundHold = false;
		this.airspeed = 0;
	}

	// Like reset(), but to an arbitrary kinematic state instead of this.spawn /
	// identity / zero — used by the PHASE 11 entry-state generator so a session
	// can start (or a respawn can land) already in flight. this.spawn itself is
	// untouched: it stays the ground station's fixed position (see main.js's
	// `emitter`), independent of where a flight actually begins.
	applyEntryState({ position, quaternion, linvel, angvel }) {
		this.body.setTranslation(position, true);
		this.body.setRotation(quaternion, true);
		this.body.setLinvel(linvel, true);
		this.body.setAngvel(angvel, true);
		this.propulsion.reset();
		this.propulsion.primeFor(
			hoverThrottle(this.profile, quaternion, this.propulsion.battery.voltage),
		);
		this.wind.reset();
		this._agl = null;
		this._aglCounter = 0;
		this._windCounter = 6;
		this._probed = false;
		this._groundHold = false;
		this.airspeed = 0;
	}

	get position() { return this.body.translation(); }
	get rotation() { return this.body.rotation(); }
	get velocity() { return this.body.linvel(); }
	get angularVelocity() { return this.body.angvel(); }
	get battery() { return this.propulsion.battery; }

	// The four shaft speeds, rad/s, as Propulsion holds them. A live reference
	// and not a copy: flightController.js reads this every step for its RPM
	// notches (src/gyro.js), and a fresh array 250 times a second — 1000 times
	// once the loop substeps — is garbage nobody needs. Nothing downstream
	// writes to it.
	get rotorOmega() { return this.propulsion.omega; }

	// The same thing in rpm, which is what a person reads. Allocates, so it is
	// for the OSD and the benches, never for the loop.
	get rpm() { return this.propulsion.rpm; }

	// speed m/s at 10 m, direction in degrees the wind comes from, gust and
	// turbulence 0..1. See wind.js for what each one does.
	setWeather(params) {
		this.wind.setParams(params);
	}

	// The old vector API. Kept because window.__sim.setWind({x,y,z}, gust) is in
	// HANDOFF.md and in people's console history; it converts to a bearing and
	// hands over to setWeather.
	setWind(mean, gusts) {
		const params = {};
		if (mean) {
			params.speed = Math.hypot(mean.x, mean.z);
			// atan2 back out of (-sin, cos) — see the axis note in wind.js.
			params.direction = (Math.atan2(-mean.x, mean.z) * 180) / Math.PI;
		}
		if (gusts !== undefined) params.gust = Math.min(1, gusts / 6);
		this.setWeather(params);
	}

	// Ten rays around the drone, aimed by the wind. wind.js says which way each
	// one points and what its answer means; this end only knows how to cast.
	probeWind(x, y, z) {
		const ray = this._windRay;
		const d = this.wind.dirH;
		for (let i = 0; i < PROBE_COUNT; i++) {
			probeDirection(i, d.x, d.z, this._probeDir);
			ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
			ray.dir.x = this._probeDir.x; ray.dir.y = this._probeDir.y; ray.dir.z = this._probeDir.z;
			const range = PROBE_RANGE[i];
			// Excluding the drone's own sphere, which contains every origin.
			const hit = this.world.castRay(ray, range, true, undefined, undefined, this.collider);
			this._probe[i] = hit ? hit.timeOfImpact : range;
		}
		this._probed = true;
		return this._probe;
	}

	// The probe rosette as the last step() cast it, or null if no probing has
	// happened yet. Read-only, not one extra ray: the acoustics of the place
	// (src/space.js) use the SAME rays as the wind shadow, which is the reason
	// they are free.
	get probe() { return this._probed ? this._probe : null; }

	// One fixed step. `motors` is four commands in 0..1 straight from the mixer.
	// Returns the largest contact force seen during the step, for crash detection.
	//
	// `external`: a force in newtons, WORLD frame, added on the same step as the
	// thrust. A parameter and not a setter: an external force must not be able
	// to linger from one step to the next, and resetForces() at the top of this
	// method makes any addForce called from outside silently useless. Its only
	// client today: the zone fence (#139).
	//
	// `externalTorque`: a torque in N.m, WORLD frame, for exactly the same
	// reason and under exactly the same constraint — resetTorques() at the top
	// of this method wipes any addTorque called from outside. Its only client
	// today: assisted turtle mode (#105).
	step(motors, dt = this._timestep, external = null, externalTorque = null) {
		// Rapier integrates `world.timestep`, NOT the dt handed to this method.
		// Without this line the two disagreed the moment a caller asked for
		// anything but 1/250 s: quad.js advanced the airframe by dt while the
		// world advanced gravity, velocity and contacts by a fixed 1/250 s, so
		// a 1/50 s step fell at a FIFTH of g. The dt parameter was a lie to
		// everything below this class, which is also what made an adaptive
		// catch-up step impossible to write (see main.js).
		if (this._timestep !== dt) { this._timestep = dt; this.world.timestep = dt; }

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

		if (this.wind.active && this._windCounter-- <= 0) {
			this._windCounter = this._windEvery;
			this.probeWind(p.x, p.y, p.z);
		}

		// Airspeed, not ground speed: the aerodynamics only ever see the air.
		// The airspeed handed to the wind field is the previous step's, because
		// this step's is what the wind field is about to decide — 4 ms of lag on
		// a quantity that only sets a turbulence time constant.
		const wind = this.wind.update(p.y, this._probed ? this._probe : null, this.airspeed, dt);
		// Ground hold: the drone is down, throttle cut (decided by main.js). The
		// wind no longer pushes it — on the ground you are sheltered, and above
		// all a landed quad must not slide off on its own — and its residual
		// velocity is bled off so a collision sphere does not roll for ever.
		const wx = this._groundHold ? 0 : wind.x;
		const wy = this._groundHold ? 0 : wind.y;
		const wz = this._groundHold ? 0 : wind.z;
		const ax = v.x - wx, ay = v.y - wy, az = v.z - wz;
		// Kept around because the wind rush the pilot hears follows the air, not
		// the ground: with a tailwind a fast quad can be nearly silent.
		this.airspeed = Math.hypot(ax, ay, az);

		const air = this._air;
		air.v = unrotateVec(q, ax, ay, az);
		// Rapier reports angular velocity in the WORLD frame, and quad.js is
		// body-frame only. Skip this and the rotor damping becomes an
		// attitude-dependent invention that only misbehaves inverted.
		const w = this.body.angvel();
		air.omega = unrotateVec(q, w.x, w.y, w.z);
		air.agl = this._agl;
		air.shake = this.wind.intensity * this.wind.local;
		// Ground-frame vertical speed, for modulated gravity (§8.1) only.
		air.worldVy = v.y;
		// Metres above sea level for airDensity(). Scene coordinates are local
		// ENU with an arbitrary origin, so p.y is a height above that origin and
		// NOT an altitude; until a scene carries its own datum, sea level is the
		// honest answer and the argument travels so the call sites never have to
		// change again (src/air.js).
		air.altitude = 0;

		const { force, torque } = this.propulsion.step(motors, air, dt);

		const fw = rotateVec(q, force.x, force.y, force.z);
		this.body.addForce(fw, true);
		// Modulated gravity (§8.1): an explicit force along world -Y, never a
		// change to the solver's own g. Rapier's gravity stays the one true
		// value, so the force budget can still account for every newton and the
		// thrust-split invariant it asserts is untouched. See quad.js.
		if (this.propulsion.extraGravity !== 0) {
			this.body.addForce({ x: 0, y: -this.propulsion.extraGravity, z: 0 }, true);
		}
		const tw = rotateVec(q, torque.x, torque.y, torque.z);
		this.body.addTorque(tw, true);
		if (external) this.body.addForce(external, true);
		if (externalTorque) this.body.addTorque(externalTorque, true);

		let impact = 0;
		this.world.step(this.events);
		this.events.drainContactForceEvents((e) => {
			impact = Math.max(impact, e.totalForceMagnitude());
		});

		if (this._budget) this._accumulateBudget(q, dt, wy);

		if (this._groundHold) {
			const k = Math.exp(-dt / 0.15);
			const lv = this.body.linvel();
			const av = this.body.angvel();
			// Two dampings, not one: the exponential bleeds a violent transient
			// off quickly (an 8 rad/s roll on contact falls away in under a
			// second), but it never cancels it — it only divides it. And gravity
			// along the slope re-injects some on every step: on real terrain the
			// two balance out at a permanent creep (measured on tour-eiffel: 0.07
			// to 0.38 rad/s on slopes of 1 to 3 degrees, never decreasing). That
			// creep is what made a landing impossible to recognise — the sphere
			// rolls for ever.
			//
			// What the model is missing is static friction: a landed quad sits on
			// its feet, it does not roll like a marble. So it is added as such, in
			// Coulomb form — a constant deceleration mu*g which, unlike an
			// exponential factor, CANCELS the motion instead of asymptoting to it,
			// and which holds the machine on any slope below the friction angle
			// atan(mu). mu = 0.6: plastic/rubber feet on stone or concrete (0.5-0.8
			// in practice), i.e. a hold up to 31 degrees — consistent with the
			// already-measured limit of the sphere model (beyond ~33 degrees the
			// sphere slides and leaves the slope, measured on the landing bench
			// removed along with landing itself — D9, 2026-09-08).
			const dv = MU_GROUND * GRAVITY * dt;
			const sp = Math.hypot(lv.x, lv.z);
			// `sp <= dv`: friction had enough to stop everything within this step.
			// So it stops, it does not set off backwards.
			const fl = sp <= dv ? 0 : (sp - dv) / sp;
			// The same friction seen in rotation: at the contact point, a sphere of
			// radius R rolling at v turns at v/R, so the same linear deceleration
			// is worth dv/R in angular terms.
			const dw = dv / COLLIDER_RADIUS;
			const sw = Math.hypot(av.x, av.y, av.z);
			const fa = sw <= dw ? 0 : (sw - dw) / sw;
			this.body.setLinvel({ x: lv.x * k * fl, y: lv.y, z: lv.z * k * fl }, true);
			this.body.setAngvel({ x: av.x * k * fa, y: av.y * k * fa, z: av.z * k * fa }, true);
		}
		return impact;
	}

	// ---------------------------------------------------------------------
	// Vertical force budget.
	//
	// Four corrections to the flight model measured right and changed the feel
	// very little, which is itself evidence: it says the weight the pilot is
	// missing is not where those corrections were. Rather than guess a fifth
	// time, this measures where the drone's weight actually goes IN FLIGHT,
	// over real terrain and the real weather of the place — neither of which a
	// headless bench has.
	//
	// Everything is resolved along world +Y and reported as a fraction of the
	// airframe's weight, so the numbers add up to something a pilot can read:
	// "thrust is carrying 0.96 of the weight and the air is carrying 0.07".
	//
	// The thrust terms come from quad.js's own breakdown, which sums to its
	// force.y by construction; `residual` below is the check on that, and it
	// stays at zero unless the split and the force stop agreeing.
	beginForceBudget() {
		this._budget = {
			steps: 0, seconds: 0,
			thrust: 0, staticThrust: 0, inflow: 0, groundEffect: 0, vortexRing: 0,
			bodyDrag: 0, rotorDrag: 0, gravityTrim: 0, residual: 0,
			windUp: 0, windSpeed: 0, tilt: 0, verticalSpeed: 0,
		};
		return true;
	}

	// Averages since beginForceBudget(), as multiples of weight. Call it after
	// flying for a while; pass true to keep accumulating instead of stopping.
	forceBudget(keepGoing = false) {
		const b = this._budget;
		if (!b || b.steps === 0) return null;
		const n = b.steps;
		const out = {
			seconds: +b.seconds.toFixed(2),
			// Fractions of weight, along world +Y. Positive holds the drone up.
			thrustUp: +(b.thrust / n).toFixed(4),
			ofWhich: {
				staticThrust: +(b.staticThrust / n).toFixed(4),
				inflow: +(b.inflow / n).toFixed(4),
				groundEffect: +(b.groundEffect / n).toFixed(4),
				vortexRing: +(b.vortexRing / n).toFixed(4),
			},
			bodyDragUp: +(b.bodyDrag / n).toFixed(4),
			rotorDragUp: +(b.rotorDrag / n).toFixed(4),
			// Modulated gravity (spec 8.1), as a fraction of nominal weight and
			// signed like every other post here: NEGATIVE, because it pulls
			// down. It is its own line and not folded into anything, which is
			// the whole point of adding it as a force rather than as a change
			// to the solver's g. Zero when the trim is switched off.
			gravityTrimUp: +(b.gravityTrim / n).toFixed(4),
			residual: +(b.residual / n).toFixed(6),
			// Context the numbers above are meaningless without.
			meanTiltDeg: +(b.tilt / n).toFixed(1),
			meanUpdraft: +(b.windUp / n).toFixed(2),
			meanWindSpeed: +(b.windSpeed / n).toFixed(2),
			// Vertical SPEED, not acceleration: this accumulates linvel().y. It
			// shipped once named meanVerticalAccel, which it never was.
			meanVerticalSpeed: +(b.verticalSpeed / n).toFixed(3),
		};
		if (!keepGoing) this._budget = null;
		return out;
	}

	_accumulateBudget(q, dt, windUp) {
		const b = this._budget;
		const d = this.propulsion.diag;
		const W = this.profile.mass * GRAVITY;
		// Body +Y resolved onto world +Y: the cosine of the tilt, and the only
		// reason a tilted quad falls.
		const up = rotateVec(q, 0, 1, 0);
		// The body-frame drag vectors have to be rotated in full — a tilted
		// airframe's sideways drag has a vertical component.
		const bd = rotateVec(q, d.bodyDrag.x, d.bodyDrag.y, d.bodyDrag.z);
		const rd = rotateVec(q, d.rotorDrag.x, 0, d.rotorDrag.z);
		b.thrust += (d.thrust * up.y) / W;
		b.staticThrust += (d.staticThrust * up.y) / W;
		b.inflow += (d.inflow * up.y) / W;
		b.groundEffect += (d.groundEffect * up.y) / W;
		b.vortexRing += (-d.vortexRing * up.y) / W;
		b.bodyDrag += bd.y / W;
		b.rotorDrag += rd.y / W;
		// World frame already, and never rotated: gravity does not care which
		// way the airframe points.
		b.gravityTrim += -this.propulsion.extraGravity / W;
		// staticThrust + inflow + groundEffect - vortexRing must be thrust.
		b.residual += ((d.staticThrust + d.inflow + d.groundEffect - d.vortexRing - d.thrust) * up.y) / W;
		b.tilt += (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
		b.windUp += windUp;
		b.windSpeed += Math.hypot(this.wind.out.x, this.wind.out.y, this.wind.out.z);
		b.verticalSpeed += this.body.linvel().y;
		b.seconds += dt;
		b.steps++;
	}

	// Landed, throttle cut: cuts the wind off and damps the residual velocity so
	// the drone comes to rest instead of rolling like a marble. Decided by
	// main.js (which alone knows the arming and throttle state).
	setGroundHold(on) { this._groundHold = !!on; }

	// Height above ground as the wind probe sees it — hundreds of metres rather
	// than the six the ground-effect query is capped at.
	get windAgl() { return this.wind.agl; }

	// The drone's velocity through the air, in the body frame — what the
	// airframe and anything stuck to it actually feel. Zero before the first
	// step, rather than null: the render side reads this every frame and a null
	// there would be a branch in every caller for one frame of the whole run.
	get airVelocity() { return this._air.v ?? ZERO; }

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
