// La "muraille numérique" du bord de carte pré-cuite (#199), suivi de #198
// (fence-dome.js). Même idée — rendre visible la limite que geofence.js
// applique déjà en physique (rappel doux, horizontalMargin()) — mais une
// géométrie DIFFÉRENTE : geofence.js retient une bbox RECTANGULAIRE fixe, pas
// un cercle autour d'un centre mobile comme rocktree-window.js — une sphère
// collerait mal près des coins. Et pas de glitch de churn : en mode scène
// pré-cuite tout est déjà chargé, aucun signal "nœud reçu/libéré" à
// représenter — juste les lignes de scan qui balaient.
//
// opacityFor()/CYAN sont réimportées de fence-dome.js plutôt que redéfinies :
// même courbe d'opacité, même couleur, un seul endroit à retoucher si l'une
// des deux passes de vérification en vol demande encore un réglage.

import * as THREE from 'three';
import { opacityFor, CYAN } from './fence-dome.js';
import { horizontalMargin } from './geofence.js';

// Hauteur du mur, en mètres. Une vraie hauteur de plafond n'a aucun sens ici
// (la clôture verticale de geofence.js est un couloir de quelques mètres
// sous le sol, un sujet totalement différent, voir horizontalMargin() vs
// verticalMargin()) — juste assez haut pour qu'aucun angle de vue plausible
// ne voie le bord du mur, en haut comme en bas.
const WALL_HEIGHT_M = 4000;

// Ratio de proximité au bord, dans [0,1] : 0 au centre (halfMin de marge
// restante ou plus), 1 au bord réel ou au-delà (margin clampée à 0). Pure —
// testable sans THREE, comme opacityFor()/glitchFor() de fence-dome.js.
export function wallOpacity(dronePosLocal, bbox, halfMin) {
	const margin = Math.max(0, horizontalMargin(dronePosLocal, bbox));
	const ratio = halfMin > 0 ? 1 - margin / halfMin : 1;
	return opacityFor(ratio);
}

export class GeofenceWall {
	// bbox : {min:[x,y,z], max:[x,y,z]}, la même que celle passée à Geofence —
	// PAS celle démesurée du mode bench/live (voir main.js, qui ne construit
	// ce mur que pour une vraie bbox de carte).
	constructor(scene, bbox) {
		this.scene = scene;
		this.bbox = bbox;
		const width = bbox.max[0] - bbox.min[0];
		const depth = bbox.max[2] - bbox.min[2];
		this._centerX = (bbox.min[0] + bbox.max[0]) / 2;
		this._centerZ = (bbox.min[2] + bbox.max[2]) / 2;
		// Le plus petit demi-côté : même référence que Geofence.effectiveCorridor
		// (halfMinM) pour mettre l'opacité à l'échelle d'une petite carte comme
		// d'une grande, cohérent avec le couloir physique déjà mis à l'échelle
		// pareil.
		this._halfMin = Math.min(width, depth) / 2;

		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			side: THREE.BackSide,
			transparent: true,
			depthWrite: false,
			fog: false,
			uniforms: {
				uColor: { value: new THREE.Color(CYAN) },
				uTime: { value: 0 },
				uOpacity: { value: 0 },
			},
			vertexShader: /* glsl */`
				out vec3 vLocal;
				void main() {
					// Position locale AVANT mise à l'échelle par la matrice modèle
					// (voir update()) : sert d'axe vertical au motif de scan, une
					// boîte n'a pas d'élévation sphérique à en tirer comme
					// fence-dome.js.
					vLocal = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uColor;
				uniform float uTime, uOpacity;
				in vec3 vLocal;
				out vec4 outColor;

				void main() {
					// Même motif que fence-dome.js (lignes de scan horizontales qui
					// balaient), sur vLocal.y plutôt que sur une élévation
					// sphérique — la géométrie du mur n'en a pas.
					float scan = 0.5 + 0.5 * sin(vLocal.y * 60.0 - uTime * 1.5);
					scan = pow(scan, 3.0);
					outColor = vec4(uColor, uOpacity * (0.45 + 0.55 * scan));
				}
			`,
		});

		// Largeur/profondeur figées dans la géométrie (la bbox ne bouge jamais
		// en vol) : seule la hauteur passe par la matrice modèle, mise à
		// l'échelle une fois pour toutes dans update().
		this.mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 1, depth), this.material);
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		scene.add(this.mesh);
	}

	// dronePosLocal : physics.position (mètres ENU locaux), même repère que
	// bbox (Geofence.update() lit p dans ce même repère).
	update(dt, dronePosLocal) {
		// Centre X/Z fixe (bbox immuable), hauteur fixe, seul le Y suit le
		// drone — comme FenceDome, une hauteur de mur "physique" n'aurait pas
		// de sens.
		this.mesh.matrix.makeScale(1, WALL_HEIGHT_M, 1);
		this.mesh.matrix.setPosition(this._centerX, dronePosLocal.y, this._centerZ);
		this.mesh.matrixWorld.copy(this.mesh.matrix);

		this.material.uniforms.uOpacity.value = wallOpacity(dronePosLocal, this.bbox, this._halfMin);
		this.material.uniforms.uTime.value += dt;
		return this;
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
