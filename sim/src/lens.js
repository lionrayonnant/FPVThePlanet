import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Barrel distortion, lateral chromatic aberration, edge softness, vignetting and
// motion blur all in one fullscreen pass.
//
// One pass rather than a chain of four: the first four share a cause (the lens)
// and are all functions of the radius from the image centre, so they are one
// sampling decision, not four. A four-pass chain would cost four fullscreen
// read/write round trips for the same pixels.
//
// Nothing here reads depth. The world is static and the camera is the only thing
// that moves, so blur from rotation — the only blur that matters at 800 deg/s —
// is exactly reconstructible by reprojecting view rays through the rotation the
// camera turned through during the exposure. That sidesteps camera.near = 0.15
// entirely (see CLAUDE.md: it is pinned to the collider radius and cannot move).
// Blur from translation, i.e. parallax, is the part this ignores.

// Slider (0..1) -> physical coefficients. The barrel pair is normalised at the
// corner in the shader, so k1/k2 set how much the centre magnifies, not how much
// field of view is lost.
const K1 = 0.30;        // quadratic barrel term at full strength
const K2 = 0.10;        // quartic term; keeps the very edge from going flat
const CA = 0.006;       // per-channel radial split at the corner
const SOFT = 0.0035;    // defocus radius at the corner, in uv units
const VIGNETTE = 0.55;  // how dark the corner gets at full strength

// 8 taps banded visibly: an 800 deg/s roll smears the corner by ~160 px, and 8
// samples across that leaves 20 px gaps that read as streaks rather than blur.
// 16 taps plus a per-pixel dither turns what is left into grain. Measured cost
// of the extra taps: ~12 us each at 1920x1080, i.e. under 0.1 ms for the lot.
const MAX_TAPS = 16;

const LensShader = {
	defines: { TAPS: MAX_TAPS },
	uniforms: {
		tDiffuse: { value: null },
		uAspect: { value: 1 },
		uTanHalf: { value: 1 },
		uReproj: { value: new THREE.Matrix3() },
		uK1: { value: 0 },
		uK2: { value: 0 },
		uCA: { value: 0 },
		uSoft: { value: 0 },
		uVignette: { value: 0 },
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}`,
	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		uniform float uAspect;
		uniform float uTanHalf;
		uniform mat3 uReproj;
		uniform float uK1, uK2, uCA, uSoft, uVignette;
		varying vec2 vUv;

		void main() {
			vec2 ndc = vUv * 2.0 - 1.0;
			// Square-pixel space, so the lens is radially symmetric on the sensor
			// rather than on a stretched viewport.
			vec2 q = vec2(ndc.x * uAspect, ndc.y);
			float rMax = length(vec2(uAspect, 1.0));
			float r = length(q) / rMax;
			float r2 = r * r;

			// Normalised so the corner maps to the corner: the whole rendered field
			// of view survives the warp, which is why this needs no overscan and no
			// change to camera.fov. What barrel distortion actually costs is centre
			// magnification, and that is what invR is.
			float invR = 1.0 / (1.0 + uK1 + uK2 + uCA);
			vec2 base = q * ((1.0 + uK1 * r2 + uK2 * r2 * r2) * invR);

			// Motion vector, in the rendered image's own uv space: turn this pixel's
			// view ray back through the exposure and see where it used to project.
			vec2 uvHere = vec2(base.x / uAspect, base.y) * 0.5 + 0.5;
			vec3 dir = vec3(base.x * uTanHalf, base.y * uTanHalf, -1.0);
			vec3 was = uReproj * dir;
			vec2 motion = vec2(0.0);
			if (was.z < -1e-4) {
				vec2 wasNdc = vec2(was.x / -was.z, was.y / -was.z) / uTanHalf;
				motion = (vec2(wasNdc.x / uAspect, wasNdc.y) * 0.5 + 0.5) - uvHere;
				// A stalled frame can produce an absurd delta; a whole-screen smear
				// is worse than no smear.
				motion = clamp(motion, vec2(-0.1), vec2(0.1));
			}

			// Edge softness rides the same taps as the motion blur instead of paying
			// for its own: it is a defocus along the radius, growing with r^3.
			vec2 radial = r > 1e-5 ? normalize(vec2(base.x / uAspect, base.y)) * 0.5 : vec2(0.0);
			float soft = uSoft * r2 * r;

			// Breaks the tap comb into grain instead of stripes. On a video feed
			// that is the right kind of wrong.
			float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

			vec3 sum = vec3(0.0);
			for (int i = 0; i < TAPS; i++) {
				#if TAPS > 1
					float t = (float(i) + dither) / float(TAPS) - 0.5;
					vec2 off = motion * t + radial * soft * (mod(float(i), 2.0) * 2.0 - 1.0);
				#else
					vec2 off = vec2(0.0);
				#endif
				// Lateral chromatic aberration: the same warp at three slightly
				// different strengths, zero at the centre and widest at the edge.
				float split = uCA * r2;
				vec2 uvR = vec2((base.x * (1.0 - split)) / uAspect, base.y * (1.0 - split)) * 0.5 + 0.5 + off;
				vec2 uvG = uvHere + off;
				vec2 uvB = vec2((base.x * (1.0 + split)) / uAspect, base.y * (1.0 + split)) * 0.5 + 0.5 + off;
				sum += vec3(texture2D(tDiffuse, uvR).r, texture2D(tDiffuse, uvG).g, texture2D(tDiffuse, uvB).b);
			}
			vec3 c = sum / float(TAPS);

			c *= 1.0 - uVignette * pow(r, 2.5);
			gl_FragColor = vec4(c, 1.0);
		}`,
};

