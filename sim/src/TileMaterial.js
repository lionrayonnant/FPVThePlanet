import * as THREE from 'three';

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
export function createTileMaterial(arrayTexture, fogColor, fogDensity) {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: {
			uMap: { value: arrayTexture },
			uFogColor: { value: new THREE.Color(fogColor) },
			uFogDensity: { value: fogDensity },
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

			void main() {
				vUv = uv;
				vLayer = uint(aLayer);
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			precision highp sampler2DArray;

			uniform sampler2DArray uMap;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform float uDim;
			uniform float uNight;

			in vec2 vUv;
			flat in uint vLayer;
			in float vDepth;
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
				outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
			}
		`,
	});
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
