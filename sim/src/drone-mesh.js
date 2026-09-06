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
	if (part.rotX) geo.rotateX(part.rotX);
	if (part.rotY) geo.rotateY(part.rotY);
	geo.translate(part.at[0], part.at[1], part.at[2]);
	return geo;
}

function partGeometry(part, colors) {
	switch (part.kind) {
		case 'box': {
			const g = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
			const hex = part.role === 'plate' || part.role === 'arm' || part.role === 'battery' ? colors.frame : colors.metal;
			return colored(place(g, part), hex, 1);
		}
		case 'cylinder': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 8);
			return colored(place(g, part), colors.metal, 1);
		}
		case 'ring': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 12, 1, true);
			return colored(place(g, part), colors.frame, 1);
		}
		case 'disc': {
			const g = new THREE.CircleGeometry(part.size[0], 12);
			g.rotateX(-Math.PI / 2);
			return colored(place(g, part), colors.prop, PROP_ALPHA);
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
		},
		vertexShader: /* glsl */`
			in vec4 color;
			out vec4 vColor;
			out vec3 vNormalW;
			out float vDepth;
			out vec2 vUv;
			void main() {
				vColor = color;
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
			in vec4 vColor;
			in vec3 vNormalW;
			in float vDepth;
			in vec2 vUv;
			out vec4 outColor;
			void main() {
				// Éclairage à la main : hémisphère + soleil, mis à l'échelle par
				// l'ambiant du monde ; la nuit assombrit comme les tuiles.
				float lit = 0.55 + 0.45 * max(0.0, dot(normalize(vNormalW), uSunDir));
				vec3 c = vColor.rgb * lit * uAmbient * (1.0 - 0.75 * uNight);
				float a = vColor.a;
				// Disques d'hélice : un bruit radial qui tourne, flou d'hélice sans
				// géométrie animée (alpha < 1 ⇔ disque). L'angle est mesuré en UV
				// (coordonnées normalisées du disque, écrites par CircleGeometry et
				// qui survivent à la fusion), PAS en position fusionnée — sinon
				// l'angle serait mesuré autour de l'origine du corps et ne
				// couvrirait qu'une fraction de tour sur chaque disque.
				// 12 rad/s : 36 rad/s avec l'harmonique ×3, sous le seuil
				// d'aliasing à 60 fps (120 rad/s ≈ 19 Hz serait replié).
				if (a < 0.99) {
					float ang = atan(vUv.y - 0.5, vUv.x - 0.5) + uTime * 12.0;
					a *= 0.7 + 0.3 * sin(ang * 3.0);
				}
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
			in vec2 vUv;
			in float vDepth;
			out vec4 outColor;
			void main() {
				float r = length(vUv - 0.5) * 2.0;
				if (r > 1.0) discard;
				// Strobe : période 1,2 s, rapport tiré par drone.
				float on = fract(uTime / 1.2 + uPhase) < uDuty ? 1.0 : 0.15;
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				float a = (1.0 - r * r) * on * (1.0 - clamp(f, 0.0, 1.0));
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
