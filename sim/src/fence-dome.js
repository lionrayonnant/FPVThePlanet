// Le dôme numérique du bord de fenêtre live (mode ?live=) : rend visible ce
// que rocktree-fence.js applique déjà en physique (rappel doux au bord du
// rayon de confiance). Même patron que sky.js/SkyDome — une sphère BackSide,
// mise à jour chaque frame — mais un rayon RÉEL et FINI (loadRadiusM() de la
// fenêtre de streaming) centré sur windowCenterLocal, pas collé sur la
// caméra : c'est la vraie limite du terrain chargé, pas un fond infini.
//
// L'opacité grandit doucement du centre de la fenêtre (où tu voles) vers le
// bord réel (là où le rappel doux commence) — courbe extraite en fonction
// pure pour rester testable en Node, comme rangeFor()/intensityForRange()
// de fog.js. Le glitch (bruit superposé au champ) pulse à chaque churn de la
// fenêtre (nœud reçu/libéré) et décroît ensuite ; markChurn() est appelé
// depuis les callbacks onNodeReady/onNodeReleased déjà branchés par main.js —
// ce module n'a besoin d'aucune nouvelle plomberie côté rocktree-window.js
// pour ce signal.
//
// L'apparence elle-même (masse organique cyan/magenta, veines, Fresnel,
// anneau de ping) vient de fence-field.js et est partagée mot pour mot avec
// la muraille de carte pré-cuite — voir #107.

import * as THREE from 'three';
import { fogDensity } from './rain.js';
import {
	CYAN, MAGENTA, FENCE_FIELD_GLSL, FENCE_DISCARD_ALPHA,
	hueBiasFor, PingClock, nearestOnSphereSurface,
} from './fence-field.js';

// Re-exporté depuis fence-field.js, où vivent désormais les deux couleurs de
// la clôture : les importateurs historiques (main.js, geofence-dome.js) n'ont
// rien à changer.
export { CYAN };

// Brouillard local qui épaissit près du VRAI bord (#198, retour "rupture
// nette" après vérification en vol) : le terrain live n'a AUCUN brouillard
// aujourd'hui (météo hors périmètre en ?live=, main.js), donc il s'arrêtait
// net contre le vide au lieu de se dissoudre dans le dôme. main.js pousse
// fogDensityFor() sur scene.fog (THREE.FogExp2, teinté CYAN) — même formule
// exp-carré que le brouillard des tuiles pré-cuites (TileMaterial.js) et
// même fonction fogDensity()/FOG_SHAPE que fog.js, pour rester dans la même
// unité (une visibilité en mètres) que le reste du modèle météo.
//
// Volontairement une courbe DIFFÉRENTE d'opacityFor() : celle-ci reste
// perceptible en continu sur toute la fenêtre par choix (#198), le
// brouillard lui ne doit épaissir que près du bord réel — sinon voler au
// centre d'une grande fenêtre serait perpétuellement embrumé. ratio^4 reste
// plat jusqu'à ~70 % du rayon puis monte vite.
//
// EDGE_VISIBILITY_M : CHOISI — même ordre que le préréglage « purée » de
// fog.js (50 m), assez dense pour dissoudre la coupure plutôt que la laisser
// nette, pas encore mesuré en vol avec cet effet précis.
const EDGE_VISIBILITY_M = 60;

export function fogDensityFor(distanceRatio) {
	const r = Math.min(1, Math.max(0, distanceRatio));
	return fogDensity(EDGE_VISIBILITY_M) * r ** 4;
}

// Opacité de base, du centre de la fenêtre (ratio 0) au bord réel (ratio 1).
// CHOISI, pas mesuré — même statut que RAMP_M/TRUST_MARGIN_M dans ce coin du
// code. Première passe (0.08 -> 0.75) jugée quasi invisible en vol réel (voir
// 5a958e6) ; remontée ensuite à 0.20 -> 0.92 pour compenser un motif qui
// retombait sous le seuil de perception entre deux lignes de scan.
//
// Depuis #107 le champ ne repose plus sur ces lignes et le Fresnel module
// fortement l'alpha selon l'angle de vue : le plancher redescend, parce que
// la clôture est vue EN PERMANENCE et n'a le droit de s'imposer que quand
// elle a quelque chose à dire. Le plafond, lui, reste haut — au bord, elle
// doit être franche.
export const OPACITY_FLOOR = 0.12;
export const OPACITY_CEIL = 0.92;

