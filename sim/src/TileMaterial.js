import * as THREE from 'three';

// Largeur du fondu au bord réel de la carte (issue #200, revient sur le
// hors-périmètre de #139 sur retour utilisateur explicite). CHOISI, pas
// mesuré — même statut que EDGE_VISIBILITY_M de fence-dome.js, qui répond au
// même problème ("cacher la coupure nette") pour le mode ?live=. Un mètre
// absolu plutôt qu'une fraction de la bbox : les scènes vont de ~530 m
// (paristest) à plus de 2,6 km de côté (chateau-des-ducs-de-bretagne,
// ground.js), et c'est la largeur perçue du fondu qui doit rester constante,
// pas sa proportion de la carte.
const EDGE_FADE_M = 50;

// One material per chunk. Every texture in the chunk lives as a layer of a
// sampler2DArray, so the whole chunk draws in a single call and each layer
// still gets its own mip chain (no bleeding between neighbouring tiles, which
// is what a packed atlas would suffer from here).
//
// The imagery is photogrammetry with lighting already baked in, so there is no
// lighting model: the sampled texel is the output, scaled by a single scalar
// when clouds are over the map (#22). That scalar carries no spatial structure
// on purpose — the geometry has no normals, and a projected pattern would
// argue with the shadows Apple baked into the texture.
// bbox : { min: [x,y,z], max: [x,y,z] } de manifest.json, en mètres ENU
// locaux — le même objet que ground.js reçoit pour le sol lointain (#139),
// donc déjà dans le bon repère sans conversion. Optionnel : les appels de
// test (selftest.mjs) qui n'en passent pas retombent sur des bornes à
// l'infini, donc aucun fondu — un matériau créé sans bbox se comporte comme
// avant #200.
export function createTileMaterial(arrayTexture, fogColor, fogDensity, bbox) {
	const min = bbox?.min ?? [-Infinity, -Infinity, -Infinity];
	const max = bbox?.max ?? [Infinity, Infinity, Infinity];
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: {
			uMap: { value: arrayTexture },
			uFogColor: { value: new THREE.Color(fogColor) },
			uFogDensity: { value: fogDensity },
			// Bord réel de la carte, au sol (X=est, Z=sud, CLAUDE.md) — pas la
			// bbox du CHUNK (chunk.bbox, purement une partition interne pour le
			// draw-call), celle de la SCÈNE entière : un chunk intérieur ne doit
			// jamais se dissoudre à sa propre frontière avec son voisin.
			uBboxMin: { value: new THREE.Vector2(min[0], min[2]) },
			uBboxMax: { value: new THREE.Vector2(max[0], max[2]) },
			uEdgeFadeM: { value: EDGE_FADE_M },
			// Les nuages passent (#22). Pas une ombre : un scalaire, sans aucune
			// structure spatiale — les tuiles portent déjà l'ombrage cuit
			// d'Apple, et un motif projeté par-dessus le contredirait. 1.0 est
			// bit-identique à l'absence de nuages.
			uDim: { value: 1 },
			// La profondeur de nuit (#112), sun.js:nightAmount(). À 0, le bloc
			// lumières est un no-op bit-identique au jour. La nuit, les pixels
			// clairs de l'imagerie — rues, toits, enseignes — restent allumés en
			// sodium au lieu de s'éteindre avec le reste : l'exposition de nuit
			// (lens.js, ~0,3-0,55) est appliquée en post sur TOUTE l'image, donc
			// une lumière ne peut lire comme allumée qu'en sortant d'ici déjà
			// près du plafond. Seuils et teinte choisis à l'œil, comme SKY_SLANT.
			uNight: { value: 0 },
		},
		vertexShader: /* glsl */`
			in float aLayer;
			out vec2 vUv;
			flat out uint vLayer;
			out float vDepth;
			out vec2 vWorldXZ;

			void main() {
				vUv = uv;
				vLayer = uint(aLayer);
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				// Position au sol en repère MONDE, pas caméra : le fondu de bord
				// (#200) doit rester fixe sur la carte, indépendant d'où on
				// regarde — contrairement à vDepth, qui lui doit varier avec la
				// caméra pour le brouillard atmosphérique.
				vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			precision highp sampler2DArray;

			uniform sampler2DArray uMap;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform vec2 uBboxMin, uBboxMax;
			uniform float uEdgeFadeM;
			uniform float uDim;
			uniform float uNight;

			in vec2 vUv;
			flat in uint vLayer;
			in float vDepth;
			in vec2 vWorldXZ;
			out vec4 outColor;

			void main() {
				// Assombri avant le brouillard : ce qui est voilé est déjà à
				// l'ombre du nuage, et le voile lui-même a la couleur de l'air,
				// qui a sa propre luminosité.
				vec3 tex = texture(uMap, vec3(vUv, float(vLayer))).rgb;
				vec3 c = tex * uDim;
				// Les lumières de la ville (#112). Le masque est la luminance de
				// la TEXTURE, pas du pixel assombri : ce qui est clair de jour
				// (rues, toits, enseignes) est ce qui est éclairé de nuit, et le
				// masque ne doit pas respirer avec les nuages. La teinte sodium
				// est portée vers le plafond pour survivre à l'exposition post.
				if (uNight > 0.0) {
					float lum = dot(tex, vec3(0.2126, 0.7152, 0.0722));
					float hot = smoothstep(0.62, 0.92, lum);
					// La texture reste SOUS la lumière : un gain sodium multiplié
					// plutôt qu'une couleur plaquée, sinon les toits clairs de la
					// ville deviennent des dalles orange sans structure.
					vec3 lit = min(vec3(1.0), tex * vec3(2.4, 1.75, 1.0));
					c = mix(c, lit, uNight * hot * 0.9);
				}
				// Exponential-squared fog, mostly to hide the hard cliff at the
				// edge of the tile.
				// Dupliquée dans ground.js (le sol lointain, #139) — les deux
				// DOIVENT rester identiques terme à terme, sinon la ligne
				// d'horizon se dédouble entre les tuiles et le sol. Si celle-ci
				// bouge, faire bouger l'autre avec.
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				// Fondu de bord (#200) : distance horizontale de CE fragment au
				// bord réel de la carte, pas à la caméra — donc visible même
				// depuis loin/en hauteur, quand vDepth n'a pas encore saturé
				// l'exponentielle ci-dessus (bbox de quelques centaines de mètres
				// contre ~2 km de portée météo claire). max(), pas mix() ni
				// somme : ne fait jamais MOINS visible qu'avant près du bord, et
				// un brouillard météo déjà épais à cette distance continue de
				// dominer sans double-compte.
				vec2 dEdge2 = min(vWorldXZ - uBboxMin, uBboxMax - vWorldXZ);
				float dEdge = min(dEdge2.x, dEdge2.y);
				float fEdge = 1.0 - smoothstep(0.0, uEdgeFadeM, dEdge);
				f = max(f, fEdge);
				outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
			}
		`,
	});
}

