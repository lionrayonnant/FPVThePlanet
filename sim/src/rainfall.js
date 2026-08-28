import * as THREE from 'three';

// The rain you can actually see falling, as geometry in the scene rather than
// as a layer over the picture. That is the whole point of it being here: put in
// the scene it is drawn by the RenderPass, so it goes through src/lens.js like
// everything else — barrel distortion, vignette, motion blur, video-link
// breakup — and it is depth-tested against the city, so a street is full of
// rain and the far side of a building is not.
//
// It is also why the box is small. A drop is about a millimetre across; at
// 120 deg and 1080 lines a pixel subtends about 3 mm at one metre, so past a
// few metres a drop is thinner than a pixel and stops being a streak. What
// happens to those drops is extinction, not geometry — and that is exactly what
// the fog term rain.js drives is for. So this draws the near field, the fog
// carries the far field, and neither is asked to do the other's job.
const BOX = 4.0;

// A 4 m box holds ~30k drops in a downpour (rain.js: dropsPerM3), which is what
// this is sized for. They are one instanced draw call of two triangles each.
const MAX_DROPS = 30000;

// A raindrop is a fraction of a pixel wide at any distance worth drawing: 1.6 mm
// at two metres is a third of a pixel at 120 deg on 1080 lines. Rasterised at
// its true width it flickers; widened to a bit over a pixel and dimmed by
// exactly the factor it was widened, it puts the same light on the frame and
// stops aliasing. This is the classic thin-geometry fix.
const MIN_PX = 1.3;

// And here is the honest part, because it is the one number in this file that
// is not physics. Carry the chain above through at life size and the answer is
// that you cannot see falling rain: the near field's optical depth over a
// four-metre box is under one percent, and a streak comes out a third of a
// pixel wide at a tenth of an alpha, which is below anything a display can
// show. That answer is correct and it is useless — real FPV footage plainly has
// rain in it, because a real sensor's point spread, a real lens's defocus at
// one metre and a real drop's glint all conspire to put the light somewhere
// visible, and none of those three are modelled here.
//
// So the streak is drawn wider than the drop. Only the width is exaggerated,
// never the opacity: uAlpha is still computed from the true diameter, so how
// streak brightness moves with rate, speed and exposure stays the physics, and
// this is only the decision to draw the result at a size a screen can resolve.
//
// The count is then divided by the same factor, so the total area of glass the
// rain covers comes out where the concentration says it should. Fatter streaks,
// proportionally fewer of them — which also means the exaggeration costs
// nothing, it buys frames.
const STREAK_WIDTH_GAIN = 5;

// The exposure the streak length is built from. Zero on the shutter slider
// means "no motion blur please", not "a camera that does not integrate": a
// global-shutter FPV cam in daylight sits around 1/500, so that is the floor.
const MIN_EXPOSURE = 1 / 500;

// How much light a drop actually puts back at the camera, per unit of the
// geometric coverage worked out in update(). Far above 1, and deliberately so:
// a drop is not a grey occluder but a ball lens. It gathers skylight over a
// wide cone and concentrates it at you, which is why near rain reads as bright
// streaks and not as the 0.7% of light the extinction over a four-metre box
// would actually remove. None of that glint geometry is modelled, so this is
// the one number here fitted by eye rather than derived — the chain under it
// sets how streak brightness varies with rate, speed and exposure, and this
// sets the level.
const SCATTER_GAIN = 18;

// And a ceiling on it, so a drop can be nearly opaque — which the ones a
// hand's breadth from the lens genuinely are — without going past it.
const MAX_ALPHA = 0.9;

// Drops scatter skylight, so they are the colour of the sky, lifted a little.
// That single choice is what makes them behave: against the sky they vanish,
// which is correct, and against a dark facade they read as light streaks,
// which is also correct. No light source is involved, which is just as well —
// the scene has none (the photogrammetry carries its own shading).
const LIFT = 0.22;