// Le ratio est clampé : un léger dépassement du rayon (churn en cours, drone
// qui vient de sortir de la fenêtre juste avant recentrage) ne doit pas faire
// exploser l'opacité au-delà du plafond.
export function opacityFor(distanceRatio) {
	const r = Math.min(1, Math.max(0, distanceRatio));
	return OPACITY_FLOOR + (OPACITY_CEIL - OPACITY_FLOOR) * r;
}

// Durée du pulse de glitch après un churn et forme de sa décroissance —
// linéaire, simple : un aller-retour visuel de ~1,2 s reste perceptible sans
// traîner. CHOISI, même statut que ci-dessus.
export const GLITCH_DECAY_S = 1.2;

export function glitchFor(secondsSinceChurn) {
	if (secondsSinceChurn <= 0) return 1;
	if (secondsSinceChurn >= GLITCH_DECAY_S) return 0;
	return 1 - secondsSinceChurn / GLITCH_DECAY_S;
}

export class FenceDome {
	constructor(scene) {
		this.scene = scene;
		// Infinity : aucun churn encore vu, le glitch part éteint (glitchFor
		// applique déjà 0 dès que secondsSinceChurn >= GLITCH_DECAY_S).
		this._secondsSinceChurn = Infinity;
		// Dernier ratio calculé par update() (0 au centre, 1 au bord réel) —
		// exposé via distanceRatio pour que main.js pousse fogDensityFor() sur
		// scene.fog sans recalculer la même géométrie deux fois.
		this._lastRatio = 0;
		this._ping = new PingClock();
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
				uGlitch: { value: 0 },
				uImpact: { value: new THREE.Vector2(0, 0) },
				uImpactAge: { value: 1e4 },
				uRadius: { value: 1 },
			},
			vertexShader: /* glsl */`
				out vec3 vDir;
				out vec3 vView;
				void main() {
					// Sphère unité mise à l'échelle par la matrice modèle (voir
					// update()) : la position locale EST la direction depuis le
					// centre, comme pour SkyDome.
					vDir = position;
					vec4 world = modelMatrix * vec4(position, 1.0);
					vView = cameraPosition - world.xyz;
					gl_Position = projectionMatrix * viewMatrix * world;
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uCyan, uMagenta;
				uniform float uTime, uOpacity, uHueBias, uGlitch, uImpactAge, uRadius;
				uniform vec2 uImpact;
				in vec3 vDir;
				in vec3 vView;
				out vec4 outColor;

				${FENCE_FIELD_GLSL}

				void main() {
					vec3 d = normalize(vDir);
					// Coordonnée de surface en MÈTRES D'ARC, pour que le champ ait
					// la même échelle physique que sur la muraille : azimut le long
					// du bord, élévation en vertical. Même convention que
					// nearestOnSphereSurface(), qui alimente uImpact.
					float azimuth = atan(d.z, d.x);
					if (azimuth < 0.0) azimuth += 6.28318530718;
					float elevation = asin(clamp(d.y, -1.0, 1.0));

					FenceIn f;
					f.surf = vec2(azimuth, elevation) * uRadius;
					// Sur une sphère unité la position EST la normale.
					f.normal = d;
					f.view = vView;
					f.cyan = uCyan;
					f.magenta = uMagenta;
					f.time = uTime;
					f.opacity = uOpacity;
					f.hueBias = uHueBias;
					f.impact = uImpact;
					f.impactAge = uImpactAge;
					// Le dôme est recentré sur l'altitude du drone à chaque frame :
					// la hauteur d'œil est donc l'élévation nulle, par construction.
					f.eyeV = 0.0;
					f.edgeFade = 1.0;       // une sphère n'a pas de bord à cacher
					f.wrap = 6.28318530718 * uRadius;
					// Le churn de la fenêtre de streaming : un scintillement qui
					// traverse la masse quand un nœud arrive ou part. C'est le seul
					// endroit où cette clôture diffère de celle du bord de carte.
					f.extra = uGlitch;
					vec4 c = fenceField(f);
					if (c.a < ${FENCE_DISCARD_ALPHA.toFixed(4)}) discard;
					outColor = c;
				}
			`,
		});

		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
		// depthTest reste actif (contrairement à SkyDome) : ce dôme a un rayon
		// réel et doit s'occulter correctement avec le terrain déjà chargé, pas
		// jouer les fonds infinis.
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		this.mesh.visible = false;   // rien à montrer avant le premier update() avec un rayon réel
		scene.add(this.mesh);
	}

	// Appelé depuis les callbacks onNodeReady/onNodeReleased de main.js (pas
	// depuis rocktree-window.js) : churn = un nœud vient d'arriver ou d'être
	// libéré, quel que soit le moment où processLiveNodeWork() le construit
	// réellement — le signal est « la fenêtre bouge », pas « le mesh existe ».
	markChurn() {
		this._secondsSinceChurn = 0;
	}

	// windowCenterLocal ({x,z}) et loadRadiusM viennent de liveWindow ;
	// dronePosLocal (x,y,z) de physics.position. null/0 (pas encore de
	// fenêtre réelle, ex. tout premier frame du boot) masque le dôme plutôt
	// que de le dessiner à un rayon dégénéré.
	update(dt, { windowCenterLocal, loadRadiusM, dronePosLocal }) {
		this._secondsSinceChurn += dt;
		if (!windowCenterLocal || !(loadRadiusM > 0) || !dronePosLocal) {
			this.mesh.visible = false;
			this._lastRatio = 0;
			return this;
		}
		this.mesh.visible = true;
		// Échelle = rayon réel, centre = fenêtre en X/Z (comme nearestTrustedRadius(),
		// purement horizontal) et altitude du drone en Y — le dôme « flotte »
		// avec le pilote sans recalcul de sol séparé.
		this.mesh.matrix.makeScale(loadRadiusM, loadRadiusM, loadRadiusM);
		this.mesh.matrix.setPosition(windowCenterLocal.x, dronePosLocal.y, windowCenterLocal.z);
		this.mesh.matrixWorld.copy(this.mesh.matrix);

		const distanceRatio = Math.hypot(
			dronePosLocal.x - windowCenterLocal.x,
			dronePosLocal.z - windowCenterLocal.z,
		) / loadRadiusM;
		const ratio = Math.min(1, Math.max(0, distanceRatio));
		this._lastRatio = ratio;
		this.material.uniforms.uOpacity.value = opacityFor(distanceRatio);
		this.material.uniforms.uHueBias.value = hueBiasFor(ratio);
		this.material.uniforms.uGlitch.value = glitchFor(this._secondsSinceChurn);
		this.material.uniforms.uRadius.value = loadRadiusM;
		this.material.uniforms.uTime.value += dt;

		// Le ping part du point du dôme le plus proche du drone — même règle
		// que la muraille : silence tant qu'on vole au centre de la fenêtre.
		this._impactAge += dt;
		if (this._ping.advance(dt, ratio)) {
			// Le centre du dôme est à l'altitude du drone (voir setPosition
			// ci-dessus), donc le centre en Y est dronePosLocal.y.
			const surf = nearestOnSphereSurface(
				dronePosLocal, windowCenterLocal, loadRadiusM, dronePosLocal.y,
			);
			this.material.uniforms.uImpact.value.set(surf.u, surf.v);
			this._impactAge = 0;
		}
		this.material.uniforms.uImpactAge.value = this._impactAge;
		return this;
	}

	// 0 au centre de la fenêtre, 1 au bord réel (clampé) — main.js s'en sert
	// pour fogDensityFor() sans recalculer la même géométrie deux fois.
	get distanceRatio() { return this._lastRatio; }

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
