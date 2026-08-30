import * as THREE from 'three';
import { FLOOR_LOST } from './geofence.js';

// Le sol lointain (#139) : ce qu'on voit au-delà du dernier chunk.
//
// Sans lui, le bord du maillage est une falaise nette avec du CIEL dessous —
// et ce n'est pas un cas limite : en air « clair » la portée météorologique
// est d'environ 2,0 km (rain.js : fogRange(0,00085) ≈ 2 035 m ; la densité de
// base 0,00085 vient de fog.js) pour une bbox de ±642 m sur tour-eiffel. Le
// bord est donc pleinement visible en vol normal.
//
// Ce n'est pas une extension du monde : c'est une plaine, sous la brume. La
// vraie réponse « monde étendu » serait un anneau de tuiles basse résolution,
// et elle touche l'exporteur Go, prep.mjs et la VRAM — une autre issue.
//
// Posé sous le point le plus bas du maillage ET sous le plancher de la
// clôture : rien ne peut z-fighter avec la ville, et on ne peut jamais passer
// dessous.
//
// Limite MESURÉE (gl.readPixels sur le rendu réel, tour-eiffel), pas
// supposée. Depuis le centre de carte, 100 m d'altitude, regard horizontal,
// ville dans le cadre : le sol n'occupe qu'une bande d'environ 6 % de la
// hauteur du cadre entre le bord de la ville et l'horizon, et il n'y
// assombrit le ciel que de 9/255 en moyenne (17/255 au maximum). De nuit,
// l'écart tombe à 3-4,5/255 — sous le grain du capteur de nuit (±10-15/255,
// lens.js) : trois fois plus petit que le bruit qui le recouvre.
//
// Et « ligne d'horizon nette » serait faux par construction, pas seulement
// en pratique : le sol converge vers EXACTEMENT uFogColor à l'horizon (même
// formule que TileMaterial.js, donc même limite), donc le contraste y est
// NUL — aucune ligne ne peut s'y former, à aucune distance. Ce qu'on voit
// est un dégradé doux et continu, vers 50 % du cadre à l'horizontale. Le
// pari tient — ça ne se lit pas comme une nappe morte — mais pour la raison
// inverse de celle qu'on pourrait deviner : pas parce que le dégradé serait
// marqué, mais parce que le contraste ne monte jamais assez haut nulle part
// pour se voir. Tant que ça tient, pas de bruit de valeur construit ici.

// De combien le sol est plus sombre que l'horizon. Une plaine lointaine n'est
// pas exactement de la couleur de l'air, sinon il n'y a plus de ligne
// d'horizon du tout — et c'est cette ligne qui dit « il y a un sol ». Choisi à
// l'œil, comme les couleurs de sky.js.
const DARKEN = 0.88;
// Le côté du plan, en mètres. Ni la météo ni la carte ne le dimensionnent :
// camera.far vaut 2 500 m (main.js) et coupe tout au-delà, donc rien de plus
// lointain ne peut jamais être vu, quelle que soit la portée du brouillard.
// Ce qui compte est de couvrir camera.far depuis n'importe quel point que le
// pilote peut atteindre. La clôture s'arrête à R_HOLD au-delà du bord, pas à
// R_CAUTION : son couloir horizontal est corridor(caution, hold, 0, -hold) et
// `over` se lève à mH < -hold, soit 66 m (geofence.js), pas 113. La séquence
// de fin laisse ensuite dériver l'épave le temps que le noir monte (0,8 s
// dans FENCE_TIMELINE, moins de 25 m à pleine vitesse), et l'image est déjà
// morte à ce moment-là. On garde 113 dans le calcul ci-dessous, non parce
// que c'est le bon seuil, mais parce que c'est le majorant simple : le pire
// cas depuis le centre de la plus grande carte mesurée à ce jour
// (chateau-des-ducs-de-bretagne, demi-côté 1 314 m sur son axe le plus long ;
// vérifié sur les 25 manifestes de public/scenes/, tour-eiffel n'est PAS la
// plus grande) vaut environ 1 314 + 113 + 2 500 ≈ 3 930 m. 20 000 m garde une
// marge de plus de cinq fois ce chiffre, à coût nul :
// PlaneGeometry(size, size) ne fait que 2 triangles, quelle que soit sa
// taille. Le résidu que camera.far laisse passer à la coupe, dans l'air le
// plus clair (donc le plus lent à fondre) : 1 - exp(-(0,00085×2500)²) ≈
// 1,1 %, soit ≈0,34/255 sur l'écart max entre uColor et uFogColor — sous la
// quantification d'un canal 8 bits, donc invisible quelle que soit la météo.
const GROUND_SIZE = 20000;

