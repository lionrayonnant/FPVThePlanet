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
// Limite connue, pas résolue ici. À 100 m d'altitude au milieu de la carte,
// le bord est à ~640 m ; à ~2 km de portée le brouillard n'y mange que ~26 %.
// Le plan sera donc franchement visible, et plat. Le pari : il se lit comme
// la plaine derrière la ville, aplatie par la brume — plausible pour Paris,
// et de toute façon strictement mieux que du ciel sous le sol. Si à l'œil il
// se lit comme une nappe morte, la correction la moins chère est un bruit de
// valeur à grande échelle sur sa couleur (uColor) — mais ça se tranche après
// avoir regardé, pas avant ; ce fichier ne le construit pas.

// De combien le sol est plus sombre que l'horizon. Une plaine lointaine n'est
// pas exactement de la couleur de l'air, sinon il n'y a plus de ligne
// d'horizon du tout — et c'est cette ligne qui dit « il y a un sol ». Choisi à
// l'œil, comme les couleurs de sky.js.
const DARKEN = 0.88;
// Le côté du plan, en multiples de la portée du brouillard le plus clair. 4×
// garantit qu'il atteint toujours l'horizon, quelle que soit la météo. Avec la
// portée claire réelle du dépôt (~2 km) et le plancher de 20 km ci-dessous,
// c'est ce plancher qui gouverne en pratique tant qu'aucune scène ne dépasse
// ~5 km de portée claire — mais la formule reste correcte si ça change un jour.
const SPAN = 4;

export class DistantGround {
	constructor(scene, bbox, { fogColor, fogDensity, span = 20000 } = {}) {
		const y = bbox.min[1] - FLOOR_LOST - 0.5;
		const size = Math.max(span * SPAN, 20000);
		const geo = new THREE.PlaneGeometry(size, size);
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
