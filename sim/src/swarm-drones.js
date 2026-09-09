// The swarm (issue #29) — the INSTANCE: it owns the meshes and it is the only
// thing that knows both the pure model (src/swarm.js) and main.js. Sibling of
// src/ambient-drones.js, and built on the same pattern; the voices are not
// here (src/swarm-audio.js owns those).
//
// Two decisions shape this file, both from the spec:
//
//  1. Every unit shares the seed `${doctrineSeed}::unit`, so there is ONE
//     recipe, ONE merged geometry and ONE body material for the whole flight.
//     Serial hardware deployed as a batch — the lore and the draw-call budget
//     agree. Twelve units are 12 body + 12 LED = 24 draw calls.
//  2. The mesh array is PRIVATE. Instancing (2 draw calls) is out of scope,
//     but nothing outside this file may hold a mesh, so moving to an
//     InstancedMesh stays a local change.
//
// update() allocates NOTHING: the Three objects and the model's arguments are
// all pre-allocated in the constructor.
import * as THREE from 'three';
import { SwarmModel, SWARM_UNIT } from './swarm.js';
import { shapeOf, RECIPE_PROFILES } from './drone-shape.js';
import { buildDroneMesh, LedMaterial, setSun, setFog, setTime, setResolution } from './drone-mesh.js';
import { targetCamera } from '../tools/target-camera.mjs';
import { token } from './palette.js';
import { SwarmAudio } from './swarm-audio.js';
import { SWARM_AUDIO, rankNearest } from '../tools/swarm-audio-model.mjs';
import { azimuthPan } from '../tools/ambient-audio-model.mjs';
import { engineIn, context as audioContext } from './audio-bus.js';
import { space } from './space.js';

const hex = (name) => new THREE.Color(token(name)).getHex();

// The strong rear LED the recipe asks for (drone-shape.js, role `led`). The
// billboard's screen size comes from this floor in pixels, so this is where
// "strong" is actually spent: 5 px against the 3 px every other machine gets.
// Chosen, not measured — like the rest of the LED's look.
const LED_MIN_PX = 5;

