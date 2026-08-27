import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { LensDrops, dropFootprint } from './rain.js';

// Barrel distortion, lateral chromatic aberration, edge softness, vignetting,
// motion blur and video-link degradation all in one fullscreen pass.
//
// One pass rather than a chain: the lens effects share a cause (the lens) and
// are all functions of the radius from the image centre, so they are one
// sampling decision, not four. A chain of ShaderPasses would cost one fullscreen
// read/write round trip each for the same pixels.
//
// Nothing here reads depth. The world is static and the camera is the only thing
// that moves, so blur from rotation — the only blur that matters at 800 deg/s —
// is exactly reconstructible by reprojecting view rays through the rotation the
// camera turned through during the exposure. That sidesteps camera.near = 0.15
// entirely (see CLAUDE.md: it is pinned to the collider radius and cannot move).
// Blur from translation, i.e. parallax, is the part this ignores.
//
// Order matters: the lens is glass in front of the sensor, the link is what
// happens to the picture afterwards on its way to the goggles. So everything
// link-related lands at the end of the chain, after the vignette — the RF snow
// is not vignetted, because the vignette happened two boxes upstream of it.

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
// 16 is also 4x4, which is what the digital mode averages a macroblock with.
const MAX_TAPS = 16;

// Water on the front element. The physics is all in rain.js (see lensDrops and
// dropFootprint there, which is where the argument lives); these are the three
// numbers that are about drawing it rather than about optics.
//
// Two different sizes, and conflating them is what made the first pass of this
// read as a local smear instead of as water:
//
//   - how far across the picture the bead reaches is the pupil convolution, and
//     that is the disc's radius, which rain.js works out;
//   - what the bead *shows* comes from every direction it scatters into, which
//     is far wider than that — a bead is a ball of water, it collects most of a
//     hemisphere. So the content is averaged over a good multiple of the disc.
//
// Sample only the disc and you get the picture behind it, blurred, which is a
// smudge. Sample the cone and you get the pale, low-contrast wash that a drop
// actually is. Not much further than this, though: taken to the whole frame the
// average stops being local at all and a drop on the sky comes out *darker*
// than the sky, because it has swallowed the city.
const DROP_BLUR = 2.0;
// And that cone is dominated by whatever is brightest in it, which outdoors is
// the sky. So the average is taken from higher up the frame — and by a fraction
// of the *frame*, not of the disc, because the bead's reach is a hemisphere and
// has nothing to do with how big its footprint happens to be. That one choice
// is the whole look: pale against a facade, because it is holding sky; nothing
// at all against the sky, because there it is holding more of the same.
const DROP_SKY = 0.12;      // fraction of the picture height, upwards

// And then the honest version of the same statement. Offsetting the sample
// upwards only reaches the sky when there is sky just above; a bead's collecting
// hemisphere is dominated by the sky wherever the camera happens to be pointing.
// So the average is mixed towards the scene's own sky colour — the one
// loader.setFog() and scene.background are already using, so nothing is invented
// and a drop can never be brighter than the sky it is holding. That is what
// takes the drops from grey to a dull white, and it is the same argument
// rainfall.js makes for colouring the streaks with the sky.
const DROP_SKY_MIX = 0.6;   // how much of the bead's hemisphere is sky
// The bead's rim is where rays graze it, so it turns through the largest angles
// and collects from the widest cone of all. That is what puts a bright ring
// round a drop — and it is a *wider average*, not a gain: brightening what is
// already there would draw a ring on a uniform sky, where concentrating light
// that is the same in every direction changes nothing. Written this way the
// rim is bright against a facade, because it reaches further into the sky, and
// exactly invisible against the sky, because there is nothing else to reach.
const DROP_RIM = 1.1;      // extra collection radius at the rim, as a fraction

// The drop count is single digits (rain.js: a ten-millimetre window), so the
// population is a list of uniforms and not a procedural field — no cells, and
// therefore none of the grid the last attempt read as. The loop bound has to be
// a compile-time constant, so it is bucketed and recompiles only on a crossing,
// the same rule TAPS and LINK_MODE follow.
const DROP_BUCKETS = [0, 4, 8, 12, 16, 24];
const MAX_DROPS = DROP_BUCKETS[DROP_BUCKETS.length - 1];

