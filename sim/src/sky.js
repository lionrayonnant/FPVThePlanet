// Le ciel : ce qu'on voit quand on lève les yeux, et la couleur que l'air a
// prise. Le pendant rendu de cloud.js, comme rainfall.js l'est de rain.js.
//
// C'est un dôme, pas un fond : une sphère BackSide de rayon 1 recollée sur la
// caméra à chaque frame, avec depthTest coupé. Rayon 1 et depth coupé rendent
// near et far hors sujet — rien ne peut clipper, et le dôme ne consomme pas de
// budget de profondeur.
//
// scene.background lui survit et change de sens : il porte désormais la couleur
// d'HORIZON du dôme. Le dôme couvre l'écran, donc ce fond n'est jamais vu — mais
// rainfall.js, lens.js et le HUD le lisent, et c'est aussi ce que setFog()
// pousse sur les tuiles. Une seule couleur d'air pour tout le monde, donc la
// ligne d'horizon ne se dédouble pas.

import * as THREE from 'three';

// ColorManagement est coupé et le rendu est en NoToneMapping (HANDOFF bug #10) :
// ces valeurs sont du sRGB, elles sortent telles quelles, il n'y a rien à
// convertir. Ne pas les passer par convertSRGBToLinear().
//
// CLEAR_HORIZON est exactement le SKY historique de main.js : c'est l'invariant
// que D5 protège, parce que c'est cette couleur-là que les tuiles lointaines
// rejoignent en se fondant.
export const CLEAR_HORIZON = 0x9fb8cc;
// Un ciel clair est plus profond au zénith qu'à l'horizon — c'est de la
// diffusion de Rayleigh sur une épaisseur d'air plus courte, pas un choix
// graphique. L'écart est délibérément modeste : la photogrammétrie d'Apple est
// cuite sous un ciel laiteux, et un zénith trop saturé ne lui ressemblerait plus.
export const CLEAR_ZENITH = 0x6d93bd;
// Un couvercle de stratus est presque plat et franchement plus terne. Il garde
// une trace de dégradé — le sol renvoie de la lumière sous la couche, donc le
// bas est toujours un peu plus clair.
export const OVERCAST_ZENITH = 0x8a8f94;
export const OVERCAST_HORIZON = 0xa8adb1;

// La pluie et le brouillard, déménagés depuis main.js : ils décalent la couleur
// de l'air, et l'air est ce que ce fichier peint. Les garder dans main.js
// laissait les tuiles se fondre vers une couleur que le dôme ne montrait pas.
const RAIN_SKY = 0x8d99a2;
const FOG_SKY = 0xc9d0d4;

// Les nuages eux-mêmes. Pas d'éclairage : la corrélation entre densité et
// luminosité suffit à les lire comme volumiques, et c'est tout ce qu'on peut
// faire sans normale.
const CLOUD_LIT = 0xf2f4f6;
const CLOUD_DARK = 0x9aa1a8;

// Taille des motifs, en mètres. Un cumulus fait quelques centaines de mètres ;
// c'est la première octave qui porte cette échelle, les suivantes la détaillent.
const FEATURE_SCALE = 420;

