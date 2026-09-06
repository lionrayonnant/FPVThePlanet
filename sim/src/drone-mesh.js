// L'assemblage Three d'un quad (issue #250) depuis la recette de
// src/drone-shape.js. Une seule BufferGeometry fusionnée avec couleurs par
// sommet (alpha inclus pour les disques d'hélice), un ShaderMaterial maison —
// la scène n'a AUCUNE lumière (sun.js « ne ré-éclaire RIEN ») et le
// brouillard n'est pas scene.fog : on éclaire à la main par le soleil et on
// éteint par la même formule que TileMaterial.js / ground.js. La LED est un
// second maillage, billboard additif dont la taille est clampée en pixels.
//
// Ce module ne sait pas qui pilote le quad : un ambiant aujourd'hui, le
// drone du joueur (hélices dans le champ, épave) demain.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PROP_ALPHA = 0.35;

function colored(geo, hex, alpha) {
	const c = new THREE.Color(hex);
	const n = geo.attributes.position.count;
	const col = new Float32Array(4 * n);
	for (let i = 0; i < n; i++) { col[4 * i] = c.r; col[4 * i + 1] = c.g; col[4 * i + 2] = c.b; col[4 * i + 3] = alpha; }
	geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
	return geo;
}

function place(geo, part) {
	// L'ordre est celui de la recette : rotZ (le vrillage du pas d'une pale
	// autour de son propre axe long) d'abord, puis rotX, puis rotY (son
	// azimut autour de l'axe moteur). Inverser les deux dernières vrillerait
	// les pales dans le plan de l'hélice au lieu de leur donner du pas.
	if (part.rotZ) geo.rotateZ(part.rotZ);
	if (part.rotX) geo.rotateX(part.rotX);
	if (part.rotY) geo.rotateY(part.rotY);
	geo.translate(part.at[0], part.at[1], part.at[2]);
	return geo;
}

// À quel moteur ce morceau appartient (index Betaflight 0-3, `-1` pour tout ce
// qui n'appartient à aucun : plaque, batterie, caméra, antennes) et dans quel
// sens il tourne (±1, `0` pour ce qui ne tourne pas). C'est par là que le
// régime des quatre moteurs entre dans le maillage (issue #264). TOUTES les
// branches de partGeometry le posent, même celles qui n'en ont pas l'usage :
// mergeGeometries refuse des géométries aux attributs dépareillés.
function tagged(geo, part) {
	const n = geo.attributes.position.count;
	const motor = new Float32Array(n).fill(Number.isInteger(part.motor) ? part.motor : -1);
	const spin = new Float32Array(n).fill(part.spin ?? 0);
	geo.setAttribute('aMotor', new THREE.BufferAttribute(motor, 1));
	geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
	return geo;
}

function partGeometry(part, colors) {
	switch (part.kind) {
		case 'box': {
			const g = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
			const hex = part.role === 'plate' || part.role === 'arm' || part.role === 'battery' ? colors.frame : colors.metal;
			return tagged(colored(place(g, part), hex, 1), part);
		}
		case 'cylinder': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 8);
			return tagged(colored(place(g, part), colors.metal, 1), part);
		}
		case 'ring': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 12, 1, true);
			return tagged(colored(place(g, part), colors.frame, 1), part);
		}
		case 'disc': {
			const g = new THREE.CircleGeometry(part.size[0], 12);
			g.rotateX(-Math.PI / 2);
			return tagged(colored(place(g, part), colors.prop, PROP_ALPHA), part);
		}
		default: return null;   // 'point' (LED) : maillage séparé
	}
}