export class Rainfall {
	constructor(scene, { sky = 0x9fb8cc, seed = 0x51a1 } = {}) {
		this.scene = scene;

		const quad = new THREE.PlaneGeometry(1, 1);
		const geometry = new THREE.InstancedBufferGeometry();
		geometry.index = quad.index;
		geometry.attributes.position = quad.attributes.position;
		geometry.attributes.uv = quad.attributes.uv;
		geometry.attributes.normal = quad.attributes.normal;
		// Not disposed: its attributes are now this geometry's attributes, and
		// the dispose event is what drops them from the renderer's buffer cache.

		// xyz: where in the box this drop sits, 0..1. w: a size jitter, because a
		// drop size distribution is a distribution and a field of identical
		// streaks reads as a screen effect.
		const drops = new Float32Array(MAX_DROPS * 4);
		let s = seed >>> 0;
		const rnd = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 4294967296;
		};
		for (let i = 0; i < MAX_DROPS * 4; i++) drops[i] = rnd();
		geometry.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
		geometry.instanceCount = 0;
		// The box follows the camera, so there is never anything to cull, and the
		// bounding sphere of a geometry that is entirely rewritten in the vertex
		// shader would be a lie anyway.
		geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

		const colour = new THREE.Color(sky);
		colour.r += LIFT; colour.g += LIFT; colour.b += LIFT;

		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			transparent: true,
			depthWrite: false,
			// DoubleSide is not laziness: the quad is rebuilt from scratch in view
			// space every vertex, so its winding depends on which way the streak
			// happens to be running past the camera. It comes out back-facing, and
			// with the default FrontSide every last drop is silently culled — the
			// draw call is issued, the triangles are counted, and nothing appears.
			side: THREE.DoubleSide,
			uniforms: {
				uColor: { value: colour },
				uOffset: { value: new THREE.Vector3() },
				uCam: { value: new THREE.Vector3() },
				uRel: { value: new THREE.Vector3(0, -1, 0) },
				uLength: { value: 0.04 },
				uWidth: { value: 0.0012 },
				uPxScale: { value: 0.003 },
				uAlpha: { value: 0 },
			},
			vertexShader: /* glsl */`
				in vec4 aDrop;

				uniform vec3 uOffset;
				uniform vec3 uCam;
				uniform vec3 uRel;
				uniform float uLength;
				uniform float uWidth;
				uniform float uPxScale;
				uniform float uAlpha;

				out float vAlpha;
				out float vT;
				out float vX;

				void main() {
					// Wrapped into a box centred on the camera: a drop that leaves
					// the top comes back in at the bottom, so the population is
					// constant, nothing is ever respawned, and the CPU writes one
					// vec3 per frame instead of thirty thousand.
					vec3 p = aDrop.xyz * ${BOX.toFixed(1)} + uOffset;
					p = uCam + mod(p - uCam + ${(BOX * 0.5).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX * 0.5).toFixed(1)};

					vec4 vp = viewMatrix * vec4(p, 1.0);
					// The streak is the drop's path during the exposure, so it runs
					// along the drop's velocity *relative to the drone* — which is
					// why flying fast lays the rain over towards you.
					vec3 vr = mat3(viewMatrix) * uRel;
					float rl = length(vr);
					vec3 along = rl > 1e-5 ? vr / rl : vec3(0.0, -1.0, 0.0);
					// Width across both the streak and the view ray, i.e. the one
					// direction that is genuinely edge-on to the camera.
					vec3 look = normalize(vp.xyz);
					vec3 ax = cross(along, look);
					float axl = length(ax);
					vec3 across = axl > 1e-4 ? ax / axl : vec3(1.0, 0.0, 0.0);

					float size = 0.6 + 0.8 * aDrop.w;
					float w = uWidth * size;
					// World size of one pixel at this depth.
					float px = uPxScale * max(-vp.z, 0.05);
					float wDraw = max(w, px * ${MIN_PX.toFixed(2)});
					vAlpha = uAlpha * size * (w / wDraw);
					// A drop close enough to touch is nowhere near focus: the lens
					// spreads it over a blur circle that grows as it approaches, and
					// spreading the same light over more of the frame is exactly
					// what makes the nearest drops a haze rather than the biggest,
					// brightest thing on screen. Without this the near half of the
					// box is a wall of fat rectangles.
					float depth = max(-vp.z, 0.01);
					vAlpha *= smoothstep(0.25, 1.0, depth);
					// And out at the far wall, so drops do not pop into existence at
					// the edge of a box the pilot is not supposed to notice.
					vAlpha *= 1.0 - smoothstep(${(BOX * 0.35).toFixed(2)}, ${(BOX * 0.5).toFixed(2)}, depth);
					vT = position.y;
					vX = position.x;

					vp.xyz += along * (position.y * uLength * size) + across * (position.x * wDraw);
					gl_Position = projectionMatrix * vp;
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uColor;
				in float vAlpha;
				in float vT;
				in float vX;
				out vec4 outColor;

				void main() {
					// Soft on both axes: an exposure does not start and stop with an
					// edge, and a drop is round, so a hard-cornered rectangle reads
					// as confetti rather than as water.
					float a = vAlpha
						* (1.0 - smoothstep(0.30, 0.5, abs(vT)))
						* (1.0 - smoothstep(0.15, 0.5, abs(vX)));
					outColor = vec4(uColor, a);
				}
			`,
		});

		this.mesh = new THREE.Mesh(geometry, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		this.mesh.renderOrder = 10;
		this.mesh.name = 'rainfall';
		this.mesh.visible = false;
		scene.add(this.mesh);

		this._offset = new THREE.Vector3();
		this._vel = new THREE.Vector3();
		this.drops = 0;
	}

	// heightPx is the framebuffer height in device pixels: gl_Position lands on
	// those, not on CSS pixels, and getting it wrong makes the minimum-width
	// clamp the wrong size on a HiDPI display — the same trap uResolution has
	// in lens.js.
	// The streaks are lit by the sky, so when the sky moves — rain darkening it,
	// fog whitening it — they have to move with it. Baked once at construction
	// until #21, which is why a downpour used to keep clear-sky streaks.
	setSky(sky) {
		const c = this.material.uniforms.uColor.value;
		c.copy(sky);
		c.r += LIFT; c.g += LIFT; c.b += LIFT;
	}

	setSize(heightPx, fovDeg) {
		this._pxScale = (2 * Math.tan((fovDeg * Math.PI) / 360)) / heightPx;
		this.material.uniforms.uPxScale.value = this._pxScale;
	}

	// rain is the RainField, wind is physics.wind.out, velocity is the drone's
	// ground velocity, shutter is the lens exposure in seconds. dt is zero when
	// the sim is frozen, which is all it takes to stop the rain dead.
	update({ rain, wind, velocity, shutter, dt, camera }) {
		if (!rain || rain.rate <= 0) {
			this.mesh.visible = false;
			this.mesh.geometry.instanceCount = 0;
			this.drops = 0;
			return;
		}

		// The rain's own velocity: it falls at terminal and goes where the air
		// goes. The wind is read, never invented — it is the field from #20,
		// gusts and turbulence included.
		this._vel.set(wind ? wind.x : 0, -rain.fallSpeed, wind ? wind.z : 0);
		if (wind) this._vel.y += wind.y;

		this._offset.addScaledVector(this._vel, dt);
		// Kept inside one box, so the offset never grows large enough for float32
		// to start losing millimetres out of kilometres.
		this._offset.set(
			((this._offset.x % BOX) + BOX) % BOX,
			((this._offset.y % BOX) + BOX) % BOX,
			((this._offset.z % BOX) + BOX) % BOX,
		);

		const u = this.material.uniforms;
		u.uOffset.value.copy(this._offset);
		u.uCam.value.copy(camera.position);
		u.uRel.value.set(
			this._vel.x - (velocity ? velocity.x : 0),
			this._vel.y - (velocity ? velocity.y : 0),
			this._vel.z - (velocity ? velocity.z : 0),
		);

		const relSpeed = u.uRel.value.length();
		const exposure = Math.max(shutter ?? 0, MIN_EXPOSURE);
		const length = Math.max(relSpeed * exposure, 1e-4);
		const width = rain.dropDiameter * 1e-3;
		u.uLength.value = length;
		u.uWidth.value = width * STREAK_WIDTH_GAIN;
		// From the true width, not the drawn one. How much of the exposure the
		// drop spends over any one point of the band it sweeps: it covers a point
		// for as long as it takes to travel its own diameter, out of the whole
		// streak. Everything about how rain looks with speed and shutter falls
		// out of this one ratio — fly faster and the streaks stretch and fade,
		// open the shutter and they do it again.
		u.uAlpha.value = Math.min(MAX_ALPHA, SCATTER_GAIN * (width / length));

		// Divided by the width exaggeration, so the screen area the rain covers is
		// the one the concentration asks for even though each streak is drawn
		// wider than life.
		this.drops = Math.min(MAX_DROPS,
			Math.round((rain.dropsPerM3 * BOX * BOX * BOX) / STREAK_WIDTH_GAIN));
		this.mesh.geometry.instanceCount = this.drops;
		this.mesh.visible = this.drops > 0;
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
