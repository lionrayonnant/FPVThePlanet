import * as THREE from 'three';

// Fondu de bord du terrain live (#202, suite de #200 — même retour
// utilisateur, mode ?live= en plus des scènes pré-cuites).
//
// scene.fog (FogExp2 cyan, #198) épaissit déjà l'air quand LE DRONE
// s'approche du bord (fence-dome.js:fogDensityFor(distanceRatio), poussé
// chaque frame par main.js) — mais c'est un scalaire global de profondeur
// CAMÉRA. Monter tout droit au-dessus du centre de la fenêtre laisse
// distanceRatio à 0 (le drone n'a pas bougé horizontalement), donc aucun
// brouillard, alors que le disque chargé se découpe quand même net contre
// le ciel vu de haut — exactement le bug de #139/#200, ici avec un bord
// CIRCULAIRE et mobile (centré sur le drone, rocktree-window.js) plutôt
// qu'une bbox fixe.
//
// Même remède que TileMaterial.js : un terme supplémentaire basé sur la
// position MONDE du FRAGMENT (pas la caméra, pas le drone), combiné par
// max() avec le brouillard de profondeur existant.
export const EDGE_FADE_M = 50;

// Pure, testable sans THREE/WebGL (comme opacityFor()/fogDensityFor() de
// fence-dome.js, wallOpacity() de geofence-dome.js) — DOIT rester en phase
// avec la formule GLSL de createRocktreeMaterial() ci-dessous : même
// smoothstep(0, edgeFadeM, distToEdge) inversé.
export function edgeFadeFor(fragmentXZ, windowCenterXZ, loadRadiusM, edgeFadeM) {
	if (!(loadRadiusM > 0)) return 0;   // fenêtre pas encore posée (tout premier frame)
	const dx = fragmentXZ[0] - windowCenterXZ[0];
	const dz = fragmentXZ[1] - windowCenterXZ[1];
	const distToEdge = loadRadiusM - Math.hypot(dx, dz);
	const t = Math.min(1, Math.max(0, distToEdge / edgeFadeM));
	return 1 - t * t * (3 - 2 * t);
}

// Uniformes PARTAGÉS PAR RÉFÉRENCE entre tous les matériaux de nœuds vivants
// à un instant donné, plutôt qu'une liste de matériaux à itérer chaque frame
// (le patron de loader.js:tileMaterials/setFog(), qui convient à des
// matières pré-cuites vivant toute la session). Ici des dizaines de
// matériaux naissent et meurent à chaque déplacement de fenêtre
// (processLiveNodeWork()) : retenir leur liste à jour serait un point de
// fuite mémoire de plus dans le genre de #147, pour un gain nul — muter ces
// objets une fois par frame (main.js) suffit, Three relit `.value` au
// rendu de CHAQUE matériau qui les référence.
export function createLiveEdgeUniforms(fogColor) {
	return {
		uFogColor: { value: new THREE.Color(fogColor) },
		uFogDensity: { value: 0 },
		uWindowCenter: { value: new THREE.Vector2() },
		uLoadRadiusM: { value: 0 },
		uEdgeFadeM: { value: EDGE_FADE_M },
	};
}

// map XOR color, comme le if/else de buildNodeMesh() (main.js) : un nœud a
// soit une texture réelle (bitmap + uv), soit retombe sur un gris plat.
export function createRocktreeMaterial(edgeUniforms, { map, color } = {}) {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: {
			...(map
				? { uMap: { value: map } }
				: { uColor: { value: new THREE.Color(color ?? 0x808080) } }),
			...edgeUniforms,
		},
		vertexShader: /* glsl */`
			${map ? 'out vec2 vUv;' : ''}
			out float vDepth;
			out vec2 vWorldXZ;

			void main() {
				${map ? 'vUv = uv;' : ''}
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				// Position au sol en repère MONDE, pas caméra — le fondu de bord
				// doit suivre le vrai bord de la fenêtre, pas d'où on regarde.
				vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			${map ? 'uniform sampler2D uMap;' : 'uniform vec3 uColor;'}
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform vec2 uWindowCenter;
			uniform float uLoadRadiusM;
			uniform float uEdgeFadeM;

			${map ? 'in vec2 vUv;' : ''}
			in float vDepth;
			in vec2 vWorldXZ;
			out vec4 outColor;

			void main() {
				vec3 c = ${map ? 'texture(uMap, vUv).rgb' : 'uColor'};
				// Brouillard de profondeur exp-carré : même formule que
				// TileMaterial.js/ground.js (#10) et que THREE.FogExp2 (scene.fog,
				// #198) — dupliquée ici pour pouvoir la COMBINER par max() avec le
				// fondu de bord, ce qu'un scene.fog partagé ne permet pas.
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				// Fondu de bord (#202) : distance de CE fragment au vrai bord de la
				// fenêtre de streaming, pas à la caméra ni au drone — voir
				// edgeFadeFor() ci-dessus pour la même formule testée sans GLSL.
				// Garde explicite sur uLoadRadiusM (fenêtre pas encore posée, tout
				// premier frame) : sans elle distToEdge serait négatif partout et
				// smoothstep saturerait fEdge à 1 PARTOUT, pas 0 — l'inverse de ce
				// qu'on veut avant d'avoir une vraie fenêtre.
				float distToEdge = uLoadRadiusM - distance(vWorldXZ, uWindowCenter);
				float fEdge = uLoadRadiusM > 0.0 ? 1.0 - smoothstep(0.0, uEdgeFadeM, distToEdge) : 0.0;
				f = max(f, fEdge);
				outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
			}
		`,
	});
}