export class FpvLens {
	constructor(renderer, scene) {
		this.renderer = renderer;
		this.scene = scene;
		this.enabled = true;
		// Two renderer.render() calls happen per frame now (the scene, then the
		// quad), and info resets on each one — which would leave window.__sim
		// .debug() reporting the fullscreen quad's 1 draw call instead of the
		// scene's 5. Reset once per frame instead, so the counters still mean what
		// they used to.
		renderer.info.autoReset = false;

		// UnsignedByte, LinearSRGB and no OutputPass: the whole colour pipeline is
		// deliberately pass-through (main.js, HANDOFF bug #10). Anything that
		// re-encodes here turns the sky from #9FB8CC into #587A9A.
		//
		// samples: 4 because rendering into an offscreen target bypasses the
		// renderer's own antialias:true. Without it the building edges alias, and
		// that reads as a shader bug when it is really a missing MSAA target.
		const target = new THREE.WebGLRenderTarget(1, 1, {
			type: THREE.UnsignedByteType,
			colorSpace: THREE.LinearSRGBColorSpace,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			wrapS: THREE.ClampToEdgeWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			depthBuffer: true,
			samples: 4,
		});

		this.composer = new EffectComposer(renderer, target);
		this.renderPass = new RenderPass(scene, null);
		this.composer.addPass(this.renderPass);
		this.pass = new ShaderPass(LensShader);
		this.pass.renderToScreen = true;
		this.composer.addPass(this.pass);

		this._u = this.pass.uniforms;
		this._taps = MAX_TAPS;
		this._shutter = 0;
		this._qPrev = new THREE.Quaternion();
		this._qDelta = new THREE.Quaternion();
		this._qShutter = new THREE.Quaternion();
		this._m = new THREE.Matrix4();
		this._hasPrev = false;

		this.setParams({ lens: 0, vignette: 0, shutter: 0 });
	}

	setEnabled(on) {
		this.enabled = on;
		// Coming back from the plain path, the previous pose is stale.
		if (on) this._hasPrev = false;
	}

	// lens/vignette are 0..1, shutter is an exposure time in seconds.
	setParams({ lens, vignette, shutter }) {
		this._u.uK1.value = K1 * lens;
		this._u.uK2.value = K2 * lens;
		this._u.uCA.value = CA * lens;
		this._u.uSoft.value = SOFT * lens;
		this._u.uVignette.value = VIGNETTE * vignette;
		this._shutter = shutter;

		// The tap loop is the only real cost in here, so collapse it to one when
		// there is nothing to smear along. Recompiling the shader is only worth it
		// on the crossing, not on every drag of the slider.
		const taps = (shutter > 0 || this._u.uSoft.value > 0) ? MAX_TAPS : 1;
		if (taps !== this._taps) {
			this._taps = taps;
			this.pass.material.defines.TAPS = taps;
			this.pass.material.needsUpdate = true;
		}
	}

	setSize(width, height) {
		this.composer.setPixelRatio(this.renderer.getPixelRatio());
		this.composer.setSize(width, height);
	}

	// Renders the frame, effect or not. dt is the real frame time: the smear has
	// to be as long as the exposure, not as long as the frame.
	render(camera, dt) {
		this.renderer.info.reset();
		if (!this.enabled) {
			this.renderer.render(this.scene, camera);
			this._hasPrev = false;
			return;
		}

		this._u.uAspect.value = camera.aspect;
		this._u.uTanHalf.value = Math.tan(camera.fov * Math.PI / 360);

		// Taken from the camera's own pose rather than from physics.angularVelocity
		// so it still works in free camera, where the physics step is skipped.
		if (this._hasPrev && this._shutter > 0 && dt > 1e-6) {
			this._qDelta.copy(this._qPrev).invert().multiply(camera.quaternion);
			const f = Math.min(this._shutter / dt, 1);
			this._qShutter.set(0, 0, 0, 1).slerp(this._qDelta, f);
			this._u.uReproj.value.setFromMatrix4(this._m.makeRotationFromQuaternion(this._qShutter));
		} else {
			this._u.uReproj.value.identity();
		}
		this._qPrev.copy(camera.quaternion);
		this._hasPrev = true;

		this.renderPass.camera = camera;
		this.composer.render(dt);
	}
}