export class DistantGround {
	constructor(scene, bbox, { fogColor, fogDensity } = {}) {
		const y = bbox.min[1] - FLOOR_LOST - 0.5;
		const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
		geo.rotateX(-Math.PI / 2);

		// Même brouillard exp-carré que TileMaterial.js, et pour la même raison
		// (bug #10 du HANDOFF) : les couleurs sont du sRGB brut, il n'y a rien à
		// convertir. Une matière à part plutôt que createTileMaterial() : il n'y
		// a pas de sampler2DArray ici, pas d'UV, pas de lumières de ville.
		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: {
				uColor: { value: new THREE.Color(fogColor).multiplyScalar(DARKEN) },
				uFogColor: { value: new THREE.Color(fogColor) },
				uFogDensity: { value: fogDensity },
				uDim: { value: 1 },
				uNight: { value: 0 },
			},
			vertexShader: /* glsl */`
				out float vDepth;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					vDepth = -mv.z;
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uColor;
				uniform vec3 uFogColor;
				uniform float uFogDensity;
				uniform float uDim;
				uniform float uNight;
				in float vDepth;
				out vec4 outColor;
				void main() {
					// Pas de lumières de ville ici : c'est la campagne, elle
					// s'éteint la nuit. uNight ne fait que l'assombrir.
					vec3 c = uColor * uDim * (1.0 - 0.75 * uNight);
					// Dupliqué depuis TileMaterial.js, DÉLIBÉRÉMENT (pas de
					// sampler2DArray/UV ici pour justifier une matière commune) —
					// mais les deux formules DOIVENT rester identiques terme à
					// terme, sinon l'horizon se dédouble entre tuiles et sol :
					// c'est toute la prémisse de ce fichier. Si l'une bouge,
					// bouger l'autre avec.
					float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
					outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
				}
			`,
		});

		this.mesh = new THREE.Mesh(geo, this.material);
		this.mesh.position.set(
			(bbox.min[0] + bbox.max[0]) / 2, y, (bbox.min[2] + bbox.max[2]) / 2,
		);
		// PAS -1 comme le dôme du ciel (sky.js) : ce plan teste la profondeur
		// normalement (contrairement au dôme, qui la coupe), donc son ordre
		// face aux tuiles ne change rien au résultat — mais PARTAGER -1 avec
		// le dôme serait dangereux. À renderOrder égal, THREE départage par
		// material.id, l'ordre de CRÉATION des matières — pas un ordre
		// spatial. Si le dôme gagnait ce départage, il peindrait par-dessus
		// le sol sur tout l'écran sans jamais lire le z-buffer (depthTest
		// coupé chez lui) : le sol serait invisible sans qu'aucune erreur ne
		// s'affiche nulle part. -0.5 tranche sans ambiguïté — après le dôme
		// (-1, exclusif à sky.js dans tout le dépôt), avant les tuiles (0 par
		// défaut) — au lieu de compter sur l'ordre de construction.
		this.mesh.renderOrder = -0.5;
		scene.add(this.mesh);
	}

	// La couleur d'air a changé (pluie, brouillard, nuit) : le sol la suit,
	// sinon la ligne d'horizon se dédouble.
	setFog(color, density) {
		if (color !== undefined) {
			this.material.uniforms.uFogColor.value.set(color);
			this.material.uniforms.uColor.value.set(color).multiplyScalar(DARKEN);
		}
		if (density !== undefined) this.material.uniforms.uFogDensity.value = density;
	}

	setNight(night) { this.material.uniforms.uNight.value = night; }
	setDim(dim) { this.material.uniforms.uDim.value = dim; }

	dispose() {
		this.mesh.parent?.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