// Une fois la texture téléversée (renderer.initTexture), ses pixels n'ont plus
// de raison d'exister côté JS : three ne les relit qu'à un nouvel upload, que
// rien ne déclenche ici (pas de needsUpdate, pas de gestion de contexte
// perdu). Ils pesaient 268 + 75 Mo sur paristest, pour toute la vie de la
// page, et une page de vol est rechargée à chaque vol (issue #249). Le tampon
// est détaché pour être rendu tout de suite, pas au prochain GC.
export function releaseTexturePixels(tex) {
	const img = tex?.image;
	const data = img?.data;
	if (!data) return;
	img.data = null;
	const buf = data.buffer;
	if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
	try { structuredClone(buf, { transfer: [buf] }); } catch { /* non transférable : le GC s'en chargera */ }
}

export function createArrayTexture(pixels, cell, layerCount, { mipmaps = true, anisotropy = 8 } = {}) {
	const tex = new THREE.DataArrayTexture(pixels, cell, cell, layerCount);
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.UnsignedByteType;
	// Mipmaps here mean glGenerateMipmap over every layer of the array; some
	// drivers are very slow at that, hence the switch.
	tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = THREE.ClampToEdgeWrapping;
	tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = mipmaps;
	tex.anisotropy = mipmaps ? anisotropy : 1;
	tex.needsUpdate = true;
	return tex;
}
