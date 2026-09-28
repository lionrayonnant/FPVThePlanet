// The hangar (issue #185, Signals lot 3, mockup clearance-v4.html): the seven
// machine classes in one row, grouped by the clearance that opens them. Open:
// the real mesh on a slow turntable. Locked: the same mesh as a flat dark
// silhouette, still, torn for a quarter of a second every few seconds, its
// name scrambled. Crossing a step (`reveal`): a warm-white line sweeps down
// once, the model above it, the silhouette below, then the name turns green.
//
// ONE WebGL context for the whole row: each machine is drawn into its own
// viewport/scissor rect of a single canvas laid over the row. A context per
// machine is how browsers start dropping them. The layout is the DOM's (the
// `.hangar-stage` slots); the canvas only follows it.
//
// The backdrop is the fence dome's living cyan/magenta/violet/electric mass.
// That is the demo palette on a daily screen — a deliberate exception, recorded
// in the Bible's "Signaux et habilitation" section and in
// tools/palette-selftest.mjs's allowlist. Nowhere else in this file.
//
// The renderer and the meshes are built lazily, on the first frame the hangar
// is actually on screen. A hangar that is hidden pauses; one that is detached
// after having been on screen frees itself on the next frame (the end screen
// and DATA rebuild their DOM and never call destroy() on a node they dropped).
// One not yet attached waits for its host however long that takes — the end
// screen builds its node before the line holding it has typed out — and its
// owner destroys it if it never shows (main.js endHangar, target-scan.js,
// briefing.js, terminal.js). The loop draws at ~30 fps: a slow turntable and
// a drifting backdrop gain nothing from 60 or 144.
import * as THREE from 'three';
import { shapeOf, RECIPE_PROFILES } from './drone-shape.js';
import { buildDroneMesh, setSun, setTime, setLedFade, setResolution } from './drone-mesh.js';
import { token } from './palette.js';
import { liveryColors } from '../tools/target-livery.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { VIEWER } from '../tools/drone-viewer-model.mjs';
import { hangarRows, progressParts, tiersParts } from '../tools/hangar-model.mjs';

const DEG = Math.PI / 180;
// One build seed for every hangar: the same individual of each family, on
// every screen, for every operator.
const NOMINAL_SEED = 'hangar::nominal';
const SUN = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
const FOV_DEG = 32;
const FILL = 1.05;              // the sphere's diameter against the slot's height: a flat
                                // airframe seen from 28° can overfill it
const MIN_ASPECT = 1.25;        // below this slot aspect, the width decides the framing
const TURN_S = 20;              // one turn of the turntable
const TEAR_PERIOD_S = 4.2;      // a locked machine tears this often…
const TEAR_S = 0.25;            // …for this long
const TEAR_STAGGER_S = 1.37;    // and never two at once
const TEAR_DX = [0, 7, -5, 3, -8, 4];   // px at a 106 px tall slot, per slice
const REVEAL_DELAY_S = 0.5;     // the eye lands before the sweep starts
const REVEAL_S = 1.2;
const PAUSE_POLL_MS = 250;
const FRAME_MS = 1000 / 30;     // the loop's cap…
const FRAME_SLACK_MS = 2;       // …less the vsync jitter, so 60 Hz paints every other frame

const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};
const txt = (s) => document.createTextNode(s);

// `▓▓▓░░░░░░░░░  9/18 TO CLEARANCE 2` (or `CLEARANCE 3 · MAX`), the bar in its
// own yellow span. `prefix` is the caller's lead-in, same line.
export function progressNode(store, { prefix = '', cls = 'hangar-line' } = {}) {
	const { bar, text } = progressParts(store);
	const p = el('pre', cls);
	if (prefix) p.append(txt(prefix));
	if (bar) p.append(el('span', 'hangar-bar', bar), txt(`  ${text}`));
	else p.append(txt(text));
	return p;
}