export function DroneMaterial() {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		transparent: true,
		depthWrite: true,
		side: THREE.DoubleSide,
		uniforms: {
			uSunDir: { value: new THREE.Vector3(0, 1, 0) },
			uAmbient: { value: 1 },
			uNight: { value: 0 },
			uFogColor: { value: new THREE.Color(0x000000) },
			uFogDensity: { value: 0 },
			uTime: { value: 0 },
			// Régime des quatre moteurs, rad/s, ordre Betaflight. C'est LUI qui
			// fait que le lacet, le roulis et le tangage se lisent dans les deux
			// hélices du champ : les avant sont sur des diagonales opposées, donc
			// un lacet en accélère une et ralentit l'autre.
			uOmega: { value: new Float32Array([0, 0, 0, 0]) },
			// 1 quand ce maillage a de vraies pales (niveau `onboard` ou
			// `portrait`), 0 sinon. Un maillage SANS pales — la silhouette des
			// ambiants — n'a que le disque pour dire l'hélice : il garde donc le
			// rendu d'avant #264, plein en permanence, et personne ne lui pose
			// jamais de régime. Un maillage AVEC pales fait l'inverse : le disque
			// n'apparaît qu'avec le régime, quand les pales s'effacent.
			uBlades: { value: 0 },
		},
		vertexShader: /* glsl */`
			in vec4 color;
			in float aMotor;
			in float aSpin;
			out float vMotor;
			out float vSpin;
			out vec4 vColor;
			out vec3 vNormalW;
			out float vDepth;
			out vec2 vUv;
			void main() {
				vColor = color;
				vMotor = aMotor;
				vSpin = aSpin;
				vNormalW = normalize(mat3(modelMatrix) * normal);
				vUv = uv;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uSunDir;
			uniform float uAmbient;
			uniform float uNight;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform float uTime;
			uniform float uOmega[4];
			uniform float uBlades;
			in vec4 vColor;
			in float vMotor;
			in float vSpin;
			in vec3 vNormalW;
			in float vDepth;
			in vec2 vUv;
			out vec4 outColor;
			void main() {
				// Éclairage à la main : hémisphère + soleil, assombri comme les
				// tuiles. uAmbient N'EST PAS l'exposition absolue du soleil
				// (sun.ambient vaut 0,059 au couchant, ce qui rendrait un ambiant
				// quasi noir) : l'exposition est le métier de l'AGC de la lentille,
				// qui la normalise pour toute la scène. uAmbient reçoit le MÊME
				// facteur d'obscurcissement que les tuiles (cloud.dim, cf. setDim
				// dans main.js) ; la nuit assombrit ensuite, comme elles.
				float lit = 0.55 + 0.45 * max(0.0, dot(normalize(vNormalW), uSunDir));
				vec3 c = vColor.rgb * lit * uAmbient * (1.0 - 0.75 * uNight);
				float a = vColor.a;
				// Le régime du moteur de ce sommet, zéro pour tout ce qui
				// n'appartient à aucun (aMotor = -1 : plaque, batterie, caméra,
				// antennes). Rien de tout cela ne bouge, quel que soit uOmega.
				float w = vMotor >= 0.0 ? uOmega[int(vMotor)] : 0.0;
				// Le fondu pales → disque. Au ralenti on distingue les pales une à
				// une ; au-delà d'un tour par image elles ne sont plus qu'un
				// disque. Le seuil est en rad/s : 2π/dt à 60 fps ≈ 377 rad/s.
				float blur = clamp(w / 377.0, 0.0, 1.0);
				// Disques d'hélice : un bruit radial qui tourne, flou d'hélice sans
				// géométrie animée (alpha < 1 ⇔ disque). L'angle est mesuré en UV
				// (coordonnées normalisées du disque, écrites par CircleGeometry et
				// qui survivent à la fusion), PAS en position fusionnée — sinon
				// l'angle serait mesuré autour de l'origine du corps et ne
				// couvrirait qu'une fraction de tour sur chaque disque.
				// 12 rad/s : 36 rad/s avec l'harmonique ×3, sous le seuil
				// d'aliasing à 60 fps (120 rad/s ≈ 19 Hz serait replié).
				if (a < 0.99) {
					// Sa rotation propre reste ces 12 rad/s — le régime
					// s'y AJOUTE, signé du sens, il ne la remplace pas : à uOmega
					// nul (les ambiants) le terme s'annule et l'image est celle
					// d'avant #264, au sommet près.
					float ang = atan(vUv.y - 0.5, vUv.x - 0.5) + uTime * (12.0 + w * 0.03 * vSpin);
					// Sans pales, le disque EST l'hélice : plein, comme avant.
					// Avec pales, il n'est que leur enveloppe : invisible à
					// l'arrêt, plein en régime.
					a *= (0.7 + 0.3 * sin(ang * 3.0)) * mix(1.0, blur, uBlades);
				} else if (vMotor >= 0.0 && vSpin != 0.0) {
					// Une pale : pleine à l'arrêt, effacée quand le disque prend
					// le relais. Les deux ne sont jamais visibles ensemble.
					a *= 1.0 - blur;
				}
				if (a <= 0.001) discard;
				// Dupliqué depuis TileMaterial.js, DÉLIBÉRÉMENT : les deux formules
				// doivent rester identiques terme à terme.
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), a);
			}
		`,
	});
}

