import * as THREE from 'three';

// One material per chunk. Every texture in the chunk lives as a layer of a
// sampler2DArray, so the whole chunk draws in a single call and each layer
// still gets its own mip chain (no bleeding between neighbouring tiles, which
// is what a packed atlas would suffer from here).
//
// The imagery is photogrammetry with lighting already baked in, so there is no
// lighting model: the sampled texel is the output. The renderer is left in
// linear-sRGB output so that texel reaches the framebuffer untouched.
export function createTileMaterial(arrayTexture, fogColor, fogDensity) {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: {
			uMap: { value: arrayTexture },
			uFogColor: { value: new THREE.Color(fogColor) },
			uFogDensity: { value: fogDensity },
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

			in vec2 vUv;
			flat in uint vLayer;
			in float vDepth;
			out vec4 outColor;

			void main() {
				vec3 c = texture(uMap, vec3(vUv, float(vLayer))).rgb;
				// Exponential-squared fog, mostly to hide the hard cliff at the
				// edge of the tile.
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
