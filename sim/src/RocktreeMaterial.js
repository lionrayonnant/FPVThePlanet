import * as THREE from 'three';
import { CYAN, MAGENTA, FENCE_FIELD_GLSL } from './fence-field.js';

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

// Mais la frange doit SUIVRE le rayon (#32) : depuis que le curseur monte à
// 2 km, 50 m de fondu sur un disque de 2 000 font 2,5 % du rayon — invisible,
// et le bord redevient la coupure nette que ce fondu existe pour effacer. Un
// sixième du rayon garde la même proportion à l'œil qu'à 300 m (où il vaut
// 50 m, la valeur d'origine, retrouvée exactement) ; le plafond évite qu'une
// portée extrême ne teinte la moitié du monde.
export const EDGE_FADE_MAX_M = 250;
export function edgeFadeForRadius(loadRadiusM) {
	return Math.min(EDGE_FADE_MAX_M, Math.max(EDGE_FADE_M, loadRadiusM / 6));
}

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
		// Le champ de la clôture (#107), pour que le terrain se dissolve DANS
		// elle et non dans une approximation plate de sa couleur. Poussés une
		// fois par frame par main.js depuis le FenceDome, comme les cinq
		// au-dessus : mêmes objets partagés par référence, aucune liste de
		// matériaux à tenir à jour.
		uCyan: { value: new THREE.Color(CYAN) },
		uMagenta: { value: new THREE.Color(MAGENTA) },
		uFieldTime: { value: 0 },
		uHueBias: { value: 0 },
		uEyeY: { value: 0 },
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
			out float vWorldY;

			void main() {
				${map ? 'vUv = uv;' : ''}
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				// Position au sol en repère MONDE, pas caméra — le fondu de bord
				// doit suivre le vrai bord de la fenêtre, pas d'où on regarde.
				vec4 world = modelMatrix * vec4(position, 1.0);
				vWorldXZ = world.xz;
				// L'altitude sert à retrouver la DIRECTION du fragment depuis le
				// centre de la fenêtre, donc le point du dôme qui lui fait face.
				vWorldY = world.y;
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
			uniform vec3 uCyan, uMagenta;
			uniform float uFieldTime, uHueBias, uEyeY;

			${map ? 'in vec2 vUv;' : ''}
			in float vDepth;
			in vec2 vWorldXZ;
			in float vWorldY;
			out vec4 outColor;

			${FENCE_FIELD_GLSL}

			// La nappe de brume est plus large que la maille du dôme : 0.6 porte
			// la cellule de 50 m à ~83 m, l'échelle à laquelle un banc se lit
			// quand on le traverse du regard plutôt que de face. Plus large
			// encore, on ne lit plus une matière mais un seul dégradé en
			// travers de l'écran.
			const float FOG_FEATURE_SCALE = 0.5;
			const int FOG_OCTAVES = 2;
			// La nappe ne mélange pas les deux couleurs, elle passe de l'une à
			// l'autre AU SEUIL.
			//
			// En RGB, tout mélange intermédiaire entre le cyan et le magenta EST
			// un bleu : le magenta n'a presque pas de vert, le cyan en est plein.
			// Sur la clôture cela ne se voit pas — l'alpha est faible et le
			// terrain transparaît — mais une brume opaque à dominante moyenne
			// vire à la mer turquoise, ce qu'aucun réglage d'écart ne corrige.
			// D'où un seuil : la nappe reste franchement cyan, et seules ses
			// crêtes prennent le magenta, en filaments. C'est aussi ce que
			// l'œil lit sur le dôme, dont les crêtes sont magenta et les creux
			// cyan.
			const float FOG_VEIN_LO = 0.55;
			const float FOG_VEIN_HI = 0.95;
			const float FOG_VEIN_MAX = 0.7;
			// Le relief passe par la LUMINOSITÉ : des bancs plus clairs et plus
			// sombres se lisent comme du volume.
			const float FOG_VALUE_RANGE = 0.22;
			// La masse module la DENSITÉ, donc la distance à laquelle la brume
			// mange le terrain — pas le résultat du brouillard.
			//
			// Moduler le résultat ne pouvait rien faire : passé quelques
			// centaines de mètres le terme de profondeur sature déjà à 1, et
			// mix(1, 1, k) vaut 1 quelle que soit la masse. La brume restait
			// donc un aplat, exactement ce qu'on venait corriger. En amont de
			// l'exponentielle, la même masse creuse de vraies trouées : le
			// terrain reparaît sous les bancs clairs et disparaît sous les
			// denses. Une brume ne se reconnaît pas à sa couleur, elle se
			// reconnaît à ce qu'elle cache inégalement.
			const float FOG_DENS_LO = 0.55;
			const float FOG_DENS_HI = 1.45;

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
				f = clamp(max(f, fEdge), 0.0, 1.0);

				// La couleur dans laquelle le terrain se dissout n'est plus un
				// cyan constant : c'est celle du champ de la clôture (#107), donc
				// la même matière, à la même seconde et à la même dominante que
				// le dôme qui ferme l'horizon.
				//
				// Le champ est échantillonné à la position MONDE du fragment, en
				// nappe horizontale. Pas en projetant le fragment sur le dôme :
				// essayé, et c'est faux — sur une surface horizontale l'élévation
				// est quasi constante près de l'horizon, toute la variation part
				// dans l'azimut, et la nappe redevient un éventail de rayons
				// depuis le point de fuite. Exactement le défaut que #107 est
				// venu supprimer. La brume est un volume posé sur le monde, le
				// dôme est une paroi : ils partagent la matière et la couleur,
				// pas la projection.
				//
				// Le champ coûte ~9 échantillons de bruit et le terrain couvre
				// tout l'écran, d'où la sortie anticipée : près du drone le
				// brouillard est nul et tous les fragments d'un warp prennent la
				// même branche, qui est donc réellement gratuite là où ça compte.
				vec3 fogColor = uFogColor;
				if (f > 0.01) {
					// Échelle élargie : une nappe se regarde en enfilade sur des
					// centaines de mètres, là où la paroi du dôme se regarde de
					// face à quelques dizaines.
					vec2 fm = fenceFieldRawN(vWorldXZ * FOG_FEATURE_SCALE, uFieldTime, 0.0, FOG_OCTAVES);
					// uHueBias décale le SEUIL au lieu de la teinte : près du bord
					// les filaments magenta gagnent du terrain, au centre il n'y
					// en a presque pas — la même information que sur la clôture,
					// portée par la surface de magenta et non par un virage au
					// bleu.
					float vein = smoothstep(FOG_VEIN_LO - uHueBias * 0.38, FOG_VEIN_HI, fm.x);
					fogColor = mix(uCyan, uMagenta, vein * FOG_VEIN_MAX)
						* (1.0 - FOG_VALUE_RANGE * 0.5 + FOG_VALUE_RANGE * fm.y);
					// Seul le terme de PROFONDEUR est modulé. Creuser aussi le
					// fondu de bord rouvrirait la coupure nette que celui-ci
					// existe pour effacer (#202) : au bord réel la brume doit
					// rester saturée, masse ou pas.
					float dens = uFogDensity * (FOG_DENS_LO + (FOG_DENS_HI - FOG_DENS_LO) * fm.y);
					f = max(1.0 - exp(-dens * dens * vDepth * vDepth), fEdge);
				}
				outColor = vec4(mix(c, fogColor, f), 1.0);
			}
		`,
	});
}
