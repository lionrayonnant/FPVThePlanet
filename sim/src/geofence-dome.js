// La "muraille numérique" du bord de carte pré-cuite (#199), suivi de #198
// (fence-dome.js). Même idée — rendre visible la limite que geofence.js
// applique déjà en physique (rappel doux, horizontalMargin()) — mais une
// géométrie DIFFÉRENTE : geofence.js retient une bbox RECTANGULAIRE fixe, pas
// un cercle autour d'un centre mobile comme rocktree-window.js — une sphère
// collerait mal près des coins. Et pas de glitch de churn : en mode scène
// pré-cuite tout est déjà chargé, aucun signal "nœud reçu/libéré" à
// représenter.
//
// opacityFor()/CYAN sont réimportées de fence-dome.js plutôt que redéfinies :
// même courbe d'opacité, même couleur, un seul endroit à retoucher si l'une
// des deux passes de vérification en vol demande encore un réglage. Le champ
// lui-même (bichromie, masse, scan, Fresnel, ping) vient de fence-field.js et
// est partagé mot pour mot avec le dôme live — voir #107.

import * as THREE from 'three';
import { opacityFor, CYAN } from './fence-dome.js';
import { horizontalMargin } from './geofence.js';
import {
	MAGENTA, FENCE_FIELD_GLSL, FENCE_DISCARD_ALPHA,
	hueBiasFor, PingClock, nearestOnBoxSurface,
} from './fence-field.js';

// Hauteur du mur, en mètres. Une vraie hauteur de plafond n'a aucun sens ici
// (la clôture verticale de geofence.js est un couloir de quelques mètres
// sous le sol, un sujet totalement différent, voir horizontalMargin() vs
// verticalMargin()) — juste assez haut pour qu'aucun angle de vue plausible
// ne voie le bord du mur, en haut comme en bas.
const WALL_HEIGHT_M = 4000;

// Ratio de proximité au bord, dans [0,1] : 0 au centre (halfMin de marge
// restante ou plus), 1 au bord réel ou au-delà (margin clampée à 0). Pure —
// testable sans THREE, comme opacityFor()/glitchFor() de fence-dome.js.
export function wallRatio(dronePosLocal, bbox, halfMin) {
	const margin = Math.max(0, horizontalMargin(dronePosLocal, bbox));
	const ratio = halfMin > 0 ? 1 - margin / halfMin : 1;
	return Math.min(1, Math.max(0, ratio));
}

export function wallOpacity(dronePosLocal, bbox, halfMin) {
	return opacityFor(wallRatio(dronePosLocal, bbox, halfMin));
}

// Les quatre faces latérales, dans l'ordre où nearestOnBoxSurface() parcourt
// le périmètre : nord (z=min) → est → sud → ouest, en partant du coin
// (minX, minZ). Pure et sans THREE : c'est la correspondance entre géométrie
// et coordonnée de surface, et c'est elle qui doit être juste pour que
// l'anneau de ping passe les coins sans se casser en deux.
//
// Les faces haut/bas d'une boîte n'y sont pas : vues de l'intérieur d'un mur
// de 4000 m recentré sur le drone, elles ne sont jamais dans le champ, et les
// garder coûtait du fill rate pour rien. C'est pourquoi la géométrie est
// construite ici plutôt que prise à BoxGeometry.
export function wallFaceLayout(width, depth) {
	const hw = width / 2, hd = depth / 2;
	return [
		{ start: [-hw, -hd], along: [width, 0], uStart: 0, uLength: width },
		{ start: [hw, -hd], along: [0, depth], uStart: width, uLength: depth },
		{ start: [hw, hd], along: [-width, 0], uStart: width + depth, uLength: width },
		{ start: [-hw, hd], along: [0, -depth], uStart: 2 * width + depth, uLength: depth },
	];
}

