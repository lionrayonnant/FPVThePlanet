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
// de fog.js. Le glitch (bruit superposé aux lignes de scan) pulse à chaque
// churn de la fenêtre (nœud reçu/libéré) et décroît ensuite ; markChurn()
// est appelé depuis les callbacks onNodeReady/onNodeReleased déjà branchés
// par main.js — ce module n'a besoin d'aucune nouvelle plomberie côté
// rocktree-window.js pour ce signal.

import * as THREE from 'three';
import { fogDensity } from './rain.js';

export const CYAN = 0x4dd8e8;

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
// 5a958e6) : le pattern du fragment shader multiplie encore ce nombre par
// 0.25-1.0 selon les lignes de scan (voir plus bas), donc un plancher de 0.08
// finissait sous les 0.02 d'alpha réel entre deux lignes — sous le seuil de
// perception face à un terrain photo. Remonté ici (0.20 -> 0.92) ; à retoucher
// encore si ce n'est toujours pas assez au prochain retour en vol.
export const OPACITY_FLOOR = 0.20;
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
				uGlitch: { value: 0 },
			},
			vertexShader: /* glsl */`
				out vec3 vDir;
				void main() {
					// Sphère unité mise à l'échelle par la matrice modèle (voir
					// update()) : la position locale EST la direction depuis le
					// centre, comme pour SkyDome.
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uColor;
				uniform float uTime, uOpacity, uGlitch;
				in vec3 vDir;
				out vec4 outColor;

				float hash21(vec2 p) {
					p = fract(p * vec2(123.34, 456.21));
					p += dot(p, p + 45.32);
					return fract(p.x * p.y);
				}

				void main() {
					vec3 d = normalize(vDir);
					// Élévation locale sur la sphère (radians) : axe des lignes de
					// scan horizontales, qui balaient dans le temps.
					float elevation = asin(clamp(d.y, -1.0, 1.0));
					float scan = 0.5 + 0.5 * sin(elevation * 40.0 - uTime * 1.5);
					// Bandes plus larges (pow 3 au lieu de 8, #198 v1 quasi
					// invisible en vol réel) : la ligne doit rester lisible
					// entre deux passages, pas juste un pixel de large.
					scan = pow(scan, 3.0);

					// Bruit/glitch : hash sur la direction ET un temps quantifié en
					// blocs — un scintillement numérique, pas un fondu doux.
					float t = floor(uTime * 12.0);
					float glitch = hash21(d.xz * 37.0 + t) * uGlitch;

					float pattern = clamp(scan * 0.6 + glitch * 0.8, 0.0, 1.0);
					// Plancher de motif remonté (0.45 au lieu de 0.25, même
					// raison que OPACITY_FLOOR/CEIL plus haut) : la brume cyan
					// entre les lignes de scan doit se voir, pas seulement les
					// lignes elles-mêmes.
					outColor = vec4(uColor, uOpacity * (0.45 + 0.55 * pattern));
				}
			`,
		});

		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
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
		this._lastRatio = Math.min(1, Math.max(0, distanceRatio));
		this.material.uniforms.uOpacity.value = opacityFor(distanceRatio);
		this.material.uniforms.uGlitch.value = glitchFor(this._secondsSinceChurn);
		this.material.uniforms.uTime.value += dt;
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