export class SkyDome {
	constructor(scene, { sky = CLEAR_HORIZON } = {}) {
		this._horizon = new THREE.Color(sky);
		this._zenith = new THREE.Color(CLEAR_ZENITH);
		this._drift = new THREE.Vector2(0, 0);
		this._windDir = 0;
		this._windSpeed = 0;

		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			side: THREE.BackSide,
			depthTest: false,
			depthWrite: false,
			fog: false,
			uniforms: {
				uZenith: { value: this._zenith },
				uHorizon: { value: this._horizon },
				uCloudLit: { value: new THREE.Color(CLOUD_LIT) },
				uCloudDark: { value: new THREE.Color(CLOUD_DARK) },
				uCover: { value: 0 },
				uHeight: { value: 1e6 },     // mètres de la caméra à la base, signé
				uCamXZ: { value: new THREE.Vector2(0, 0) },
				uDrift: { value: this._drift },
				uScale: { value: 1 / FEATURE_SCALE },
			},
			vertexShader: /* glsl */`
				out vec3 vDir;
				void main() {
					// Sphère unité recollée sur la caméra sans rotation propre :
					// la position d'un sommet EST la direction de vue.
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uZenith, uHorizon, uCloudLit, uCloudDark;
				uniform float uCover, uHeight, uScale;
				uniform vec2 uCamXZ, uDrift;

				in vec3 vDir;
				out vec4 outColor;

				float hash21(vec2 p) {
					p = fract(p * vec2(123.34, 456.21));
					p += dot(p, p + 45.32);
					return fract(p.x * p.y);
				}

				float vnoise(vec2 p) {
					vec2 i = floor(p), f = fract(p);
					vec2 u = f * f * (3.0 - 2.0 * f);
					float a = hash21(i);
					float b = hash21(i + vec2(1.0, 0.0));
					float c = hash21(i + vec2(0.0, 1.0));
					float d = hash21(i + vec2(1.0, 1.0));
					return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
				}

				// Somme des amplitudes 0.5 + 0.25 + ... sur cinq octaves.
				// Diviser par elle ramène le FBM dans [0, 1], donc le seuil de
				// couverture plus bas peut être exact plutôt qu'approché.
				const float FBM_NORM = 0.96875;

				float fbm(vec2 p) {
					float v = 0.0, a = 0.5;
					for (int i = 0; i < 5; i++) {
						// Chaque octave dérive un peu plus que la précédente, donc
						// la couche se DÉFORME au lieu de glisser comme une plaque
						// rigide. C'est le seul endroit où les nuages vivent.
						v += a * vnoise(p + uDrift * uScale * (1.0 + float(i) * 0.35));
						// 2.03 et pas 2.0 : un doublement exact réaligne les octaves
						// sur le même réseau et imprime une grille visible.
						p = p * 2.03 + 17.1;
						a *= 0.5;
					}
					return v / FBM_NORM;
				}

				void main() {
					vec3 d = normalize(vDir);
					vec3 col = mix(uHorizon, uZenith, sqrt(clamp(d.y, 0.0, 1.0)));

					// De quel côté est la couche. uHeight est signé : positif tant
					// qu'elle est au-dessus, négatif une fois qu'on l'a percée — et
					// alors on la regarde vers le BAS. Ça coûte un signe, et c'est
					// la récompense d'un plafond traversable.
					float dy = (uHeight >= 0.0) ? d.y : -d.y;

					// Sous l'horizon du bon côté, il n'y a rien à dessiner : les
					// tuiles couvrent cette zone de toute façon.
					if (dy > 0.001) {
						// Intersection du rayon de vue avec le plan horizontal de
						// la base. C'est ça qui fait converger les nuages à
						// l'horizon sans qu'on ait à le programmer.
						vec2 p = uCamXZ + d.xz * (abs(uHeight) / dy);

						// Le seuil de couverture. Les bornes sont choisies pour que
						// les deux extrémités soient EXACTES : à uCover = 0 le bord
						// est à 1.18 et aucune valeur du FBM ne peut le franchir
						// (D5, ciel clair = rien du tout) ; à uCover = 1 il est à
						// -0.18 et tout le franchit.
						float w = 0.18;
						float edge = mix(1.0 + w, -w, uCover);
						float density = smoothstep(edge - w, edge + w, fbm(p * uScale));

						// Quand dy tend vers 0 le point d'échantillonnage part à
						// l'infini. On fond sur les derniers degrés — ce qui est
						// aussi ce que fait l'atmosphère, les nuages se compriment
						// en bande à l'horizon. La dégénérescence numérique et le
						// rendu juste sont le même geste.
						density *= smoothstep(0.0, 0.14, dy);

						// Pas d'éclairage, pas de normale : les paquets épais sont
						// plus sombres, et cette seule corrélation suffit à les
						// lire comme volumiques.
						col = mix(col, mix(uCloudLit, uCloudDark, density), density);
					}

					outColor = vec4(col, 1.0);
				}
			`,
		});

		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
		// Il passe avant tout le reste et ne teste pas la profondeur : il est le
		// fond. frustumCulled coupé parce que sa bounding sphere est calculée à
		// l'origine, pas là où on le déplace chaque frame.
		this.mesh.renderOrder = -1;
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		scene.add(this.mesh);
		this.scene = scene;
	}

	// La couleur de l'air, mutée et jamais remplacée : main.js pose cet objet
	// dans scene.background et lens.js en garde la référence (même contrainte
	// que le commentaire de main.js sur scene.background.set()).
	get horizon() { return this._horizon; }

	// Tout ce que le dôme a besoin de savoir du monde, en un appel. Rien n'est
	// remodélisé ici : cover et base viennent de CloudField, le vent de
	// physics.wind, rainScale et fogMix des modèles existants.
	setState({ cover = 0, base = 0, altitudeAGL = 0, windDir = 0, windSpeed = 0,
		rainScale = 1, fogMix = 0 } = {}) {
		this._windDir = windDir;
		this._windSpeed = windSpeed;
		this.material.uniforms.uCover.value = cover;
		// Signé : positif quand la couche est au-dessus de nous, négatif quand
		// on l'a percée. Le shader s'en sert pour savoir de quel côté regarder.
		this.material.uniforms.uHeight.value = base - altitudeAGL;
		this._applyColours(cover, rainScale, fogMix);
		return this;
	}

	// La couleur de l'air, en un seul endroit : la couverture pose le socle,
	// puis la pluie, puis le brouillard — dans cet ordre, celui de l'ancien
	// weatherSky(). Le zénith et l'horizon subissent le MÊME traitement, sinon
	// une averse creuserait un dégradé qui n'existe pas sous la pluie.
	_applyColours(cover, rainScale, fogMix) {
		const wet = Math.min(1, (rainScale - 1) * 1.2);
		this._zenith.setHex(CLEAR_ZENITH).lerp(_tmp.setHex(OVERCAST_ZENITH), cover)
			.lerp(_tmp.setHex(RAIN_SKY), wet).lerp(_tmp.setHex(FOG_SKY), fogMix);
		this._horizon.setHex(CLEAR_HORIZON).lerp(_tmp.setHex(OVERCAST_HORIZON), cover)
			.lerp(_tmp.setHex(RAIN_SKY), wet).lerp(_tmp.setHex(FOG_SKY), fogMix);
	}

	update(camera, dt) {
		// Le dôme suit la caméra en translation seulement : il ne tourne jamais,
		// donc les directions de vue restent des directions monde.
		this.mesh.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z);
		this.mesh.matrixWorld.copy(this.mesh.matrix);
		this.material.uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
		// La dérive, en mètres parcourus. Convention d'axes de wind.js : un vent
		// de secteur `dir` SOUFFLE vers (-sin, cos) — voir la note d'axes de
		// wind.js, et le check « un vent de nord souffle vers le sud » de
		// selftest.mjs qui la verrouille.
		const a = (this._windDir * Math.PI) / 180;
		this._drift.x += -Math.sin(a) * this._windSpeed * dt;
		this._drift.y += Math.cos(a) * this._windSpeed * dt;
		return this;
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}

const _tmp = new THREE.Color();