// Un prisme ouvert : 4 quads, l'attribut aSurfU portant la coordonnée de
// périmètre par sommet. Y local dans [-0.5, 0.5], mis à l'échelle par la
// matrice modèle comme avant.
//
// Ordre des sommets (start, start+up, start+up+along, start+along) : pour les
// quatre faces, cross(up, along) donne la normale EXTÉRIEURE — même
// convention que BoxGeometry, donc side: BackSide continue de marcher tel
// quel.
function buildWallGeometry(width, depth) {
	const positions = [], normals = [], surfU = [], indices = [];
	for (const face of wallFaceLayout(width, depth)) {
		const [sx, sz] = face.start;
		const [ax, az] = face.along;
		// cross((0,1,0), (ax,0,az)) = (az, 0, -ax).
		const nl = Math.hypot(az, ax) || 1;
		const nx = az / nl, nz = -ax / nl;
		const base = positions.length / 3;
		const corners = [
			[sx, -0.5, sz, face.uStart],
			[sx, 0.5, sz, face.uStart],
			[sx + ax, 0.5, sz + az, face.uStart + face.uLength],
			[sx + ax, -0.5, sz + az, face.uStart + face.uLength],
		];
		for (const [x, y, z, u] of corners) {
			positions.push(x, y, z);
			normals.push(nx, 0, nz);
			surfU.push(u);
		}
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
	geometry.setAttribute('aSurfU', new THREE.Float32BufferAttribute(surfU, 1));
	geometry.setIndex(indices);
	return geometry;
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
		this._ping = new PingClock();
		// Assez vieux pour que l'anneau soit éteint : rien ne part avant le
		// premier passage en zone active.
		this._impactAge = 1e4;

		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			side: THREE.BackSide,
			transparent: true,
			depthWrite: false,
			fog: false,
			uniforms: {
				uCyan: { value: new THREE.Color(CYAN) },
				uMagenta: { value: new THREE.Color(MAGENTA) },
				uTime: { value: 0 },
				uOpacity: { value: 0 },
				uHueBias: { value: 0 },
				uImpact: { value: new THREE.Vector2(0, 0) },
				uImpactAge: { value: 1e4 },
				uEyeV: { value: 0 },
				uWrap: { value: 2 * (width + depth) },
			},
			vertexShader: /* glsl */`
				in float aSurfU;
				out vec2 vSurf;
				out vec3 vNormal;
				out vec3 vView;
				out float vEdge;
				void main() {
					vec4 world = modelMatrix * vec4(position, 1.0);
					// u vient de la géométrie (continu d'une face à l'autre), v est
					// l'altitude MONDE : le motif ne glisse donc pas verticalement
					// quand le mur se recentre sur le drone à chaque frame.
					vSurf = vec2(aSurfU, world.y);
					// Position locale SIGNÉE, dans [-0.5, 0.5]. Surtout pas son
					// abs() : les deux sommets d'une arête verticale valent -0.5 et
					// +0.5, dont les valeurs absolues valent toutes deux 1 — la
					// varying serait constante et le mur entier s'éteindrait. Le
					// repli se fait au fragment, où le milieu existe vraiment.
					vEdge = position.y * 2.0;
					vNormal = normalize(mat3(modelMatrix) * normal);
					vView = cameraPosition - world.xyz;
					gl_Position = projectionMatrix * viewMatrix * world;
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uCyan, uMagenta;
				uniform float uTime, uOpacity, uHueBias, uImpactAge, uWrap;
				uniform vec2 uImpact;
				uniform float uEyeV;
				in vec2 vSurf;
				in vec3 vNormal;
				in vec3 vView;
				in float vEdge;
				out vec4 outColor;

				${FENCE_FIELD_GLSL}

				void main() {
					FenceIn f;
					f.surf = vSurf;
					f.normal = vNormal;
					f.view = vView;
					f.cyan = uCyan;
					f.magenta = uMagenta;
					f.time = uTime;
					f.opacity = uOpacity;
					f.hueBias = uHueBias;
					f.impact = uImpact;
					f.impactAge = uImpactAge;
					f.eyeV = uEyeV;         // altitude monde du drone
					f.edgeFade = 1.0 - smoothstep(0.55, 0.98, abs(vEdge));
					f.wrap = uWrap;
					f.extra = 0.0;          // pas de churn sur une scène pré-cuite
					vec4 c = fenceField(f);
					if (c.a < ${FENCE_DISCARD_ALPHA.toFixed(4)}) discard;
					outColor = c;
				}
			`,
		});

		// Largeur/profondeur figées dans la géométrie (la bbox ne bouge jamais
		// en vol) : seule la hauteur passe par la matrice modèle, mise à
		// l'échelle une fois pour toutes dans update().
		this.mesh = new THREE.Mesh(buildWallGeometry(width, depth), this.material);
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

		this.material.uniforms.uEyeV.value = dronePosLocal.y;

		const ratio = wallRatio(dronePosLocal, this.bbox, this._halfMin);
		this.material.uniforms.uOpacity.value = opacityFor(ratio);
		this.material.uniforms.uHueBias.value = hueBiasFor(ratio);
		this.material.uniforms.uTime.value += dt;

		// Le ping part du point du mur le plus proche du drone. Rien ne part
		// tant qu'on vole au centre : la clôture n'a alors rien à dire.
		this._impactAge += dt;
		if (this._ping.advance(dt, ratio)) {
			const surf = nearestOnBoxSurface(dronePosLocal, this.bbox);
			this.material.uniforms.uImpact.value.set(surf.u, surf.v);
			this._impactAge = 0;
		}
		this.material.uniforms.uImpactAge.value = this._impactAge;
		return this;
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