export function LedMaterial() {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: THREE.AdditiveBlending,
		uniforms: {
			uColor: { value: new THREE.Color(0xffffff) },
			uMinPx: { value: 3 },
			uPhase: { value: 0 },
			uDuty: { value: 0.5 },
			uTime: { value: 0 },
			uResolution: { value: new THREE.Vector2(1920, 1080) },
			uFogColor: { value: new THREE.Color(0x000000) },
			uFogDensity: { value: 0 },
			// Fondu de distance de la LED. uMinPx la garde à 3 px quoi qu'il
			// arrive — sans ce fondu, un drone qui NAÎT ou qui PART le fait donc
			// en allumant une lumière, à 250 m comme à 320. Le brouillard ne
			// suffit pas : par temps clair il n'éteint rien.
			uFadeNear: { value: 200 },
			uFadeFar: { value: 320 },
		},
		vertexShader: /* glsl */`
			uniform float uMinPx;
			uniform vec2 uResolution;
			out vec2 vUv;
			out float vDepth;
			void main() {
				vUv = uv;
				// Billboard : le centre du quad en vue, puis l'offset en pixels
				// clampé — la LED ne descend jamais sous uMinPx.
				vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
				vDepth = -center.z;
				vec4 clip = projectionMatrix * center;
				float worldPx = 0.004 * projectionMatrix[1][1] * uResolution.y * 0.5 / max(vDepth, 0.01);
				float px = max(worldPx, uMinPx);
				vec2 off = (uv - 0.5) * 2.0 * px / uResolution * clip.w;
				gl_Position = clip + vec4(off, 0.0, 0.0);
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uColor;
			uniform float uPhase;
			uniform float uDuty;
			uniform float uTime;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform float uFadeNear;
			uniform float uFadeFar;
			in vec2 vUv;
			in float vDepth;
			out vec4 outColor;
			void main() {
				float r = length(vUv - 0.5) * 2.0;
				if (r > 1.0) discard;
				// Strobe : période 1,2 s, rapport tiré par drone.
				float on = fract(uTime / 1.2 + uPhase) < uDuty ? 1.0 : 0.15;
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				float far = 1.0 - smoothstep(uFadeNear, uFadeFar, vDepth);
				float a = (1.0 - r * r) * on * (1.0 - clamp(f, 0.0, 1.0)) * far;
				outColor = vec4(uColor * a, a);
			}
		`,
	});
}

export function setSun(mat, dir, ambient, night) {
	mat.uniforms.uSunDir.value.set(dir.x, dir.y, dir.z);
	mat.uniforms.uAmbient.value = ambient;
	mat.uniforms.uNight.value = night;
}
export function setFog(mat, color, density) {
	mat.uniforms.uFogColor.value.set(color);
	mat.uniforms.uFogDensity.value = density;
}
export function setTime(mat, t) { mat.uniforms.uTime.value = t; }
// Le régime des quatre moteurs, rad/s, ordre Betaflight. Appelée UNE fois par
// frame sur le chemin de vol : elle écrit dans le tableau déjà alloué de
// l'uniforme, elle n'en crée pas.
export function setOmega(mat, omega) {
	const u = mat.uniforms.uOmega.value;
	u[0] = omega[0]; u[1] = omega[1]; u[2] = omega[2]; u[3] = omega[3];
}
// Fondu de distance de la LED : pleine à `near`, éteinte à `far`.
export function setLedFade(mat, near, far) {
	mat.uniforms.uFadeNear.value = near;
	mat.uniforms.uFadeFar.value = far;
}
export function setResolution(mat, w, h) { mat.uniforms.uResolution.value.set(w, h); }

export function buildDroneMesh(shape, { colors }) {
	const geos = [];
	let ledAt = [0, 0, 0];
	for (const part of shape.parts) {
		if (part.role === 'led') { ledAt = part.at; continue; }
		const g = partGeometry(part, colors);
		if (g) geos.push(g);
	}
	const geometry = mergeGeometries(geos, false);
	for (const g of geos) g.dispose();
	geometry.computeBoundingSphere();

	const material = DroneMaterial();
	// Le niveau de détail se lit dans la recette, pas dans un argument : c'est
	// la présence de pales qui décide de la façon dont le disque se rend.
	material.uniforms.uBlades.value = shape.parts.some((p) => p.role === 'blade') ? 1 : 0;
	const body = new THREE.Mesh(geometry, material);
	body.frustumCulled = true;

	const ledMaterial = LedMaterial();
	ledMaterial.uniforms.uColor.value.set(colors.led);
	const led = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ledMaterial);
	led.position.set(ledAt[0], ledAt[1], ledAt[2]);
	led.frustumCulled = false;   // sa taille écran ne suit pas sa géométrie

	const group = new THREE.Group();
	group.matrixAutoUpdate = false;
	group.add(body); group.add(led);

	return {
		group, body, led, material, ledMaterial,
		dispose() {
			group.parent?.remove(group);
			geometry.dispose(); led.geometry.dispose();
			material.dispose(); ledMaterial.dispose();
		},
	};
}