// `SIGNALS   TIER I · TIER II   TIER III AT CLEARANCE 2`, the closed tier faint.
export function tiersNode(store, { cls = 'hangar-line' } = {}) {
	const { open, locked } = tiersParts(store);
	const p = el('pre', cls);
	p.append(txt('SIGNALS   '), el('span', 'hangar-tier-open', open));
	if (locked) p.append(txt('   '), el('span', 'hangar-tier-locked', locked));
	return p;
}

function defaultRenderer() {
	const r = new THREE.WebGLRenderer({ alpha: true, antialias: true });
	r.setClearColor(0x000000, 0);
	return r;
}

const hexOf = (name) => new THREE.Color(token(name)).getHex();
// A token's sRGB components, whether or not THREE.ColorManagement is on (the
// game turns it off, main.js): the backdrop's rgba() and the silhouette
// shader both want the values as written in tokens.css.
const srgbOf = (color) => {
	const t = { r: 0, g: 0, b: 0 };
	color.getRGB(t, THREE.SRGBColorSpace);
	return t;
};

// A family's nominal machine, as drone-viewer.js builds it: same shape path,
// same livery for the same seed. Returns buildDroneMesh()'s handle.
function familyMesh(family) {
	const build = targetBuild({ seed: NOMINAL_SEED, family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: NOMINAL_SEED, family }),
		detail: 'portrait',
	});
	const mesh = buildDroneMesh(shape, { colors: {
		frame: hexOf('--dark-grey'), metal: hexOf('--grey'),
		prop: hexOf('--light-grey'), led: hexOf('--warm-white'),
		...liveryColors(build.livery),
	} });
	return mesh;
}

// The swarm as it flies: the node in the middle, six units around it.
function swarmMeshes() {
	const node = familyMesh('swarmNode');
	const unitSeed = `${NOMINAL_SEED}::unit`;
	const shape = shapeOf({
		profile: RECIPE_PROFILES.swarmUnit,
		build: {},
		camera: targetCamera({ seed: unitSeed, family: RECIPE_PROFILES.swarmUnit.family }),
	});
	const colors = { frame: hexOf('--dark-grey'), metal: hexOf('--grey'), prop: hexOf('--light-grey'), led: hexOf('--warm-white') };
	const nodeR = node.body.geometry.boundingSphere?.radius || 0.2;
	const units = [];
	for (let k = 0; k < 6; k++) {
		const u = buildDroneMesh(shape, { colors });
		const a = (k + 0.5) * Math.PI / 3;
		const holder = new THREE.Group();
		holder.position.set(Math.cos(a) * nodeR * 2.1, (k % 2 ? 0.3 : -0.3) * nodeR, Math.sin(a) * nodeR * 2.1);
		// Drawn a little larger than life: at the hangar's scale a unit would be a speck.
		holder.scale.setScalar(1.25);
		holder.rotation.y = -a;
		holder.add(u.group);
		units.push({ mesh: u, holder });
	}
	return { node, units };
}

// The silhouette: the body's own material with its colour replaced by one
// flat tone, so the blades stay blades (DroneMaterial hides the prop disc of
// a stopped rotor; a MeshBasicMaterial would draw it as a solid plate). All
// silhouettes share `uSil`, which the tear brightens for a few frames.
const SIL_OUT = /outColor = vec4\(mix\(c, uFogColor, clamp\(f, 0\.0, 1\.0\)\), a\);/;
function silhouetteOf(lit, uSil) {
	if (!SIL_OUT.test(lit.fragmentShader) || !lit.fragmentShader.includes('uniform float uTime;')) {
		return new THREE.MeshBasicMaterial({ color: uSil.value });
	}
	const m = lit.clone();
	m.uniforms.uSil = uSil;
	m.transparent = false;
	m.fragmentShader = lit.fragmentShader
		.replace('uniform float uTime;', 'uniform float uTime;\nuniform vec3 uSil;')
		.replace(SIL_OUT, 'outColor = vec4(uSil, 1.0);');
	return m;
}

