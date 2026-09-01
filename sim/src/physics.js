import RAPIER from '@dimforge/rapier3d-compat';
import { QUAD, GRAVITY, Propulsion, HOVER_THRUST, hoverThrust } from './quad.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';
import { hoverThrottle } from './flightController.js';
import { WindField, PROBE_COUNT, PROBE_RANGE, PROBE_DOWN, probeDirection } from './wind.js';

// Rayon du collider sphérique. Toujours 0,15 m, toutes familles confondues
// (camera.near y est épinglé) — nommé ici parce que la friction au sol en a
// besoin pour passer du linéaire à l'angulaire.
const COLLIDER_RADIUS = 0.15;

// Coefficient de friction des pieds du drone sur le sol, utilisé par le ground
// hold (voir step()). Justifié là-bas.
const MU_GROUND = 0.6;

export { QUAD, HOVER_THRUST, hoverThrust };
export const maxThrust = (profile = QUAD) => 4 * profile.maxThrustPerMotor;

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
		// The airframe family (src/drone-profiles.js). Defaults to the 5"
		// freestyle build; a session (PHASE 06+) passes its target's profile.
		this.profile = options.profile ?? DEFAULT_PROFILE;
		this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
		this.world.timestep = 1 / 250;

		this.groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
		// Mode ?live= (#168, #170) : pas de collision.bin, donc un trimesh de
		// scène à 0 sommet. Rapier n'accepte pas un trimesh vide (RuntimeError
		// wasm "unreachable" côté ColliderDesc.trimesh) — sauter la création
		// dans ce cas et laisser groundBody nu, prêt à recevoir des colliders
		// de nœuds rocktree via addNodeCollider().
		if (collision.vertices.length > 0 && collision.indices.length > 0) {
			this.world.createCollider(
				RAPIER.ColliderDesc.trimesh(collision.vertices, collision.indices)
					.setFriction(0.9)
					.setRestitution(0.15),
				this.groundBody,
			);
		}
		// Colliders rocktree progressifs (#168, #170) : un trimesh par nœud
		// reçu en vol, sur ce MÊME corps fixe — Rapier accepte plusieurs
		// colliders par corps nativement, pas besoin d'un corps par nœud.
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
				// Un quad ne rebondit pas : pieds souples, hélices, châssis carbone
				// qui encaisse. 0.35 le faisait ricocher comme une balle et rendait
				// toute pose impossible.
				//
				// PHASE 08 : PHASE 06 avait posé 0.05 / 1.0, mesuré sur freestyle5
				// seul (06 précède les familles). Croisé avec le sweep 6 familles
				// de PHASE 07, cette paire fait déraper le toothpick (ultra-léger)
				// à 1.55 m/s sur le maillage penté, au-dessus du seuil « sits still »
				// de tools/selftest.mjs. Re-balayé rest×fric contre ce selftest
				// (tour-eiffel) : 0.15 / 1.0 remet le toothpick à 0.99 m/s, garde
				// toutes les familles vertes et « a gentle landing » à 483 N (≪ 1500).
				// 0.15 reste franchement sans rebond — loin des 0.35 qui ricochaient.
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
		this._air = { v: null, omega: null, agl: null, shake: 0 };

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

	// #168, #170 : convertit la géométrie d'UN nœud rocktree fraîchement
	// décodé en collider Rapier, sur le même groundBody que le trimesh de
	// scène (s'il existe) ou seul (mode ?live=, pas de collision.bin).
	// Mêmes réglages de friction/restitution que le trimesh de scène — un sol
	// qui se comporte pareil des deux côtés, cuit ou streamé.
	addNodeCollider(path, vertices, indices) {
		if (this._nodeColliders.has(path)) {
			throw new Error(`addNodeCollider: "${path}" est déjà chargé — removeNodeCollider() d'abord`);
		}
		// SANS corps parent (#184) : un collider attaché à groundBody force
		// Rapier à recalculer les propriétés de masse du corps au step suivant
		// en sommant TOUS ses trimesh — mesuré à ~57 ms par step dès qu'une
		// vague de streaming ajoute des nœuds à chaque frame (spirale de
		// rattrapage de l'accumulateur : frames de 700-1700 ms). Un collider
		// sans parent est statique dans le monde, aucune propriété de masse à
		// recalculer, et se comporte identiquement face au drone.
		const collider = this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(vertices, indices)
				.setFriction(0.9)
				.setRestitution(0.15),
		);
		this._nodeColliders.set(path, collider);
		// Rapier ne rafraîchit l'accélération des requêtes (castRay etc.) que
		// dans world.step() — un collider ajouté/retiré hors step() reste
		// invisible à groundBelow() tant qu'on ne force pas cette mise à jour.
		// Le streaming rocktree doit être interrogeable au frame même où le
		// nœud arrive, pas seulement au prochain tick physique.
		this.world.queryPipeline.update(this.world.colliders);
	}

	removeNodeCollider(path) {
		const collider = this._nodeColliders.get(path);
		if (!collider) throw new Error(`removeNodeCollider: "${path}" n'est pas chargé`);
		this.world.removeCollider(collider, true);
		this._nodeColliders.delete(path);
		this.world.queryPipeline.update(this.world.colliders);
	}

	reset() {
		this.body.setTranslation(this.spawn, true);
		this.body.setRotation(IDENTITY, true);
		this.body.setLinvel(ZERO, true);
		this.body.setAngvel(ZERO, true);
		this.propulsion.reset();
		this.propulsion.primeFor(hoverThrottle(this.profile, IDENTITY));
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
		this.propulsion.primeFor(hoverThrottle(this.profile, quaternion));
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

	// La rosace de sondage telle que le dernier step() l'a lancée, ou null si
	// aucun sondage n'a encore eu lieu. Lecture seule, aucun rayon de plus :
	// l'acoustique du lieu (src/space.js) se sert des MÊMES rayons que l'ombre
	// de vent, ce qui est la raison pour laquelle elle est gratuite.
	get probe() { return this._probed ? this._probe : null; }

	// One fixed step. `motors` is four commands in 0..1 straight from the mixer.
	// Returns the largest contact force seen during the step, for crash detection.
	//
	// `external` : une force en newtons, repère MONDE, ajoutée au même pas que
	// la poussée. Un paramètre et non un setter : une force externe ne doit pas
	// pouvoir traîner d'un pas sur l'autre, et resetForces() en tête de cette
	// méthode rend tout addForce appelé du dehors silencieusement inopérant.
	// Seule cliente aujourd'hui : la clôture de zone (#139).
	step(motors, dt = this.world.timestep, external = null) {
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
		// Ground hold : le drone est posé, gaz coupés (décidé par main.js). Le
		// vent ne le pousse plus — au sol on est à l'abri, et surtout un quad
		// posé ne doit pas glisser tout seul — et on saigne sa vitesse résiduelle
		// pour qu'une sphère de collision ne roule pas sans fin.
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

		const { force, torque } = this.propulsion.step(motors, air, dt);

		const fw = rotateVec(q, force.x, force.y, force.z);
		this.body.addForce(fw, true);
		const tw = rotateVec(q, torque.x, torque.y, torque.z);
		this.body.addTorque(tw, true);
		if (external) this.body.addForce(external, true);

		let impact = 0;
		this.world.step(this.events);
		this.events.drainContactForceEvents((e) => {
			impact = Math.max(impact, e.totalForceMagnitude());
		});

		if (this._groundHold) {
			const k = Math.exp(-dt / 0.15);
			const lv = this.body.linvel();
			const av = this.body.angvel();
			// Deux amortissements, pas un : l'exponentiel saigne vite un
			// transitoire violent (un roulis de 8 rad/s au contact retombe en
			// moins d'une seconde), mais il ne l'annule jamais — il le divise.
			// Or la gravité le long de la pente en réinjecte à chaque pas : sur
			// un terrain réel, ces deux-là s'équilibrent à un fluage permanent
			// (mesuré sur tour-eiffel : 0,07 à 0,38 rad/s sur des pentes de 1 à
			// 3°, jamais décroissant). C'est ce fluage qui rendait la pose
			// impossible à reconnaître — la sphère roule sans fin.
			//
			// Ce qui manque au modèle est la friction statique : un quad posé
			// tient sur ses pieds, il ne roule pas comme une bille. On l'ajoute
			// donc telle quelle, en Coulomb — une décélération constante mu*g
			// qui, contrairement à un facteur exponentiel, ANNULE le mouvement
			// au lieu de l'asymptoter, et qui tient l'appareil sur toute pente
			// sous l'angle de friction atan(mu). mu = 0,6 : pieds plastique /
			// caoutchouc sur pierre ou béton (0,5-0,8 en pratique), soit une
			// tenue jusqu'à 31° — cohérent avec la limite déjà mesurée du
			// modèle sphère (au-delà de ~33° la sphère glisse et quitte la
			// pente, voir tools/landing-selftest.mjs).
			const dv = MU_GROUND * GRAVITY * dt;
			const sp = Math.hypot(lv.x, lv.z);
			// `sp <= dv` : la friction avait de quoi tout arrêter dans ce pas.
			// On s'arrête, on ne repart pas en arrière.
			const fl = sp <= dv ? 0 : (sp - dv) / sp;
			// Même friction vue en rotation : au point de contact, une sphère de
			// rayon R qui roule à v tourne à v/R, donc la même décélération
			// linéaire vaut dv/R en angulaire.
			const dw = dv / COLLIDER_RADIUS;
			const sw = Math.hypot(av.x, av.y, av.z);
			const fa = sw <= dw ? 0 : (sw - dw) / sw;
			this.body.setLinvel({ x: lv.x * k * fl, y: lv.y, z: lv.z * k * fl }, true);
			this.body.setAngvel({ x: av.x * k * fa, y: av.y * k * fa, z: av.z * k * fa }, true);
		}
		return impact;
	}

	// Posé, gaz coupés : coupe le vent et amortit la vitesse résiduelle pour que
	// le drone s'immobilise au lieu de rouler comme une bille. Décidé par
	// main.js (qui seul connaît l'état de l'armement et des gaz).
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
