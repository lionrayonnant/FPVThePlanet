// Le drone du joueur (issue #264) — deux exemplaires du MÊME build, et la
// règle qui les sépare : en vue pilote on voit ses hélices (l'exemplaire
// embarqué) ; en vue CHASE on voit la machine entière (l'exemplaire monde).
// Jamais les deux, jamais aucun pendant un vol.
//
// Ce module ne sait rien du contrôleur ni de Rapier : il reçoit une pose et
// quatre régimes, il pose des matrices.
import * as THREE from 'three';
import { shapeOf, eyeOf } from './drone-shape.js';
import { buildDroneMesh, setSun, setFog, setTime, setOmega, setResolution } from './drone-mesh.js';
import { token } from './palette.js';
import { liveryColors } from '../tools/target-livery.mjs';

const hex = (name) => new THREE.Color(token(name)).getHex();

// Un vol sans exemplaire tiré (profil nominal : override `?family=`, NOMINAL au
// banc) n'a pas de build. La recette n'y lit que le nombre de cellules, et le
// profil le porte déjà — on ne fabrique pas un faux tirage pour autant.
const buildFor = (profile, build) => build ?? { spec: { cells: profile.battery.cells } };

const X_AXIS = new THREE.Vector3(1, 0, 0);

export class PlayerDrone {
	constructor({ scene, profile, build, camera }) {
		this.scene = scene;
		// Les gris de base, puis la livrée de l'exemplaire par-dessus (issue
		// #284) — un vol sans build tiré garde les gris.
		this._colors = {
			frame: hex('--dark-grey'), metal: hex('--grey'),
			prop: hex('--light-grey'), led: hex('--warm-white'),
			...liveryColors(build?.livery),
		};
		// Pré-alloués : update() n'alloue rien.
		this._p = new THREE.Vector3();
		this._q = new THREE.Quaternion();
		this._s = new THREE.Vector3(1, 1, 1);
		this._qCam = new THREE.Quaternion();
		this._sunCam = new THREE.Vector3(0, 1, 0);
		this._lastFog = { color: -1, density: -1 };
		this._lastRes = { w: -1, h: -1 };

		const recipe = { profile, build: buildFor(profile, build), camera };
		// L'exemplaire MONDE, posée à la transformation physique. Au niveau
		// `portrait` (issue #283) : la vue CHASE est à 1,6 m, pas à
		// cent — on y voit les pales à l'arrêt, les cloches et les moyeux. La
		// silhouette reste aux ambiants, qui sont les seuls à la mériter de loin.
		this.world = buildDroneMesh(shapeOf({ ...recipe, detail: 'portrait' }), { colors: this._colors });
		this.world.group.visible = false;
		scene.add(this.world.group);

		// L'exemplaire EMBARQUÉ. Il vit dans sa propre scène, avec sa propre
		// caméra : la caméra de vol a near = 0.15 (le rayon du collider, cf.
		// drone-profiles.js) et est posée AU CENTRE du corps — tout le drone est
		// donc dans son near plane, et il n'y a rien à afficher sans ce
		// dispositif.
		//
		// Aucune transformation monde n'entre ici : l'oeil est à l'origine et la
		// machine est posée UNE FOIS à −mount, dé-tiltée de l'uptilt. Les hélices
		// sont rigides à l'objectif, donc leur place à l'image est un fait de
		// construction, pas un calcul par frame. C'est exactement le montage que
		// tools/prop-coverage.mjs rasterise pour tenir la borne DA : l'oeil à la
		// part `camera` de la recette, le champ VERTICAL de la caméra de vol, le
		// format du capteur, l'uptilt en rotation autour de +X.
		// Le niveau `onboard` ne porte QUE les rotors : l'objectif ne filme ni son
		// boîtier ni le pack derrière lui. L'oeil se lit donc sur eyeOf(), la
		// définition du montage, et non sur une part de la recette.
		const shape = shapeOf({ ...recipe, detail: 'onboard' });
		const eye = eyeOf(profile);
		const up = camera.uptiltDeg * Math.PI / 180;
		this.onboardScene = new THREE.Scene();
		// far = 4 m : la machine tient dans 30 cm, et un near de 5 mm n'a de
		// précision de profondeur que si le far reste court.
		this.onboardCamera = new THREE.PerspectiveCamera(camera.fovDeg, camera.aspect, 0.005, 4);
		this.onboard = buildDroneMesh(shape, { colors: this._colors });
		// Le passage repère du corps → repère de l'objectif : l'inverse du
		// montage. D'où le −uptilt, et le −mount tourné avec.
		const tilt = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -up);
		const at = new THREE.Vector3(-eye[0], -eye[1], -eye[2]).applyQuaternion(tilt);
		this.onboard.group.matrix.compose(at, tilt, this._s);
		this.onboard.group.matrixWorldNeedsUpdate = true;
		this.onboard.group.visible = true;
		// La LED de nav est à l'arrière du corps, donc DERRIÈRE l'oeil : elle
		// n'a rien à faire dans cette passe, et c'est un billboard qui n'est
		// jamais culled.
		this.onboard.led.visible = false;
		this.onboardScene.add(this.onboard.group);
		// L'orientation de l'objectif dans le corps, gardée pour ramener le
		// soleil dans le repère embarqué à chaque frame.
		this._tilt = new THREE.Quaternion().setFromAxisAngle(X_AXIS, up);

