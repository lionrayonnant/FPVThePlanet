// Le drone du joueur (issue #264) — deux exemplaires du MÊME build, et la
// règle qui les sépare : en vue pilote on voit ses hélices (l'exemplaire
// embarqué, tâche 7) ; en free cam on voit la machine entière (l'exemplaire
// monde). Jamais les deux, jamais aucun pendant un vol.
//
// Ce module ne sait rien du contrôleur ni de Rapier : il reçoit une pose et
// quatre régimes, il pose des matrices.
import * as THREE from 'three';
import { shapeOf } from './drone-shape.js';
import { buildDroneMesh, setSun, setFog, setTime, setResolution } from './drone-mesh.js';
import { token } from './palette.js';

const hex = (name) => new THREE.Color(token(name)).getHex();

// Un vol sans exemplaire tiré (profil nominal : override `?family=`, NOMINAL au
// banc) n'a pas de build. La recette n'y lit que le nombre de cellules, et le
// profil le porte déjà — on ne fabrique pas un faux tirage pour autant.
const buildFor = (profile, build) => build ?? { spec: { cells: profile.battery.cells } };

export class PlayerDrone {
	constructor({ scene, profile, build, camera }) {
		this.scene = scene;
		this._colors = {
			frame: hex('--dark-grey'), metal: hex('--grey'),
			prop: hex('--light-grey'), led: hex('--warm-white'),
		};
		// L'exemplaire MONDE : la recette telle qu'elle est aujourd'hui
		// (`silhouette` par défaut), posée à la transformation physique.
		this.world = buildDroneMesh(shapeOf({ profile, build: buildFor(profile, build), camera }), { colors: this._colors });
		this.world.group.visible = false;
		scene.add(this.world.group);
		this.onboard = null;   // tâche 7
		this._freeCam = false;
		this._time = 0;
		// Pré-alloués : update() n'alloue rien.
		this._p = new THREE.Vector3();
		this._q = new THREE.Quaternion();
		this._s = new THREE.Vector3(1, 1, 1);
		this._lastFog = { color: -1, density: -1 };
		this._lastRes = { w: -1, h: -1 };
	}

	setFreeCam(on) {
		this._freeCam = !!on;
		this.world.group.visible = this._freeCam;
		if (this.onboard) this.onboard.group.visible = !this._freeCam;
	}

	get worldVisible() { return !!this.world?.group.visible; }
	get onboardVisible() { return !!this.onboard?.group.visible; }

	update({ dt = 0, position, quaternion, omega, sun, dim = 1, fogColor, fogDensity, resolution } = {}) {
		if (!this.world) return;
		this._time += dt;
		if (this.worldVisible && position && quaternion) {
			this._p.set(position.x, position.y, position.z);
			this._q.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
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
		if (sun) setSun(this.world.material, sun.dir, dim, sun.night);
		void omega;   // tâche 6
	}

	dispose() {
		this.world?.dispose();
		this.onboard?.dispose();
		this.world = null; this.onboard = null;
	}
}
