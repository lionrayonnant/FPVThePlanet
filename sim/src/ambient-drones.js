// Les drones ambiants (issue #250) — l'instance qui lie le modèle pur
// (src/ambient.js), les maillages (src/drone-mesh.js) et les voix
// (src/ambient-audio.js), et qui parle à main.js. Rien d'autre ne connaît
// les trois à la fois.
//
// update() n'alloue RIEN : tous les objets Three, le scratch de pan et les
// six champs de chaque voix sont pré-alloués au constructeur.
import * as THREE from 'three';
import { AmbientModel, ambientSet, R_SPAWN, IN_VIEW_MIN_M } from './ambient.js';
import { shapeOf, RECIPE_PROFILES } from './drone-shape.js';
import { buildDroneMesh, setSun, setFog, setTime, setResolution, setLedFade } from './drone-mesh.js';
import { AmbientAudio } from './ambient-audio.js';
import { azimuthPan } from '../tools/ambient-audio-model.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { liveryColors } from '../tools/target-livery.mjs';
import { token } from './palette.js';
import { engineIn, context as audioContext } from './audio-bus.js';
import { space } from './space.js';

const hex = (name) => new THREE.Color(token(name)).getHex();

export class AmbientDrones {
	constructor({ scene, bounds }) {
		this.scene = scene;
		this.bounds = bounds;
		this.model = null;
		this.meshes = [];
		// Ni engineIn() ni space.input n'existent au boot : ensureContext()
		// attend un geste utilisateur et l'acoustique du lieu n'est bâtie
		// qu'ensuite. On les résout dans update(), au premier passage où le
		// contexte existe — pas ici, pas dans setScan().
		this.audio = new AmbientAudio();
		this._voices = [null, null, null, null];
		this._voiceIn = [0, 1, 2, 3].map(() => ({ d: 0, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: null }));
		this._q = new THREE.Quaternion();
		this._p = new THREE.Vector3();
		this._s = new THREE.Vector3(1, 1, 1);
		this._camF = new THREE.Vector3();
		this._camR = new THREE.Vector3();
		this._cam = { fx: 0, fy: 0, fz: -1 };
		this._camPan = { fx: 0, fz: -1, rx: 1, rz: 0 };
		this._ap = { pan: 0, behind: 0 };
		this._lastFog = { color: -1, density: -1 };
		this._lastRes = { w: -1, h: -1 };
		// Les arguments du modèle, écrits une fois par frame plutôt qu'alloués
		// — même idiome que `_spawnArgs` dans AmbientModel.
		this._modelArgs = { dt: 0, player: null, cam: this._cam, fovDeg: 0, rays: null, top: 0, span: 0, wind: null };
		// Le lien est mort : les voix restent muettes jusqu'au prochain
		// reset()/setScan(). `audio.silence()` ne rampe qu'UNE fois, alors que
		// update() revise les gains à chaque frame — l'épave qui roule les
		// rallumerait dès la frame suivante sans ce verrou.
		this._silenced = false;
		this._time = 0;
		this._colors = { frame: hex('--dark-grey'), metal: hex('--grey'), prop: hex('--light-grey'), led: hex('--warm-white') };
	}