		this._chase = false;
		this._time = 0;
	}

	// CHASE view (D11) shows the whole machine and drops the onboard pass;
	// FPV is the opposite. The two are exclusive: they are the same drone.
	setChase(on) {
		this._chase = !!on;
		this.world.group.visible = this._chase;
		if (this.onboard) this.onboard.group.visible = !this._chase;
	}

	get worldVisible() { return !!this.world?.group.visible; }
	get onboardVisible() { return !!this.onboard?.group.visible; }

	update({ dt = 0, position, quaternion, omega, camera, sun, dim = 1, fogColor, fogDensity, resolution } = {}) {
		if (!this.world) return;
		this._time += dt;
		if (quaternion) this._q.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);

		// La caméra embarquée suit le champ de la caméra de vol : c'est la même
		// optique, et la borne DA est mesurée sur elle.
		if (camera) {
			this.onboardCamera.fov = camera.fov;
			this.onboardCamera.aspect = camera.aspect;
			this.onboardCamera.updateProjectionMatrix();
		}
		// Le régime des quatre moteurs va aux DEUX exemplaires : c'est lui qui
		// fait tourner les hélices, et le lacet se lit dans les deux hélices du
		// champ parce que les avant sont sur des diagonales opposées.
		if (omega) {
			setOmega(this.onboard.material, omega, dt);
			setOmega(this.world.material, omega, dt);
		}
		setTime(this.onboard.material, this._time);

		if (this.worldVisible && position && quaternion) {
			this._p.set(position.x, position.y, position.z);
			this.world.group.matrix.compose(this._p, this._q, this._s);
			this.world.group.matrixWorldNeedsUpdate = true;
		}
		const fogHex = typeof fogColor === 'number' ? fogColor : fogColor?.getHex?.();
		if (fogHex !== undefined && (fogHex !== this._lastFog.color || fogDensity !== this._lastFog.density)) {
			this._lastFog.color = fogHex; this._lastFog.density = fogDensity;
			setFog(this.world.material, fogHex, fogDensity);
			setFog(this.world.ledMaterial, fogHex, fogDensity);
		}
		if (resolution && (resolution.w !== this._lastRes.w || resolution.h !== this._lastRes.h)) {
			this._lastRes.w = resolution.w; this._lastRes.h = resolution.h;
			setResolution(this.world.ledMaterial, resolution.w, resolution.h);
		}
		setTime(this.world.material, this._time);
		setTime(this.world.ledMaterial, this._time);
		if (sun) {
			setSun(this.world.material, sun.dir, dim, sun.night);
			// Le maillage embarqué est RIGIDE à l'objectif : son modelMatrix
			// n'est pas une transformation monde, et le shader éclaire avec
			// mat3(modelMatrix)·normal. Une direction monde y allumerait donc
			// toujours le même côté des hélices, quoi que fasse la machine. On
			// ramène le soleil dans le repère de l'objectif — l'inverse de
			// (rotation du corps · uptilt).
			this._qCam.copy(this._q).multiply(this._tilt).invert();
			this._sunCam.set(sun.dir.x, sun.dir.y, sun.dir.z).applyQuaternion(this._qCam);
			setSun(this.onboard.material, this._sunCam, dim, sun.night);
		}
	}

	dispose() {
		this.world?.dispose();
		this.onboard?.dispose();
		this.onboardScene?.clear();
		this.world = null; this.onboard = null;
	}
}