// LINK_MODE is a define and not a uniform so that the mode you are not using
// costs exactly nothing — same reasoning as TAPS, and the same recompile-only-
// on-the-crossing rule. LINK_OFF must render byte-identically to the pass as it
// stood before the link existed.
export const LINK_OFF = 0;
export const LINK_ANALOG = 1;
export const LINK_DIGITAL = 2;

const LensShader = {
	defines: { TAPS: MAX_TAPS, LINK_MODE: LINK_OFF, DROPS: 0 },
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
		uLink: { value: 1 },
		uSeverity: { value: 1 },
		uTime: { value: 0 },
		uResolution: { value: new THREE.Vector2(1, 1) },
		// x, y in the same square space as `base`; z the footprint radius there;
		// w the flat core as a fraction of that radius.
		uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
		uDropAlpha: { value: new Float32Array(MAX_DROPS) },
		uDropSky: { value: new THREE.Color(0x9fb8cc) },
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
		uniform float uLink;
		uniform float uSeverity;
		uniform float uTime;
		uniform vec2 uResolution;
		varying vec2 vUv;

		#if DROPS > 0
			#define DROP_SKY_MIX ${DROP_SKY_MIX.toFixed(2)}
			#define DROP_BLUR ${DROP_BLUR.toFixed(2)}
			#define DROP_SKY ${DROP_SKY.toFixed(2)}
			#define DROP_RIM ${DROP_RIM.toFixed(2)}
			uniform vec4 uDrops[DROPS];
			uniform float uDropAlpha[DROPS];
			uniform vec3 uDropSky;
		#endif

		#if LINK_MODE != 0
			float hash12(vec2 p) {
				vec3 p3 = fract(vec3(p.xyx) * 0.1031);
				p3 += dot(p3, p3.yzx + 33.33);
				return fract((p3.x + p3.y) * p3.z);
			}
		#endif

		// A torn line wraps around: the shift is a timing error in a continuous
		// scan, not a translation of a bitmap, so what leaves one side comes back
		// on the other. Only analog needs it; every other mode compiles it away.
		#if LINK_MODE == 1
			#define WRAPX(uv) vec2(fract((uv).x), (uv).y)
		#else
			#define WRAPX(uv) (uv)
		#endif

		// Macroblocks are 16 px, like the codecs this is imitating.
		#define BLOCK_PX 16.0

		// Rec.601: the weights the analog chain itself uses to build luma, which
		// is the right basis here precisely because it is what is being imitated.
		#define LUMA vec3(0.299, 0.587, 0.114)

		// Chroma smear width, as a fraction of picture width. Composite chroma
		// bandwidth is roughly an eighth of luma's, so colour carries about that
		// much less horizontal detail.
		#define CHROMA_W 0.008

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

			// How far gone the link is. Everything below scales off this and is
			// exactly zero at uLink = 1, so a healthy link is the picture the lens
			// alone would have produced.
			float fade = 1.0 - uLink;

			// ---- what the link does to where we sample ------------------------
			// Sampling offsets rather than a post-process, so displacement costs no
			// extra taps: it rides the same offset vector the blur already applies,
			// which also puts it after the barrel warp, i.e. after the lens,
			// where it belongs.
			vec2 linkOff = vec2(0.0);
			float bar = 0.0;      // analog: how deep inside the rolling sync bar
			float blocky = 0.0;   // digital: 1 if this pixel's macroblock has failed
			float dfade = 0.0;    // digital: how far past the cliff we are

			#if LINK_MODE == 1
				float row = floor(gl_FragCoord.y);
				// Sync jitter is correlated down the picture: the line oscillator
				// drifts, it does not re-roll per line. Independent offsets per line
				// shred the image into confetti instead of making it wobble, which
				// is the difference between a weak analog link and a broken file.
				// So: a slow wobble the whole frame shares, and only about a pixel
				// of genuinely per-line noise on top.
				float wobble = sin(row * 0.03 + uTime * 9.0) + sin(row * 0.011 - uTime * 5.3);
				float lineNoise = hash12(vec2(row, floor(uTime * 60.0))) - 0.5;
				// A thin vertical structure is the worst case for this: the tower
				// reads as visibly bending at displacements of two or three pixels,
				// so the coefficient is set from how it looks on the tower, not
				// from how it looks on the city.
				float jitter = (wobble * 0.0015 + lineNoise * 0.0009) * fade * fade;
				// Whole lines losing sync outright, rather than merely running late.
				// Rare, large, and only once the link is genuinely going: at half
				// quality there are none at all.
				float torn = smoothstep(0.35, 0.0, uLink);
				float tn = hash12(vec2(row * 0.37, floor(uTime * 15.0)));
				float tear = step(1.0 - 0.07 * torn, tn) * (hash12(vec2(row, 7.0)) - 0.5) * 0.5 * torn;
				// The rolling sync bar: a band that scrolls up the frame, drags the
				// lines inside it sideways and dims them.
				float d = abs(fract(vUv.y - fract(uTime * 0.23) + 0.5) - 0.5);
				// Quadratic like the rest: in flat sky the bar is the most visible
				// artifact of the lot, so it has to stay out of the healthy half of
				// the range entirely.
				bar = smoothstep(0.045, 0.0, d) * fade * fade;
				linkOff.x = jitter + tear + bar * 0.02;
			#endif

			#if LINK_MODE == 2
				// Digital does not fade, it holds together and then shatters. The
				// threshold curve is what makes it read as "fine, fine, gone".
				dfade = smoothstep(0.6, 0.05, uLink);
				vec2 blockId = floor(gl_FragCoord.xy / BLOCK_PX);
				// Errors persist for several frames, the way a macroblock error
				// survives until the next keyframe. Re-rolling them at 60 Hz would
				// look like noise, not like compression.
				float bn = hash12(blockId + floor(uTime * 8.0) * 37.0);
				// Never quite every block at once: a decoder that has lost
				// everything freezes instead, and the freeze is handled on the JS
				// side by simply not rendering the frame.
				blocky = step(1.0 - dfade * dfade * 0.85, bn);
				// A failed block shows a block from somewhere else — the decoder
				// following a motion vector it never received a correction for.
				vec2 disp = (vec2(hash12(blockId + 11.0), hash12(blockId + 29.0)) - 0.5)
					* BLOCK_PX * 5.0 * dfade / uResolution;
				// Snapping to the block centre is what flattens the block; the lens
				// warp is re-added so the macroblocks still sit under the barrel
				// distortion instead of floating on top of it.
				vec2 blockCentre = (blockId + 0.5) * BLOCK_PX / uResolution;
				linkOff = blocky * (blockCentre - vUv + disp);
			#endif

			vec3 sum = vec3(0.0);
			for (int i = 0; i < TAPS; i++) {
				#if TAPS > 1
					float t = (float(i) + dither) / float(TAPS) - 0.5;
					vec2 off = motion * t + radial * soft * (mod(float(i), 2.0) * 2.0 - 1.0);
				#else
					vec2 off = vec2(0.0);
				#endif
				#if LINK_MODE == 2 && TAPS == 16
					// 4x4 inside the macroblock: with the samples pinned to the block
					// and not to the pixel, every pixel of a block averages the same
					// sixteen texels and the block comes out flat, which is the whole
					// point of a macroblock.
					vec2 g = vec2(mod(float(i), 4.0), floor(float(i) * 0.25));
					off = mix(off, ((g + 0.5) * 0.25 - 0.5) * BLOCK_PX / uResolution, blocky);
				#endif
				off += linkOff;
				// Lateral chromatic aberration: the same warp at three slightly
				// different strengths, zero at the centre and widest at the edge.
				float split = uCA * r2;
				vec2 uvR = vec2((base.x * (1.0 - split)) / uAspect, base.y * (1.0 - split)) * 0.5 + 0.5 + off;
				vec2 uvG = uvHere + off;
				vec2 uvB = vec2((base.x * (1.0 + split)) / uAspect, base.y * (1.0 + split)) * 0.5 + 0.5 + off;
				sum += vec3(texture2D(tDiffuse, WRAPX(uvR)).r,
				            texture2D(tDiffuse, WRAPX(uvG)).g,
				            texture2D(tDiffuse, WRAPX(uvB)).b);
			}
			vec3 c = sum / float(TAPS);

			// ---- water on the front element -----------------------------------
			// Before the vignette and before everything the link does, because the
			// bead is glass in front of the sensor and both of those happen after
			// it. Evaluated in base and not in q: the drop sits ahead of the
			// whole optic, so it is barrel-distorted along with the world behind
			// it — it grows at the centre and squeezes at the edge with the
			// picture, rather than floating on top of it.
			#if DROPS > 0
			{
				float mask = 0.0;    // how much of this pixel is water
				float rim = 0.0;     // and how much of it is the bead's bright edge
				float blur = 0.0;    // radius of the widest bead covering it
				vec2 push = vec2(0.0);
				for (int i = 0; i < DROPS; i++) {
					vec4 d = uDrops[i];
					vec2 rel = base - vec2(d.x * uAspect, d.y);
					float t = length(rel) / max(d.z, 1e-5);
					// The convolution of the bead with the entrance pupil: flat and
					// opaque out to the core, then a skirt to the rim. rain.js's
					// dropFootprint() is where that shape comes from, and the soft
					// edge is the pupil's diameter rather than a taste decision.
					float a = uDropAlpha[i] * (1.0 - smoothstep(d.w, 1.0, t));
					// The grazing band just inside the rim, where the bead turns
					// rays through the biggest angles.
					rim = max(rim, uDropAlpha[i]
						* smoothstep(0.70, 0.94, t) * (1.0 - smoothstep(0.94, 1.0, t)));
					// Over, not add: two beads overlapping are still one thickness of
					// water as far as the picture is concerned.
					mask += a - mask * a;
					blur = max(blur, d.z * step(0.004, a));
					// The bead is a weak lens as well as a diffuser. Kept tiny on
					// purpose: refraction is a detail here, not the mechanism. Treated
					// as the mechanism it made soap bubbles.
					push += rel * (a * 0.06);
				}
				if (mask > 0.003) {
					// Square space to uv. The half in each is ndc to uv; the aspect is
					// there because x was stretched to make the lens radially
					// symmetric on the sensor and has to be unstretched to sample.
					vec2 toUv = vec2(0.5 / uAspect, 0.5);
					// No image of the world survives the trip through a bead a
					// millimetre from the glass — it shows every direction the pupil
					// can see through it, averaged. So the content is a very wide
					// blur, biased towards the bright half of that cone, and never a
					// displaced copy of the picture.
					// Wider at the rim than in the middle, which is the ring.
					float wide = 1.0 + DROP_RIM * rim;
					vec2 cuv = uvHere + push * toUv + vec2(0.0, DROP_SKY * wide);
					// One mip level per collection radius: the level whose texels are
					// that wide already holds the average of everything inside them,
					// correctly weighted and for one tap. Four of them rather than one
					// so the disc is not a single flat colour — a bead does have
					// structure, it is just very low contrast.
					float radUv = 0.5 * blur * DROP_BLUR * wide;
					float lod = log2(max(radUv * uResolution.y, 1.0));
					vec3 acc = vec3(0.0);
					for (int k = 0; k < 4; k++) {
						float ang = (float(k) + dither) * 1.5707963;
						acc += texture2D(tDiffuse,
							clamp(cuv + vec2(cos(ang), sin(ang)) * radUv * toUv,
							      vec2(0.002), vec2(0.998)), lod).rgb;
					}
					acc *= 0.25;
					// Most of what the bead collects is sky, whichever way the
					// camera is pointing — and it is the scene's own sky, so this
					// cannot brighten a drop past the sky behind it. Wider at the
					// rim, which is what makes the ring: more sky there, and
					// nothing at all when the sky is what is behind it anyway.
					acc = mix(acc, uDropSky, clamp(DROP_SKY_MIX * wide, 0.0, 1.0));
					c = mix(c, acc, min(mask, 1.0));
				}
			}
			#endif

			c *= 1.0 - uVignette * pow(r, 2.5);

			// ---- and what it does to the picture itself -----------------------
			#if LINK_MODE == 1
				// ---- what analog looks like when the link is perfect ----------
				// This is the half the first version missed. A composite feed is
				// not a clean picture that later breaks: it is soft, washed and
				// colour-smeared from the very first frame, and that baseline is
				// what makes it read as an FPV feed rather than as a renderer
				// with a bug. Everything below this is what failure adds ON TOP.
				//
				// Chroma bandwidth is a fraction of luma's, so colour bleeds
				// sideways while edges stay where they are. Four taps outside the
				// main loop: this is a property of the signal, not of the lens, so
				// it has no business riding the lens's sampling pattern.
				// Jittered by the same per-pixel dither the tap loop uses, and for
				// the same reason: four evenly spaced samples across 25 px are a
				// comb, not a blur, and on a hard chroma edge like the tower
				// against the sky that comb reads as a ghosted double image. The
				// dither turns what is left of it into grain, which on a composite
				// feed is the right kind of wrong.
				vec3 ch = texture2D(tDiffuse, WRAPX(uvHere + vec2((-1.5 + dither) * CHROMA_W, 0.0))).rgb
				        + texture2D(tDiffuse, WRAPX(uvHere + vec2((-0.5 + dither) * CHROMA_W, 0.0))).rgb
				        + texture2D(tDiffuse, WRAPX(uvHere + vec2(( 0.5 + dither) * CHROMA_W, 0.0))).rgb
				        + texture2D(tDiffuse, WRAPX(uvHere + vec2(( 1.5 + dither) * CHROMA_W, 0.0))).rgb;
				ch *= 0.25;
				float chLuma = dot(ch, LUMA);
				// Luma keeps nearly all of its detail — only chroma is starved of
				// bandwidth. Softening luma much at all reads as a lens that is out
				// of focus rather than as a transmission that is band-limited.
				vec3 composite = clamp(vec3(mix(dot(c, LUMA), chLuma, 0.15)) + (ch - chLuma), 0.0, 1.0);
				// Lifted blacks and less contrast. An analog feed is never as deep
				// as the picture that went into the transmitter.
				composite = composite * 0.90 + 0.045;
				// A little grain is always there, even on a strong link.
				float hiss = hash12(gl_FragCoord.xy + uTime * 53.1);
				composite += (hiss - 0.5) * 0.045;
				c = mix(c, composite, uSeverity);

				// ---- and what the link failing adds on top --------------------
				// Scaled by uLink alone, never by uSeverity: the severity slider
				// already moved the link budget in link.js, so scaling here too
				// would count it twice.
				//
				// Colour goes before luminance: the chroma subcarrier sits at the
				// top of the video band and is the first thing the noise floor
				// eats. That slide to black and white is the signature of a dying
				// analog link. It stops short of fully grey — a little colour
				// survives right down to the breakup.
				c = mix(c, vec3(dot(c, LUMA)), 0.85 * smoothstep(0.85, 0.05, uLink));

				// RF grain, mostly on luminance with a little chroma left over.
				// Quadratic in the fade, so the healthy half of the range stays
				// genuinely calm instead of already crawling.
				float n = hash12(gl_FragCoord.xy + uTime * 131.7);
				vec3 chroma = vec3(hash12(gl_FragCoord.xy + uTime * 71.3),
				                   hash12(gl_FragCoord.xy + uTime * 43.1),
				                   hash12(gl_FragCoord.xy + uTime * 97.9));
				float grain = fade * fade;
				c += (vec3(n) - 0.5) * 0.30 * grain;
				c += (chroma - 0.5) * 0.10 * grain;

				// The sync bar dims what it drags.
				c *= 1.0 - bar * 0.30;

				// Snow. Held short of a full wipe so there is always a ghost of
				// the world left to point the quad at, and reached only in the
				// last few percent rather than as the second half of the fade.
				c = mix(c, vec3(n), 0.92 * smoothstep(0.12, 0.0, uLink));
			#endif

			#if LINK_MODE == 2
				// Fewer levels inside a broken block, and a seam around it. Blocking
				// artifacts are visible precisely because the quantiser lands on
				// different levels either side of a boundary the picture never had.
				float levels = mix(64.0, 12.0, dfade);
				vec3 quant = floor(c * levels + 0.5) / levels;
				c = mix(c, quant, blocky);
				vec2 inBlock = fract(gl_FragCoord.xy / BLOCK_PX);
				float seam = max(step(inBlock.x, 1.0 / BLOCK_PX), step(inBlock.y, 1.0 / BLOCK_PX));
				c *= 1.0 - seam * blocky * 0.18;
			#endif

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
			// A mip chain, for one reason: the drops. What a bead shows is an
			// average over most of a hemisphere, and a handful of taps spread
			// over that much picture is a noisy estimate of it — it came out as
			// grain rather than as water. A mip level *is* that average, and
			// three regenerates the chain after every render into this target.
			// Nothing else in the pass asks for a biased level, so nothing else
			// changes.
			generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter,
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
		// The freeze in digital mode works by not running the RenderPass, leaving
		// the last scene render in the composer's readBuffer for the lens pass to
		// pick up again. That only holds if readBuffer stops alternating: RenderPass
		// writes into readBuffer and does not swap, but the final ShaderPass does,
		// even though it renders to the screen and nothing consumes writeBuffer
		// after it. Left alone, a freeze would replay the frame *before* last and
		// a held picture would shiver between two old frames.
		this.pass.needsSwap = false;
		this.composer.addPass(this.pass);

		this._u = this.pass.uniforms;
		this._taps = MAX_TAPS;
		this._shutter = 0;
		this._linkMode = LINK_OFF;
		this._time = 0;
		this._qPrev = new THREE.Quaternion();
		this._qDelta = new THREE.Quaternion();
		this._qShutter = new THREE.Quaternion();
		this._m = new THREE.Matrix4();
		this._hasPrev = false;
		this._hasRendered = false;
		this.frozen = false;

		// The water on the front element. The population lives in rain.js, is
		// pure JS and is checked at the bench; this end only draws it. Pooled
		// because the uniform array is resized on a bucket crossing and there is
		// no reason to hand the GC a new set of vectors when that happens.
		this._drops = new LensDrops();
		this._dropPool = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
		this._dropBucket = 0;
		this._rain = { wetness: 0, dropMm: 0, drift: null, dt: 0 };

		this.setParams({ lens: 0, vignette: 0, shutter: 0 });
	}

	// For __sim.debug(): what the pilot is actually looking through.
	get dropCount() { return this._drops.count; }
	get beadMm() { return this._drops.beadMm; }

	setEnabled(on) {
		this.enabled = on;
		// Coming back from the plain path, the previous pose is stale and so is
		// whatever is left in the composer's buffers.
		if (on) { this._hasPrev = false; this._hasRendered = false; }
	}

	// lens/vignette are 0..1, shutter is an exposure time in seconds.
	setParams({ lens, vignette, shutter }) {
		this._u.uK1.value = K1 * lens;
		this._u.uK2.value = K2 * lens;
		this._u.uCA.value = CA * lens;
		this._u.uSoft.value = SOFT * lens;
		this._u.uVignette.value = VIGNETTE * vignette;
		this._shutter = shutter;
		this._updateDefines();
	}

	// mode is LINK_OFF / LINK_ANALOG / LINK_DIGITAL. severity is the slider: it
	// scales the analog mode's baseline look, and nothing else here — the fade
	// itself is already scaled where it is computed, in link.js.
	setLink({ mode, severity }) {
		this._linkMode = mode;
		this._u.uSeverity.value = severity;
		if (mode === LINK_OFF) this._u.uLink.value = 1;
		this._updateDefines();
	}

	// The weather on the glass: wetness and the fallen drop's diameter from
	// RainField, `drift` from dropDrift() — a specific force in the plane of the
	// lens, in g. dt is the caller's, already zeroed when the sim is frozen; the
	// digital freeze is applied on top of it in render(), where it is known.
	//
	// No clock uniform is involved, and that is deliberate: #24 lost time to
	// uTime running on under a held frame. Here the drops are a CPU population
	// advanced by a dt, so a dt of zero stops them dead — there is no second
	// clock that can be forgotten.
	setRain({ wetness = 0, dropMm = 0, drift = null, dt = 0, sky = null } = {}) {
		if (sky) this._u.uDropSky.value.copy(sky);
		this._rain.wetness = wetness;
		this._rain.dropMm = dropMm;
		this._rain.drift = drift;
		this._rain.dt = dt;
	}

	// Advance the population and pack it into the uniforms. tanHalf is the
	// camera's, and is what turns an angular footprint into the square space the
	// shader evaluates the field in.
	_updateDrops(dt) {
		const drops = this._drops.update({
			wetness: this._rain.wetness,
			dropDiameterMm: this._rain.dropMm,
			drift: this._rain.drift,
			dt,
		}).drops;

		const bucket = DROP_BUCKETS.find((b) => b >= drops.length) ?? MAX_DROPS;
		if (bucket !== this._dropBucket) {
			this._dropBucket = bucket;
			this._u.uDrops.value = this._dropPool.slice(0, bucket);
			this._u.uDropAlpha.value = new Float32Array(bucket);
			this._updateDefines();
		}
		if (bucket === 0) return;

		const tanHalf = this._u.uTanHalf.value;
		const alpha = this._u.uDropAlpha.value;
		for (let i = 0; i < bucket; i++) {
			const d = drops[i];
			if (!d) { alpha[i] = 0; this._dropPool[i].set(0, 0, 0, 0); continue; }
			const f = dropFootprint(d.bead);
			// Angle to the square space the shader works in: y = 1 there is the
			// tangent of the half field of view, so a half-angle becomes a radius
			// by the same tangent.
			const radius = Math.tan(0.5 * f.angle) / tanHalf;
			this._dropPool[i].set(d.x, d.y, radius, f.core);
			alpha[i] = f.peak * d.fade;
		}
		this._u.uDropAlpha.needsUpdate = true;
	}

	// Recompiling the shader is only worth it on a crossing, never on every drag
	// of a slider — so both defines are decided here and written only when they
	// actually change.
	_updateDefines() {
		// The tap loop is the only real cost in here, so collapse it to one when
		// there is nothing to smear along. Digital keeps all sixteen: that is the
		// 4x4 grid the macroblock average is built from.
		const taps = (this._shutter > 0 || this._u.uSoft.value > 0 || this._linkMode === LINK_DIGITAL)
			? MAX_TAPS : 1;
		const defines = this.pass.material.defines;
		if (taps === this._taps && defines.LINK_MODE === this._linkMode
			&& defines.DROPS === this._dropBucket) return;
		this._taps = taps;
		defines.TAPS = taps;
		defines.LINK_MODE = this._linkMode;
		defines.DROPS = this._dropBucket;
		this.pass.material.needsUpdate = true;
	}

	setSize(width, height) {
		const ratio = this.renderer.getPixelRatio();
		this.composer.setPixelRatio(ratio);
		this.composer.setSize(width, height);
		// gl_FragCoord counts device pixels, so this has to as well — otherwise the
		// macroblock grid is the wrong size on a HiDPI display.
		this._u.uResolution.value.set(width * ratio, height * ratio);
	}

	// Renders the frame, effect or not. dt is the real frame time: the smear has
	// to be as long as the exposure, not as long as the frame. `link` is
	// {quality, frozen} straight from VideoLink.
	render(camera, dt, link) {
		this.renderer.info.reset();
		if (!this.enabled) {
			this.renderer.render(this.scene, camera);
			this._hasPrev = false;
			this._hasRendered = false;
			this.frozen = false;
			return;
		}

		this._u.uAspect.value = camera.aspect;
		this._u.uTanHalf.value = Math.tan(camera.fov * Math.PI / 360);
		// Wrapped, because a float32 uniform that has been counting seconds all
		// afternoon has no precision left for a 60 Hz flicker.
		this._time = (this._time + dt) % 3600;
		this._u.uTime.value = this._time;
		if (this._linkMode !== LINK_OFF) this._u.uLink.value = link ? link.quality : 1;

		// A dropped frame is a frame that is not rendered: skip the RenderPass and
		// the lens pass re-reads the last scene image out of the composer's
		// readBuffer. It costs less than a normal frame rather than more, which is
		// also true of the real thing. Never on the first frame — there is nothing
		// in that buffer yet.
		const frozen = this._linkMode === LINK_DIGITAL && !!(link && link.frozen) && this._hasRendered;
		this.renderPass.enabled = !frozen;
		this.frozen = frozen;

		// A held frame is a picture that stopped arriving, so the water on the
		// glass has to stop with it — it is *in* that picture. The RF snow is
		// not, and keeps crawling, which is why uTime above is not gated here.
		this._updateDrops(frozen ? 0 : this._rain.dt);

		// Taken from the camera's own pose rather than from physics.angularVelocity
		// so it still works in free camera, where the physics step is skipped. A
		// held frame has nothing moving in it, so it gets no smear — but the pose
		// is still recorded, or the frame after a long freeze would smear across
		// the whole gap.
		if (this._hasPrev && this._shutter > 0 && dt > 1e-6 && !frozen) {
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
		this._hasRendered = true;
	}
}