// The strobe phase and duty of a unit, drawn from its index off the shared
// seed. Same generator as the ambients': a swarm that blinked in unison would
// read as one object, not as twelve.
function strobeRng(seed) {
	let x = 0;
	for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
	return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class SwarmDrones {
	constructor({ scene }) {
		this.scene = scene;
		this.model = null;
		// PRIVATE (see the header): { group, ledMaterial } per unit.
		this._meshes = [];
		// The one mesh that OWNS the shared geometry and the body material.
		// Its own group is never mounted; dispose() frees the resources.
		this._base = null;
		this._q = new THREE.Quaternion();
		this._p = new THREE.Vector3();
		this._s = new THREE.Vector3(1, 1, 1);
		// The voice (src/swarm-audio.js). Neither engineIn() nor space.input
		// exists at boot — ensureContext() waits for a user gesture and the
		// room acoustics are built at take-off — so both are resolved in
		// update(), on the first frame where the context exists.
		this.audio = new SwarmAudio();
		// Everything the voice needs, pre-allocated: update() allocates
		// NOTHING, and the allocation check in the selftest is what says so.
		this._state = {
			count: 0, nearCount: 0, dMean: 0, accelMean: 0, bedPan: 0,
			profile: SWARM_UNIT,
			near: Array.from({ length: SWARM_AUDIO.nearVoices }, () => ({ d: 0, behind: 0, pan: 0, vRadial: 0, accelMag: 0 })),
		};
		this._rank = new Int32Array(SWARM_AUDIO.nearVoices);
		// Per-unit scratch, sized by setSwarm().
		this._dist = null; this._pan = null; this._behind = null; this._vr = null; this._accel = null;
		this._camF = new THREE.Vector3();
		this._camR = new THREE.Vector3();
		this._camPan = { fx: 0, fz: -1, rx: 1, rz: 0 };
		this._ap = { pan: 0, behind: 0 };
		// The link is dead: the voices stay silent until the next
		// setSwarm()/reset(). silence() ramps ONCE while update() revises the
		// gains every frame, so it needs a latch — same trap as AmbientDrones.
		this._silenced = false;
		this._lastFog = { color: -1, density: -1 };
		this._lastRes = { w: -1, h: -1 };
		this._time = 0;
		this._colors = { frame: hex('--dark-grey'), metal: hex('--grey'), prop: hex('--light-grey'), led: hex('--warm-white') };
		// What __sim.debug().swarm renders. Written in place, never realloc'd —
		// same contract as SwarmModel.debug().
		this._dbg = { size: 0, doctrine: null, raysCast: 0, blockedUnits: 0, lagRange: [0, 0], drawCalls: 0, audioNodes: 0 };
	}

	// The swarm descriptor the session persists — { size, doctrineSeed } — or
	// null (no cluster: the ordinary case). A second call replaces everything.
	setSwarm(swarm) {
		this._clear();
		if (!swarm) return;
		const seed = swarm.doctrineSeed;
		this.model = new SwarmModel({ size: swarm.size, doctrineSeed: seed, seed });
		const n = this.model.size;

		// One recipe for the whole batch. `build` is empty on purpose: at
		// silhouette detail the recipe reads nothing off an instance, and a
		// swarm unit HAS no instance — its pack comes from the recipe profile.
		const unitSeed = `${seed}::unit`;
		const shape = shapeOf({
			profile: RECIPE_PROFILES.swarmUnit,
			build: {},
			// `swarmUnit` n'est pas dans CAMERA_FAMILIES : targetCamera() retombe
			// donc sur la table du freestyle5, et l'uptilt tiré ne sert qu'à
			// incliner la boîte de caméra de la recette. Contrairement à
			// eyeOf(), qui recalcule l'avancée de l'objectif parce qu'elle
			// décide de ce que la vue embarquée montre, cet angle-là n'a aucune
			// conséquence mesurable : personne ne regarde jamais par l'oeil
			// d'une unité d'essaim.
			camera: targetCamera({ seed: unitSeed, family: RECIPE_PROFILES.swarmUnit.family }),
		});
		const base = buildDroneMesh(shape, { colors: this._colors });
		this._base = base;

		const rand = strobeRng(`${unitSeed}::led`);
		for (let k = 0; k < n; k++) {
			const body = new THREE.Mesh(base.body.geometry, base.material);
			body.frustumCulled = true;
			// Unit 0 reuses the material buildDroneMesh() already made and
			// coloured; the others get their own, for the strobe alone.
			const ledMaterial = k === 0 ? base.ledMaterial : LedMaterial();
			ledMaterial.uniforms.uColor.value.set(this._colors.led);
			ledMaterial.uniforms.uMinPx.value = LED_MIN_PX;
			ledMaterial.uniforms.uPhase.value = rand();
			ledMaterial.uniforms.uDuty.value = 0.3 + rand() * 0.5;
			const led = new THREE.Mesh(base.led.geometry, ledMaterial);
			led.position.copy(base.led.position);
			led.frustumCulled = false;   // its screen size does not follow its geometry
			// No setLedFade() here, unlike the ambients: an ambient is BORN at
			// 120–320 m and its light has to fade in, while a unit never leaves
			// the player's wake — the material's own 200/320 m never bites.
			const group = new THREE.Group();
			group.matrixAutoUpdate = false;
			group.visible = false;   // until the first update() places it
			group.add(body);
			group.add(led);
			this.scene.add(group);
			this._meshes.push({ group, ledMaterial });
		}
		this._dist = new Float64Array(n);
		this._pan = new Float64Array(n);
		this._behind = new Float64Array(n);
		this._vr = new Float64Array(n);
		this._accel = new Float64Array(n);
		this._silenced = false;
	}

	_clear() {
		for (const m of this._meshes) {
			m.group.parent?.remove(m.group);
			// The base owns unit 0's LED material; the rest are ours.
			if (m.ledMaterial !== this._base?.ledMaterial) m.ledMaterial.dispose();
		}
		this._meshes.length = 0;
		this._state.count = 0; this._state.nearCount = 0;
		this.audio.update(this._state);
		this._dist = this._pan = this._behind = this._vr = this._accel = null;
		this._silenced = false;
		// Geometry (shared) + body material + the LED plane, in one call.
		this._base?.dispose();
		this._base = null;
		this.model = null;
		// The meshes to come hold NO world uniform: invalidate both latches so
		// the first frame writes them (same trap as AmbientDrones).
		this._lastFog.color = -1; this._lastFog.density = -1;
		this._lastRes.w = -1; this._lastRes.h = -1;
	}

	// The player jumped or died: the wake is void and the units come back onto
	// him. `player` is Rapier's {x,y,z}, or null before there is one.
	reset(player) { this.model?.reset(player ?? null); this._silenced = false; }

	// Frozen physics: the units do not move, so a held note would be worse
	// than nothing (son.md:41-42).
	setMuted(b) { this.audio.setMuted(b); }
	// Latches the silence: see `_silenced` in the constructor.
	silence() { this._silenced = true; this.audio.silence(); }

	// Once per frame, dt = 0 when frozen. `player` : Rapier {x,y,z} ;
	// `playerVel`/`camera` : the LISTENER (Rapier {x,y,z} and the posed Three
	// camera), both optional — without them there is no voice ; `time` :
	// the physics clock in seconds ; `terrain` : physics (obstructionBetween) ;
	// `wind` : physics.wind.out ; `fence` : the pre-baked bbox or the live
	// trusted circle, MUTATED by the caller, never held by the model ; `sun` :
	// SunField|null ; `dim` : the same tile dimming the ambients get.
	update({ dt, player, playerVel, camera, time, terrain, wind, fence, fogColor, fogDensity, sun, dim, resolution }) {
		const m = this.model;
		if (!m) return;
		// The audio graph, as soon as the context exists (user gesture): two
		// null tests a frame, no allocation. Same idiom as AmbientDrones.
		if (!this.audio.running) {
			const ctx = audioContext();
			if (ctx) this.audio.start(ctx, engineIn(), space.input);
		}
		m.update(player, time, dt, terrain, wind, fence);
		this._time += dt;

		// Fog and resolution: written on change only, and on the SHARED body
		// material — one write for the whole swarm.
		const fogHex = typeof fogColor === 'number' ? fogColor : fogColor.getHex();
		const fogChanged = fogHex !== this._lastFog.color || fogDensity !== this._lastFog.density;
		if (fogChanged) {
			this._lastFog.color = fogHex; this._lastFog.density = fogDensity;
			setFog(this._base.material, fogHex, fogDensity);
		}
		const resChanged = !!resolution && (resolution.w !== this._lastRes.w || resolution.h !== this._lastRes.h);
		if (resChanged) { this._lastRes.w = resolution.w; this._lastRes.h = resolution.h; }
		setTime(this._base.material, this._time);
		if (sun) setSun(this._base.material, sun.dir, typeof dim === 'number' ? dim : 1, sun.night);

		for (let k = 0; k < this._meshes.length; k++) {
			const mesh = this._meshes[k];
			if (fogChanged) setFog(mesh.ledMaterial, fogHex, fogDensity);
			if (resChanged) setResolution(mesh.ledMaterial, resolution.w, resolution.h);
			setTime(mesh.ledMaterial, this._time);
			this._p.set(m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]);
			this._q.set(m.quat[4 * k], m.quat[4 * k + 1], m.quat[4 * k + 2], m.quat[4 * k + 3]);
			mesh.group.matrix.compose(this._p, this._q, this._s);
			mesh.group.matrixWorldNeedsUpdate = true;
			mesh.group.visible = true;
		}
		this._voice(player, playerVel, camera);
	}

	// The swarm's voice, once per frame. `camera`/`playerVel` are optional:
	// without them there is no listener, so there is no voice — the Node
	// selftests drive update() without either.
	//
	// THE THREE NEAR VOICES ARE RANKS, NOT UNITS. Voice i sings the i-th
	// NEAREST unit, and the rank is recomputed every frame. Two units that
	// swap rank are at the same distance at the crossing, so the sorted
	// sequence — and every gain derived from it — stays continuous while the
	// identity behind it jumps. Binding a voice to a unit and re-picking would
	// step the gain by the whole difference between the two.
	_voice(player, playerVel, camera) {
		const m = this.model, st = this._state;
		const n = m.size;
		if (!camera || !playerVel || !player || this._silenced) {
			st.count = 0; st.nearCount = 0;
			this.audio.update(st, undefined, space.input);
			return;
		}
		// The pan is relative to the MACHINE, deliberately: the player hears
		// through his camera, which rolls and pitches with the quad. Both
		// horizontal bases are renormalised — azimuthPan reads a cosine.
		this._camF.set(0, 0, -1).applyQuaternion(camera.quaternion);
		this._camR.set(1, 0, 0).applyQuaternion(camera.quaternion);
		const fn = Math.sqrt(this._camF.x * this._camF.x + this._camF.z * this._camF.z) || 1;
		const rn = Math.sqrt(this._camR.x * this._camR.x + this._camR.z * this._camR.z) || 1;
		this._camPan.fx = this._camF.x / fn; this._camPan.fz = this._camF.z / fn;
		this._camPan.rx = this._camR.x / rn; this._camPan.rz = this._camR.z / rn;

		for (let k = 0; k < n; k++) {
			const rx = m.pos[3 * k] - player.x, ry = m.pos[3 * k + 1] - player.y, rz = m.pos[3 * k + 2] - player.z;
			const d = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-6;
			const vx = m.vel[3 * k] - playerVel.x, vy = m.vel[3 * k + 1] - playerVel.y, vz = m.vel[3 * k + 2] - playerVel.z;
			const ap = azimuthPan(rx, rz, this._camPan, this._ap);
			this._dist[k] = d;
			this._pan[k] = ap.pan;
			this._behind[k] = ap.behind;
			this._vr[k] = (vx * rx + vy * ry + vz * rz) / d;
			const ax = m.acc[3 * k], ay = m.acc[3 * k + 1], az = m.acc[3 * k + 2];
			this._accel[k] = Math.sqrt(ax * ax + ay * ay + az * az);
		}

		rankNearest(n, this._dist, this._rank);
		st.count = n;
		st.nearCount = Math.min(SWARM_AUDIO.nearVoices, n);
		for (let i = 0; i < st.nearCount; i++) {
			const u = this._rank[i], v = st.near[i];
			v.d = this._dist[u]; v.behind = this._behind[u]; v.pan = this._pan[u];
			v.vRadial = this._vr[u]; v.accelMag = this._accel[u];
		}
		// The bed stands for everything the three voices do NOT sing; with
		// three units or fewer it stands for all of them, and its own gain law
		// then returns zero anyway.
		let sumD = 0, sumA = 0, sumPan = 0, bedN = 0;
		for (let k = 0; k < n; k++) {
			let voiced = false;
			for (let i = 0; i < st.nearCount; i++) if (this._rank[i] === k) { voiced = true; break; }
			if (voiced) continue;
			sumD += this._dist[k]; sumA += this._accel[k]; sumPan += this._pan[k]; bedN++;
		}
		if (bedN === 0) { for (let k = 0; k < n; k++) { sumD += this._dist[k]; sumA += this._accel[k]; sumPan += this._pan[k]; } bedN = n || 1; }
		st.dMean = sumD / bedN;
		st.accelMean = sumA / bedN;
		st.bedPan = sumPan / bedN;
		// space.input is re-read every frame (a property read, no allocation):
		// the context can be born BEFORE the room acoustics.
		this.audio.update(st, undefined, space.input);
	}

	debug() {
		const m = this.model;
		const d = this._dbg;
		if (!m) {
			d.size = 0; d.doctrine = null; d.raysCast = 0; d.blockedUnits = 0;
			d.lagRange[0] = 0; d.lagRange[1] = 0; d.drawCalls = 0;
			d.audioNodes = this.audio.nodesCreated;
			return d;
		}
		const md = m.debug();
		d.size = md.size;
		d.doctrine = md.doctrine;
		d.raysCast = md.raysCast;
		d.blockedUnits = md.blockedUnits;
		d.lagRange[0] = md.lagRange[0]; d.lagRange[1] = md.lagRange[1];
		// One body + one LED per unit, both untouched by frustum culling on the
		// LED. This is the number instancing would take down to 2.
		d.drawCalls = 2 * this._meshes.length;
		// Constant after start(): the browser check is that this number never
		// moves again once the swarm is flying.
		d.audioNodes = this.audio.nodesCreated;
		return d;
	}

	dispose() { this._clear(); this.audio.dispose(); }
}