// One slot of the row: the machine's pivot, its bodies (whose material swaps
// between lit and silhouette) and its LEDs (hidden on the silhouette).
function buildSlot(id, uSil) {
	const pivot = new THREE.Group();
	const inner = new THREE.Group();
	pivot.add(inner);
	const meshes = [];
	if (id === 'swarm') {
		const { node, units } = swarmMeshes();
		inner.add(node.group);
		meshes.push(node);
		for (const u of units) { inner.add(u.holder); meshes.push(u.mesh); }
	} else {
		const m = familyMesh(id);
		inner.add(m.group);
		meshes.push(m);
	}
	for (const m of meshes) {
		setSun(m.material, SUN, 1, 0);
		setLedFade(m.ledMaterial, 0.1, 1000);
	}
	// Every machine fills its slot the same way: normalised by its own
	// bounding box, so a toothpick and a heavy 5" read at the same size.
	// The bodies only: an LED is a 1 m screen-space quad and would swallow
	// the box.
	inner.updateMatrixWorld(true);
	const box = new THREE.Box3();
	for (const m of meshes) {
		m.body.geometry.computeBoundingBox();
		box.union(m.body.geometry.boundingBox.clone().applyMatrix4(m.body.matrixWorld));
	}
	const sphere = box.getBoundingSphere(new THREE.Sphere());
	const r = sphere.radius || 0.2;
	inner.position.copy(sphere.center).multiplyScalar(-1 / r);
	inner.scale.setScalar(1 / r);
	return {
		id, pivot,
		bodies: meshes.map((m) => ({ mesh: m.body, lit: m.material, sil: silhouetteOf(m.material, uSil) })),
		leds: meshes.map((m) => m.led),
		materials: meshes.flatMap((m) => [m.material, m.ledMaterial]),
		ledMaterials: meshes.map((m) => m.ledMaterial),
		dispose() {
			for (const b of this.bodies) b.sil.dispose();
			for (const m of meshes) m.dispose();
		},
	};
}

