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
import { bladeOutline } from './drone-shape.js';

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
	// Le pivot d'une pale (issue #283) : l'axe de son moteur, dans le repère
	// du corps, et w = 1 pour dire « je tourne ». Le vertex shader fait
	// tourner la pale autour de lui de la phase accumulée du moteur — c'est ce
	// qui fait qu'au ralenti on VOIT les pales tourner, avant qu'elles ne
	// s'effacent dans le disque. Tout le reste a w = 0 et ne bouge pas.
	const pivot = new Float32Array(4 * n);
	if (part.kind === 'blade') {
		for (let i = 0; i < n; i++) { pivot[4 * i] = part.at[0]; pivot[4 * i + 1] = part.at[1]; pivot[4 * i + 2] = part.at[2]; pivot[4 * i + 3] = 1; }
	}
	geo.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 4));
	return geo;
}

// Une pale (issue #283) : une bande de triangles tendue entre le bord
// d'attaque et le bord de fuite de bladeOutline(), station par station. Le
// vrillage est dans les stations, donc la surface est gauche — c'est ce qu'une
// pale est, et c'est ce qui accroche la lumière différemment à l'emplanture et
// au bout. Indexée, comme les primitives Three : mergeGeometries et
// tools/lens-coverage.mjs lisent l'index.
function bladeGeometry(part) {
	const { le, te } = bladeOutline(part);
	const n = le.length;
	const pos = new Float32Array(6 * n);
	const uv = new Float32Array(4 * n);
	for (let i = 0; i < n; i++) {
		pos.set(le[i], 6 * i);
		pos.set(te[i], 6 * i + 3);
		const t = i / (n - 1);
		uv[4 * i] = 0; uv[4 * i + 1] = t;
		uv[4 * i + 2] = 1; uv[4 * i + 3] = t;
	}
	const idx = [];
	for (let i = 0; i < n - 1; i++) {
		const a = 2 * i, b = 2 * i + 1, c = 2 * i + 2, d = 2 * i + 3;
		idx.push(a, b, c, b, d, c);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

// De quoi chaque rôle est fait (issue #284) : sa COULEUR dans la livrée, et sa
// CLASSE de matériau pour le shader — 0 carbone (tissage, reflet large),
// 1 métal (reflet serré), 2 plastique (hélices, TPU, film du pack). Les pales
// ont la couleur de l'HÉLICE : c'est le même objet que le disque qui les
// remplace en régime, et il ne doit pas changer de teinte en montant en
// puissance. Un rôle inconnu est du carbone : la recette peut grandir sans
// qu'une pièce nouvelle sorte en rose.
export const CARBON = 0, METAL = 1, PLASTIC = 2, EMISSIVE = 3;
const MATERIAL_OF = {
	plate: ['frame', CARBON], arm: ['frame', CARBON], cage: ['frame', CARBON], stack: ['frame', CARBON],
	motor: ['metal', METAL], bell: ['bell', METAL], hub: ['bell', METAL],
	prop: ['prop', PLASTIC], blade: ['prop', PLASTIC],
	// Le boîtier de caméra est en TPU sur presque tous les montages : c'est
	// la pièce colorée la plus visible de face.
	duct: ['tpu', PLASTIC], mount: ['tpu', PLASTIC], antenna: ['tpu', PLASTIC], camera: ['tpu', PLASTIC],
	battery: ['battery', PLASTIC], strap: ['strap', PLASTIC],
	gopro: ['metal', PLASTIC],
	ledbar: ['led', EMISSIVE],
};
// La livrée peut être partielle (les gris d'avant #284) : chaque rôle de
// couleur retombe sur le gris qui le rendait avant.
const FALLBACK = { bell: 'metal', tpu: 'frame', battery: 'frame', strap: 'frame' };
const TIP_FROM = 0.78;
function dressed(geo, part, colors, alpha = 1) {
	const [key, mat] = MATERIAL_OF[part.role] ?? ['frame', CARBON];
	const hex = colors[key] ?? colors[FALLBACK[key]] ?? colors.frame;
	const n = geo.attributes.position.count;
	geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(mat), 1));
	tagged(colored(geo, hex, alpha), part);
	// Hélices bicolores (#284) : le bout de pale, au-delà de 78 % du rayon,
	// prend la seconde couleur. uv.y est la station le long de la pale.
	if (part.kind === 'blade' && colors.tip) {
		const c = new THREE.Color(colors.tip);
		const col = geo.attributes.color.array, uv = geo.attributes.uv.array;
		for (let i = 0; i < n; i++) if (uv[2 * i + 1] >= TIP_FROM) { col[4 * i] = c.r; col[4 * i + 1] = c.g; col[4 * i + 2] = c.b; }
	}
	return geo;
}