	// Le scan {seed,count,index} ou null (pas d'ambiants). Peut être appelé
	// une seule fois par page ; un second appel remplace tout.
	setScan(scan) {
		this._clear();
		if (!scan) return;
		const set = ambientSet(scan);
		// `buildFamily` and not `family`: a swarm unit (issue #29) flies its own
		// routine but borrows an existing airframe's build — it has no PROFILES
		// entry of its own. Its SHAPE is its own; see `shapeFamily` below.
		const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.buildFamily ?? d.family }));
		this.model = new AmbientModel({ set, builds, bounds: this.bounds, seed: scan.seed });
		for (let k = 0; k < set.length; k++) {
			const camera = targetCamera({ seed: set[k].buildSeed, family: set[k].buildFamily ?? set[k].family });
			// La recette : celle de l'exemplaire, sauf pour une machine qui n'a
			// pas d'exemplaire — l'unité d'essaim laissée au ciel (issue #29)
			// vole un airframe emprunté mais elle a sa PROPRE silhouette.
			const shapeProfile = RECIPE_PROFILES[set[k].shapeFamily] ?? builds[k].profile;
			const shape = shapeOf({ profile: shapeProfile, build: builds[k], camera });
			// Sa livrée (issue #284) : à cent mètres c'est sa LED qui change, en
			// free cam ses hélices.
			const m = buildDroneMesh(shape, { colors: { ...this._colors, ...liveryColors(builds[k].livery) } });
			m.group.visible = false;
			// Strobe par drone : phase et rapport tirés de la graine.
			const rand = ((s) => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); })(`${set[k].buildSeed}::led`);
			m.ledMaterial.uniforms.uPhase.value = rand();
			m.ledMaterial.uniforms.uDuty.value = 0.3 + rand() * 0.5;
			// Le fondu de la LED est calé sur la BULLE, pas sur des chiffres à
			// part : pleine jusqu'au rayon de naissance le plus proche
			// (R_SPAWN[0] = 120 m), éteinte à IN_VIEW_MIN_M (220 m). Une
			// naissance DANS le champ n'arrive qu'au-delà de ce dernier et un
			// départ encore plus loin (rLeave ≥ rMax) : ni l'une ni l'autre
			// n'allume donc jamais une lumière sous les yeux du joueur. Un
			// fondu qui finirait à R_LEAVE (320 m) laisserait la LED à 78 %
			// pour une naissance visible à 250 m — le pop qu'on veut tuer.
			setLedFade(m.ledMaterial, R_SPAWN[0], IN_VIEW_MIN_M);
			this.scene.add(m.group);
			this.meshes.push(m);
		}
	}

	_clear() {
		for (const m of this.meshes) m.dispose();
		this.meshes = [];
		this.model = null;
		this._voices[0] = this._voices[1] = this._voices[2] = this._voices[3] = null;
		this.audio.update(this._voices);
		this._silenced = false;
		// Les maillages qui viennent n'ont AUCUN uniforme du monde : on
		// invalide les deux verrous pour que la première frame les écrive.
		this._lastFog.color = -1; this._lastFog.density = -1;
		this._lastRes.w = -1; this._lastRes.h = -1;
	}

	reset() { this.model?.reset(); this._silenced = false; }
	// Verrouille le silence : voir `_silenced` au constructeur.
	silence() { this._silenced = true; this.audio.silence(); }
	setMuted(b) { this.audio.setMuted(b); }

	// Une fois par frame, dt = 0 quand gelé. `player`/`playerVel` : Rapier
	// {x,y,z} ; `camera` : la caméra Three posée ; `wind` : physics.wind.out ;
	// `rays` : physics (groundBelow/obstructionBetween) ; `sun` : SunField|null ;
	// `dim` : le MÊME facteur d'obscurcissement que les tuiles (cloud.dim), pas
	// l'exposition absolue du soleil — voir le commentaire du fragment shader
	// dans drone-mesh.js.
	update({ dt, player, playerVel, camera, wind, rays, top, span, fogColor, fogDensity, sun, dim, resolution }) {
		const m = this.model;
		if (!m) return;
		// Le graphe audio, dès que le contexte existe (geste utilisateur) :
		// deux tests de nullité par frame, aucune allocation.
		if (!this.audio.running) {
			const ctx = audioContext();
			if (ctx) this.audio.start(ctx, engineIn(), space.input);
		}
		const dimV = typeof dim === 'number' ? dim : 1;
		this._camF.set(0, 0, -1).applyQuaternion(camera.quaternion);
		this._camR.set(1, 0, 0).applyQuaternion(camera.quaternion);
		this._cam.fx = this._camF.x; this._cam.fy = this._camF.y; this._cam.fz = this._camF.z;
		// Le pan est RELATIF À L'APPAREIL, délibérément : le joueur entend par
		// sa caméra, qui roule et tangue avec le quad. Les deux bases
		// horizontales se renormalisent — azimuthPan lit un cosinus, il lui
		// faut des vecteurs unitaires, et la projection au sol d'un avant
		// piqué à 45° ne l'est plus (les nadirs feraient dériver le pan).
		const fn = Math.hypot(this._camF.x, this._camF.z) || 1;
		const rn = Math.hypot(this._camR.x, this._camR.z) || 1;
		this._camPan.fx = this._camF.x / fn; this._camPan.fz = this._camF.z / fn;
		this._camPan.rx = this._camR.x / rn; this._camPan.rz = this._camR.z / rn;

		const ma = this._modelArgs;
		ma.dt = dt; ma.player = player; ma.fovDeg = camera.fov;
		ma.rays = rays; ma.top = top; ma.span = span; ma.wind = wind;
		m.update(ma);
		this._time += dt;

		// Brouillard, résolution : écrits sur changement seulement.
		const fogHex = typeof fogColor === 'number' ? fogColor : fogColor.getHex();
		const fogChanged = fogHex !== this._lastFog.color || fogDensity !== this._lastFog.density;
		if (fogChanged) { this._lastFog.color = fogHex; this._lastFog.density = fogDensity; }
		const resChanged = !!resolution && (resolution.w !== this._lastRes.w || resolution.h !== this._lastRes.h);
		if (resChanged) { this._lastRes.w = resolution.w; this._lastRes.h = resolution.h; }

		for (let k = 0; k < this.meshes.length; k++) {
			const mesh = this.meshes[k];
			const alive = m.alive[k] === 1;
			mesh.group.visible = alive;
			// Le brouillard et la résolution s'écrivent sur TOUS les maillages,
			// vivants ou non, et AVANT le tri : ces deux-là sont verrouillés
			// globalement (`_lastFog`/`_lastRes`), donc un drone qui naît après
			// le dernier changement ne les recevrait jamais — il volerait sans
			// perspective aérienne et avec une LED calibrée pour 1920×1080.
			// Quatre écritures d'uniformes au plus, on ne compte pas.
			if (resChanged) setResolution(mesh.ledMaterial, resolution.w, resolution.h);
			if (fogChanged) { setFog(mesh.material, fogHex, fogDensity); setFog(mesh.ledMaterial, fogHex, fogDensity); }
			if (!alive) { this._voices[k] = null; continue; }
			this._p.set(m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]);
			this._q.set(m.quat[4 * k], m.quat[4 * k + 1], m.quat[4 * k + 2], m.quat[4 * k + 3]);
			mesh.group.matrix.compose(this._p, this._q, this._s);
			mesh.group.matrixWorldNeedsUpdate = true;
			setTime(mesh.material, this._time);
			setTime(mesh.ledMaterial, this._time);
			if (sun) setSun(mesh.material, sun.dir, dimV, sun.night);

			// La voix.
			const relX = m.pos[3 * k] - player.x, relY = m.pos[3 * k + 1] - player.y, relZ = m.pos[3 * k + 2] - player.z;
			const d = Math.hypot(relX, relY, relZ) || 1e-6;
			const rvx = m.vel[3 * k] - playerVel.x, rvy = m.vel[3 * k + 1] - playerVel.y, rvz = m.vel[3 * k + 2] - playerVel.z;
			const ap = azimuthPan(relX, relZ, this._camPan, this._ap);
			const v = this._voiceIn[k];
			v.d = d; v.behind = ap.behind; v.pan = ap.pan;
			v.vRadial = (rvx * relX + rvy * relY + rvz * relZ) / d;
			v.accelMag = Math.hypot(m.acc[3 * k], m.acc[3 * k + 1], m.acc[3 * k + 2]);
			v.profile = m.builds[k].profile;
			this._voices[k] = this._silenced ? null : v;
		}
		// À CHAQUE appel, y compris dt = 0 : setMuted(frozen) ne coupe le son
		// que si quelqu'un vise encore les AudioParams (update() ne fait que
		// ça, elle ne touche pas au graphe). Verrouillé après silence() : le
		// lien mort ne se rouvre pas parce que l'épave roule encore.
		//
		// `space.input` est passé À CHAQUE frame (une lecture de propriété, pas
		// d'allocation) : le contexte audio peut naître AVANT l'acoustique du
		// lieu — ensureContext() ouvre le contexte au premier son d'UI, tandis
		// que space.input n'apparaît qu'à EngineAudio.start(). Sans ce rappel,
		// start() branchait sur un spaceInput null et l'envoi était perdu pour
		// la session ; AmbientAudio le branche au premier passage où il existe.
		this.audio.update(this._voices, undefined, space.input);
	}

	debug() {
		const m = this.model;
		if (!m) return { count: 0 };
		const positions = [];
		for (let k = 0; k < m.n; k++) if (m.alive[k]) positions.push([m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]].map((v) => +v.toFixed(1)));
		return { count: m.count, families: m.families, positions, ...m.stats, audioNodes: this.audio.nodesCreated };
	}

	dispose() { this._clear(); this.audio.dispose(); }
}