// `createRenderer` is for the selftest (no WebGL in Node): a throw or a null
// leaves the row as labels only, which is also what a browser without WebGL
// shows.
export function mountHangar(host, { store, reveal = null, compact = false, createRenderer = defaultRenderer } = {}) {
	const rows = hangarRows(store, reveal);

	// --- DOM: the row, grouped, a slot per machine --------------------------
	const root = el('div', compact ? 'hangar hangar-compact' : 'hangar');
	const wrap = el('div', 'hangar-wrap');
	const bg = el('canvas', 'hangar-bg');
	const row = el('div', 'hangar-row');
	const slots = [];
	let index = 0;
	for (const r of rows) {
		const grp = el('div', 'hangar-grp');
		// Full size, the row takes the column and each group its share of it;
		// compact, the slots keep their fixed width.
		if (!compact) grp.style.flexGrow = String(r.machines.length);
		const lv = el('div', 'hangar-lv');
		lv.append(el('span', null, `CLEARANCE ${r.level}`), el('span', r.open ? 'hangar-mark-open' : 'hangar-mark-cost', r.mark));
		const bay = el('div', 'hangar-bay');
		for (const m of r.machines) {
			const state = m.justOpened ? 'reveal' : m.open ? 'open' : 'locked';
			const slot = el('div', 'hangar-m');
			slot.dataset.state = state;
			const stage = el('div', 'hangar-stage');
			const name = el('div', 'hangar-n', m.shown);
			let scan = null;
			if (state === 'reveal') {
				scan = el('div', 'hangar-scan');
				scan.hidden = true;
				stage.appendChild(scan);
			}
			slot.append(stage, name);
			bay.appendChild(slot);
			slots.push({ id: m.id, state, stage, name, scan, index: index++, gl: null, revealDone: false });
		}
		grp.append(lv, bay);
		row.appendChild(grp);
	}
	wrap.append(bg, row, el('div', 'hangar-floor'));
	root.appendChild(wrap);
	host.appendChild(root);

	// --- state --------------------------------------------------------------
	const handle = { destroyed: false, destroy };
	let raf = 0;
	let timer = null;
	let seen = false;          // on screen at least once: from then on, a detach frees it
	let lastPaint = null;
	let t0 = null;
	let revealAt = null;
	let gl = null;       // { renderer, scene, camera, uSil, silFlat, silBright, distance } once built
	let glFailed = false;
	let bgCtx = null;
	let bgFailed = false;
	let bgSize = [0, 0];
	let glSize = [0, 0];
	let blobs = null;

	// --- the loop ------------------------------------------------------------
	const schedule = () => {
		if (handle.destroyed || raf || timer) return;
		raf = requestAnimationFrame(frame);
	};
	const pause = () => {
		if (handle.destroyed || timer) return;
		timer = setTimeout(() => { timer = null; schedule(); }, PAUSE_POLL_MS);
		// Node (the selftests): a paused hangar must not keep the process alive.
		timer?.unref?.();
	};

	function frame(ms) {
		raf = 0;
		if (handle.destroyed) return;
		if (!host.isConnected || !root.isConnected) {
			if (seen) { destroy(); return; }
			pause();
			return;
		}
		seen = true;
		if (document.hidden || root.checkVisibility?.() === false) { pause(); return; }
		if (lastPaint !== null && ms - lastPaint < FRAME_MS - FRAME_SLACK_MS) { schedule(); return; }
		lastPaint = ms;
		if (t0 === null) t0 = ms;
		const t = (ms - t0) / 1000;
		if (revealAt === null) revealAt = t + REVEAL_DELAY_S;
		paintNames(t);
		paintBackdrop(ms);
		paintMachines(t);
		schedule();
	}

	// The reveal's name: plain and faint during the sweep, green once it is over.
	function paintNames(t) {
		for (const s of slots) {
			if (s.state !== 'reveal' || s.revealDone) continue;
			const p = (t - revealAt) / REVEAL_S;
			if (s.scan) {
				s.scan.hidden = !(p >= 0 && p < 1);
				if (p >= 0 && p < 1) s.scan.style.top = `${(p * 100).toFixed(2)}%`;
			}
			if (p >= 1) {
				s.revealDone = true;
				s.name.classList.add('is-new');
				if (s.scan) s.scan.hidden = true;
			}
		}
	}

	// --- the backdrop: 2D, additive blobs, slow veins, scanlines -------------
	function paintBackdrop(ms) {
		if (bgFailed) return;
		if (!bgCtx) {
			bgCtx = bg.getContext?.('2d') ?? null;
			if (!bgCtx) { bgFailed = true; return; }
			const cols = ['--magenta', '--cyan', '--electric', '--violet'].map((n) => {
				const c = srgbOf(new THREE.Color(token(n)));
				return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
			});
			// Seeded by index, not Math.random(): the same backdrop every time.
			blobs = Array.from({ length: 7 }, (_, i) => ({
				c: cols[i % 4], x: (i * 0.37 + 0.11) % 1, y: (i * 0.53 + 0.29) % 1,
				r: 0.25 + ((i * 0.41) % 1) * 0.3,
				sx: (((i * 0.61) % 1) - 0.5) * 0.0075, sy: (((i * 0.83) % 1) - 0.5) * 0.006,
				p: i * 0.9,
			}));
			blobs.cols = cols;
			const k = srgbOf(new THREE.Color(token('--black')));
			blobs.black = `${Math.round(k.r * 255)},${Math.round(k.g * 255)},${Math.round(k.b * 255)}`;
		}
		const W = wrap.clientWidth | 0, H = wrap.clientHeight | 0;
		if (!W || !H) return;
		if (W !== bgSize[0] || H !== bgSize[1]) { bg.width = W; bg.height = H; bgSize = [W, H]; }
		const x = bgCtx;
		const s = ms / 1000;
		x.globalCompositeOperation = 'source-over';
		x.fillStyle = `rgb(${blobs.black})`;
		x.fillRect(0, 0, W, H);
		x.globalCompositeOperation = 'lighter';
		for (const b of blobs) {
			const px = (((b.x + b.sx * s) % 1) + 1) % 1 * W;
			const py = (((b.y + b.sy * s) % 1) + 1) % 1 * H;
			const R = b.r * Math.max(W, H) * (0.9 + 0.1 * Math.sin(ms / 1400 + b.p));
			const g = x.createRadialGradient(px, py, 0, px, py, R);
			// .28 washed the row lavender over the locked silhouettes; .14 lost
			// the dome's colours and the silhouettes' contrast with them.
			g.addColorStop(0, `rgba(${b.c},.20)`);
			g.addColorStop(1, `rgba(${b.c},0)`);
			x.fillStyle = g;
			x.fillRect(0, 0, W, H);
		}
		x.lineWidth = 1;
		for (let k = 0; k < 5; k++) {
			x.strokeStyle = `rgba(${blobs.cols[k % 4]},.07)`;
			x.beginPath();
			for (let i = 0; i <= 40; i++) {
				const u = i / 40;
				const yy = H * (0.2 + 0.15 * k) + Math.sin(u * 9 + ms / 1800 + k) * 14 + Math.sin(u * 23 - ms / 1100) * 5;
				if (i) x.lineTo(u * W, yy); else x.moveTo(0, yy);
			}
			x.stroke();
		}
		// Faint horizontal scanlines on top: one dark pixel row in three.
		x.globalCompositeOperation = 'source-over';
		x.fillStyle = `rgba(${blobs.black},.25)`;
		for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
	}

	// --- the machines: one context, a viewport per slot ----------------------
	function buildGl() {
		let renderer = null;
		try { renderer = createRenderer(); } catch (err) {
			console.warn('[hangar] no WebGL context, labels only:', err);
		}
		if (!renderer) { glFailed = true; return; }
		const canvas = renderer.domElement;
		canvas.className = 'hangar-gl';
		wrap.appendChild(canvas);
		renderer.setPixelRatio?.(Math.min(globalThis.devicePixelRatio ?? 1, 2));
		renderer.autoClear = false;
		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(FOV_DEG, 132 / 106, 0.05, 100);
		const distance = 1 / (FILL * Math.tan((FOV_DEG / 2) * DEG));
		// The drone viewer's three-quarter angle, from slightly above.
		camera.position.setFromSphericalCoords(distance, (90 - VIEWER.pitchDeg) * DEG, VIEWER.startDeg * DEG);
		camera.lookAt(0, 0, 0);
		const silColor = new THREE.Color(token('--grey')).lerp(new THREE.Color(token('--light-grey')), 0.23);
		const silBright = srgbOf(silColor.clone().lerp(new THREE.Color(token('--light-grey')), 0.45));
		const silFlat = srgbOf(silColor);
		const uSil = { value: new THREE.Color() };
		uSil.value.r = silFlat.r; uSil.value.g = silFlat.g; uSil.value.b = silFlat.b;
		for (const s of slots) {
			try {
				s.gl = buildSlot(s.id, uSil);
				s.gl.pivot.visible = false;
				scene.add(s.gl.pivot);
			} catch (err) {
				console.warn(`[hangar] ${s.id}: no mesh`, err);
				s.gl = null;
			}
		}
		gl = { renderer, scene, camera, uSil, silFlat, silBright, distance };
	}

	// `look`: null = lit, 'sil' = the silhouette, 'bright' = the silhouette
	// during the first frames of a tear.
	const setLook = (slot, look) => {
		for (const b of slot.gl.bodies) b.mesh.material = look ? b.sil : b.lit;
		for (const l of slot.gl.leds) l.visible = !look;
		// The shader writes uSil as is, with no output conversion: sRGB values,
		// set raw (setRGB would convert them when ColorManagement is on).
		if (look) {
			const c = look === 'bright' ? gl.silBright : gl.silFlat;
			gl.uSil.value.r = c.r; gl.uSil.value.g = c.g; gl.uSil.value.b = c.b;
		}
	};

	function paintMachines(t) {
		if (glFailed) return;
		if (!gl) { buildGl(); if (!gl) return; }
		const { renderer, scene, camera } = gl;
		const W = wrap.clientWidth, H = wrap.clientHeight;
		if (!W || !H) return;
		if (W !== glSize[0] || H !== glSize[1]) { renderer.setSize(W, H, false); glSize = [W, H]; }
		const dpr = renderer.getPixelRatio?.() ?? 1;
		const c = renderer.domElement.getBoundingClientRect();
		renderer.setScissorTest(false);
		renderer.clear();
		renderer.setScissorTest(true);
		const spin = -(t / TURN_S) * Math.PI * 2;
		for (const s of slots) {
			if (!s.gl) continue;
			const r = s.stage.getBoundingClientRect();
			const x = r.left - c.left, w = r.width, h = r.height;
			const y = H - (r.top - c.top) - h;          // WebGL counts from the bottom
			if (w < 2 || h < 2) continue;
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
			// A slot narrower than the machine's three-quarter view pulls
			// the camera back rather than cropping the props.
			camera.position.setLength(gl.distance / Math.min(1, camera.aspect / MIN_ASPECT));
			for (const m of s.gl.materials) setTime(m, t);
			for (const m of s.gl.ledMaterials) setResolution(m, w * dpr, h * dpr);
			for (const o of slots) if (o.gl) o.gl.pivot.visible = o === s;
			const pass = (look, sx, sy, sw, sh, dx = 0) => {
				if (sw <= 0 || sh <= 0) return;
				setLook(s, look);
				renderer.setViewport(x + dx, y, w, h);
				renderer.setScissor(sx, sy, sw, sh);
				renderer.render(scene, camera);
			};
			if (s.state === 'locked') {
				s.gl.pivot.rotation.y = 0;
				const phase = (t + s.index * TEAR_STAGGER_S) % TEAR_PERIOD_S;
				if (phase < TEAR_S) {
					// The tear: the silhouette redrawn in six horizontal slices,
					// each shifted sideways — a second pass, same context.
					const k = h / 106;
					const band = h / TEAR_DX.length;
					const mat = phase < TEAR_S * 0.35 ? 'bright' : 'sil';
					TEAR_DX.forEach((dx, i) => {
						const flip = phase > TEAR_S * 0.6 ? -0.5 : 1;
						pass(mat, x, y + h - (i + 1) * band, w, Math.ceil(band) + 1, dx * k * flip);
					});
				} else pass('sil', x, y, w, h);
				continue;
			}
			s.gl.pivot.rotation.y = spin;
			if (s.state === 'reveal' && !s.revealDone) {
				const p = Math.max(0, Math.min(1, (t - revealAt) / REVEAL_S));
				const cut = h * (1 - p);                  // the line, from the bottom
				pass(null, x, y + cut, w, h - cut);       // above it: the model
				pass('sil', x, y, w, cut);               // below it: the silhouette
				continue;
			}
			pass(null, x, y, w, h);
		}
		renderer.setScissorTest(false);
	}

	function destroy() {
		if (handle.destroyed) return;
		handle.destroyed = true;
		if (raf) cancelAnimationFrame(raf);
		if (timer) clearTimeout(timer);
		raf = 0; timer = null;
		if (gl) {
			for (const s of slots) s.gl?.dispose();
			gl.renderer.dispose();
			// dispose() leaves the context alive until GC; browsers cap live
			// contexts (16 in Chrome) and drop the OLDEST — the game's own.
			gl.renderer.forceContextLoss?.();
			gl.renderer.domElement.remove?.();
			gl = null;
		}
		root.remove();
	}

	if (typeof requestAnimationFrame === 'function') schedule();
	return handle;
}