function partGeometry(part, colors, fine) {
	switch (part.kind) {
		case 'box':
			return dressed(place(new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]), part), part, colors);
		case 'blade':
			return dressed(place(bladeGeometry(part), part), part, colors);
		case 'cylinder':
			return dressed(place(new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 8), part), part, colors);
		case 'ring':
			return dressed(place(new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 12, 1, true), part), part, colors);
		case 'disc': {
			// Douze côtés pour un disque vu à cent mètres ; vingt-quatre quand
			// il est à huit centimètres de l'objectif (#283) — à douze, le
			// bord du flou d'hélice est un polygone.
			const g = new THREE.CircleGeometry(part.size[0], fine ? 24 : 12);
			g.rotateX(-Math.PI / 2);
			return dressed(place(g, part), part, colors, PROP_ALPHA);
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
			// La phase de chaque moteur, en radians, accumulée par setOmega()
			// avec le pas de temps : c'est l'angle dont les pales ont tourné.
			// Une phase n'est pas ω·t — le régime change à chaque frame.
			uPhase: { value: new Float32Array([0, 0, 0, 0]) },
			// 1 quand ce maillage a de vraies pales (niveau `onboard` ou
			// `portrait`), 0 sinon. Un maillage SANS pales — la silhouette des
			// ambiants — n'a que le disque pour dire l'hélice : il garde donc le
			// rendu d'avant #264, plein en permanence, et personne ne lui pose
			// jamais de régime. Un maillage AVEC pales fait l'inverse : le disque
			// n'apparaît qu'avec le régime, quand les pales s'effacent.
			uBlades: { value: 0 },
			// Le pas du tissage carbone, en mètres (issue #284).
			uWeave: { value: 0.002 },
			// L'usure du build, 0..1 (#284) : poussière dessous, éraflures,
			// brillant qui s'en va, bouts de pales blanchis.
			uWear: { value: 0 },
			// La seconde couleur des hélices bicolores, et si elle existe : le
			// disque en régime porte la même couronne que les pales.
			uTip: { value: new THREE.Color(0xffffff) },
			uTipOn: { value: 0 },
		},
		vertexShader: /* glsl */`
			uniform float uPhase[4];
			in vec4 color;
			in float aMotor;
			in float aSpin;
			in vec4 aPivot;
			in float aMat;
			out float vMotor;
			out float vSpin;
			out float vMat;
			out vec4 vColor;
			out vec3 vNormalW;
			out vec3 vNormalB;
			out vec3 vPosW;
			out vec3 vPosB;
			out float vDepth;
			out vec2 vUv;
			void main() {
				vColor = color;
				vMotor = aMotor;
				vSpin = aSpin;
				vMat = aMat;
				vUv = uv;
				vec3 p = position;
				vec3 nrm = normal;
				// Une pale tourne autour de l'axe de son moteur (+Y du corps),
				// de la phase de ce moteur, dans son sens. Positif = sens
				// direct vu de dessus, comme motorsOf() dans quad.js.
				if (aPivot.w > 0.5) {
					float ph = uPhase[int(aMotor)] * aSpin;
					float c = cos(ph), s = sin(ph);
					vec3 d = p - aPivot.xyz;
					p = aPivot.xyz + vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
					nrm = vec3(nrm.x * c + nrm.z * s, nrm.y, -nrm.x * s + nrm.z * c);
				}
				vNormalW = normalize(mat3(modelMatrix) * nrm);
				// En espace CORPS, pour le tissage : il est cousu sur la pièce,
				// il ne glisse pas quand la machine bouge.
				vPosB = p;
				vNormalB = nrm;
				vec4 world = modelMatrix * vec4(p, 1.0);
				vPosW = world.xyz;
				vec4 mv = viewMatrix * world;
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
			uniform float uWeave;
			uniform float uWear;
			uniform vec3 uTip;
			uniform float uTipOn;
			in vec4 vColor;
			in float vMotor;
			in float vSpin;
			in float vMat;
			in vec3 vNormalW;
			in vec3 vNormalB;
			in vec3 vPosW;
			in vec3 vPosB;
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
				//
				// Double face : une pale vue de dessous a sa normale à l'envers.
				// On la retourne, sinon son éclairage est celui de l'autre face.
				vec3 n = normalize(vNormalW);
				if (!gl_FrontFacing) n = -n;
				vec3 v = normalize(cameraPosition - vPosW);
				float lit = 0.55 + 0.45 * max(0.0, dot(n, uSunDir));
				// La matière (issue #284). Carbone : un sergé procédural en
				// espace corps — deux familles de rayures à 45°, alternées, sur
				// les deux axes orthogonaux à la normale de la pièce (les flancs
				// d'un bras comme sa face). Le carbone est presque noir :
				// l'albédo seul ne montre rien, c'est le REFLET qui porte le
				// sergé — une mèche brille, la suivante mate —, comme sur une
				// vraie plaque au soleil. Métal : reflet serré. Plastique
				// (hélices, TPU, pack) : reflet moyen.
				vec3 albedo = vColor.rgb;
				float specExp = 12.0, specK = 0.30;
				if (vMat < 0.5) {
					vec3 an = abs(vNormalB);
					vec2 q = an.y >= an.x && an.y >= an.z ? vPosB.xz : (an.x >= an.z ? vPosB.yz : vPosB.xy);
					q /= uWeave;
					float weave = abs(step(0.5, fract(q.x + q.y)) - step(0.5, fract(q.x - q.y)));
					albedo *= mix(0.78, 1.25, weave);
					specExp = 6.0; specK = 0.10 + 0.34 * weave;
				} else if (vMat < 1.5) {
					specExp = 28.0; specK = 0.55;
				}
				// L'usure (#284). De la poussière sur ce qui regarde le sol, des
				// éraflures claires semées au hasard en espace corps, un
				// brillant qui s'éteint, et les bouts de pales qui blanchissent
				// — ce qu'une machine qui a volé raconte avant même de décoller.
				if (uWear > 0.0) {
					float under = 0.5 - 0.5 * vNormalB.y;
					albedo = mix(albedo, vec3(0.36, 0.33, 0.29), 0.45 * uWear * under);
					float h = fract(sin(dot(floor(vPosB * 700.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
					// Rares et fines : à 22 % de cellules la machine était de la
					// neige d'écran, regardé sur 24 builds.
					albedo += 0.10 * step(1.0 - 0.07 * uWear, h);
					specK *= 1.0 - 0.5 * uWear;
					if (vMat > 1.5 && vSpin != 0.0) albedo = mix(albedo, vec3(0.86, 0.84, 0.80), 0.5 * uWear * smoothstep(0.86, 1.0, vUv.y));
				}
				// Le reflet (issue #283) : du carbone et de l'aluminium à un
				// mètre, ou à huit centimètres, ne sont pas mats — sans ce
				// brillant la machine est une silhouette noire. Blinn-Phong
				// large sur le carbone (la machine est faite de boîtes à six
				// normales, un reflet serré n'en accroche aucune), plus un
				// liseré de contre-jour qui détache les arêtes du fond.
				float spec = pow(max(0.0, dot(n, normalize(uSunDir + v))), specExp) * specK;
				float rim = pow(1.0 - max(0.0, dot(n, v)), 3.0) * 0.12;
				float night = 1.0 - 0.75 * uNight;
				vec3 c = (albedo * lit + vec3(spec + rim)) * uAmbient * night;
				// Émissif (la barre de LED) : sa propre lumière, ni soleil ni
				// nuit — le brouillard, lui, s'applique comme à tout le reste.
				if (vMat > 2.5) c = albedo * 1.4;
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
					float rad = length(vUv - 0.5) * 2.0;
					float ang = atan(vUv.y - 0.5, vUv.x - 0.5) + uTime * (12.0 + w * 0.03 * vSpin);
					// Avec pales (issue #283), le disque est ce qu'une caméra
					// voit d'une hélice en régime : les fantômes des pales,
					// COURBÉS par le rolling shutter (la phase tourne avec le
					// rayon, dans le sens de rotation), sur un voile dont la
					// densité décroît du moyeu au bout — la corde balayée par
					// tour est constante, le périmètre grandit. Sans pales (les
					// ambiants, à 100 m) le disque reste le motif d'avant.
					float ghost = 0.7 + 0.3 * sin(ang * 3.0 - vSpin * rad * 2.2 * uBlades);
					// Le voile s'éteint en douceur au bout des pales : le bord
					// d'un flou d'hélice n'est pas une arête.
					float veil = mix(1.0, (1.55 - 0.85 * rad) * smoothstep(1.0, 0.86, rad), uBlades);
					// La couronne des hélices bicolores, sur le disque comme sur
					// les pales (même seuil de rayon).
					c = mix(c, uTip * (0.55 + 0.45 * max(0.0, dot(n, uSunDir))) * uAmbient * night, uTipOn * uBlades * smoothstep(0.74, 0.80, rad));
					// Sans pales, le disque EST l'hélice : plein, comme avant.
					// Avec pales, il n'est que leur enveloppe : invisible à
					// l'arrêt, plein en régime.
					a *= ghost * veil * mix(1.0, blur, uBlades);
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
// `dt` fait avancer la phase des pales (issue #283) ; sans lui (les selftests,
// un appel hors du pas de temps) le régime est posé et les pales ne bougent
// pas. La phase est repliée sur un tour : un float qui grandit pendant tout
// un vol finirait par perdre la précision d'un angle.
const TWO_PI = 2 * Math.PI;
export function setOmega(mat, omega, dt = 0) {
	const u = mat.uniforms.uOmega.value;
	u[0] = omega[0]; u[1] = omega[1]; u[2] = omega[2]; u[3] = omega[3];
	if (dt > 0) {
		const ph = mat.uniforms.uPhase.value;
		for (let k = 0; k < 4; k++) ph[k] = (ph[k] + omega[k] * dt) % TWO_PI;
	}
}
// Fondu de distance de la LED : pleine à `near`, éteinte à `far`.
export function setLedFade(mat, near, far) {
	mat.uniforms.uFadeNear.value = near;
	mat.uniforms.uFadeFar.value = far;
}
export function setResolution(mat, w, h) { mat.uniforms.uResolution.value.set(w, h); }

// `colors` : les gris de base { frame, metal, prop, led } plus, si la livrée
// est connue (issue #284, tools/target-livery.mjs), { bell, tpu, battery,
// led, weave } — chaque clé absente retombe sur le gris qui la rendait avant.
export function buildDroneMesh(shape, { colors }) {
	// Un maillage AVEC pales est vu de près : ses disques sont plus finement
	// découpés. La silhouette des ambiants garde ses douze côtés.
	const fine = shape.parts.some((p) => p.role === 'blade');
	const geos = [];
	let ledAt = [0, 0, 0];
	for (const part of shape.parts) {
		if (part.role === 'led') { ledAt = part.at; continue; }
		const g = partGeometry(part, colors, fine);
		if (g) geos.push(g);
	}
	const geometry = mergeGeometries(geos, false);
	for (const g of geos) g.dispose();
	geometry.computeBoundingSphere();

	const material = DroneMaterial();
	// Le niveau de détail se lit dans la recette, pas dans un argument : c'est
	// la présence de pales qui décide de la façon dont le disque se rend.
	material.uniforms.uBlades.value = shape.parts.some((p) => p.role === 'blade') ? 1 : 0;
	if (colors.weave) material.uniforms.uWeave.value = colors.weave;
	if (colors.wear) material.uniforms.uWear.value = colors.wear;
	if (colors.tip) { material.uniforms.uTip.value.set(colors.tip); material.uniforms.uTipOn.value = 1; }
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
