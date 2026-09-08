// The machine on the end screen, in 3D (D12). The flight is over; what is left
// is the drone, and you can turn it in your hands.
//
// This is NOT src/drone-portrait.js. That one is a wireframe <svg>, monochrome,
// and it stays: src/session-log.js is a pure client and the archive fiche must
// not drag Three in. Here we are already inside the sim — the renderer, the
// shaders and the mesh are all loaded — so the end screen shows the REAL mesh,
// the one that was flying a second ago, with its livery and its number.
//
// It owns its own scene, its own camera and its own WebGL context, because it
// must survive the flight scene being torn down. That context is the reason
// stop() is not optional: one leaked context per flight and the browser starts
// dropping the oldest one.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { shapeOf } from './drone-shape.js';
import { buildDroneMesh, setSun, setTime, setLedFade, setResolution } from './drone-mesh.js';
import { token } from './palette.js';
import { liveryColors } from '../tools/target-livery.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { VIEWER, viewerOrbit } from '../tools/drone-viewer-model.mjs';

const hex = (name) => new THREE.Color(token(name)).getHex();
const DEG = Math.PI / 180;

// A light from above and slightly behind the entry angle, so the three-quarter
// view lands on a lit face rather than a silhouette. Staging, not a sun
// position: nothing here pretends to be the sky the flight happened under.
const SUN = new THREE.Vector3(0.35, 0.85, 0.4).normalize();

// The mount, from the mesh's own bounding sphere: every family fits the frame
// the same way, and a bigger airframe does not overflow it.
const FOV_DEG = 32;
const MARGIN = 1.18;

export function droneViewer({ family, buildSeed, size = VIEWER.size, createRenderer } = {}) {
	if (!family || !buildSeed) return null;

	// The context first: everything below it is expensive, and a machine
	// without WebGL must cost nothing before falling back to the SVG.
	let renderer;
	try {
		renderer = (createRenderer ?? defaultRenderer)();
	} catch (err) {
		console.warn('[drone-viewer] no WebGL context, falling back to the portrait:', err);
		return null;
	}
	if (!renderer) return null;

	const build = targetBuild({ seed: buildSeed, family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: buildSeed, family }),
		// The same level the CHASE view uses (#283): blades, bells and hubs.
		// This is the closest anyone ever gets to the machine.
		detail: 'portrait',
	});
	const colors = {
		frame: hex('--dark-grey'), metal: hex('--grey'),
		prop: hex('--light-grey'), led: hex('--warm-white'),
		...liveryColors(build.livery),
	};
	const mesh = buildDroneMesh(shape, { colors });

	const scene = new THREE.Scene();
	scene.add(mesh.group);
	// DroneMaterial is a ShaderMaterial with its own sun uniform, so these two
	// light nothing on the body itself; they are here for anything a future
	// part of the mesh renders with a standard material, and they cost one
	// matrix each.
	const ambient = new THREE.AmbientLight(0xffffff, 0.6);
	const key = new THREE.DirectionalLight(0xffffff, 1.0);
	key.position.copy(SUN);
	scene.add(ambient, key);
	// Only the body material carries a sun; LedMaterial is emissive.
	setSun(mesh.material, SUN, 1, 0);
	// The LED is a screen-space sprite: without a resolution it divides by zero.
	setResolution(mesh.ledMaterial, size, size);
	setLedFade(mesh.ledMaterial, 0.1, 100);

	const radius = mesh.body.geometry.boundingSphere?.radius || 0.2;
	const distance = (radius * MARGIN) / Math.sin((FOV_DEG / 2) * DEG);
	const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, distance / 100, distance * 10);

	const el = document.createElement('div');
	el.className = 'drone-viewer';
	el.style.width = `${size}px`;
	el.style.height = `${size}px`;
	renderer.setPixelRatio?.(Math.min(globalThis.devicePixelRatio ?? 1, 2));
	renderer.setSize(size, size, false);
	renderer.setClearAlpha?.(0);
	renderer.domElement.style.width = `${size}px`;
	renderer.domElement.style.height = `${size}px`;
	el.appendChild(renderer.domElement);

	// The turn is OrbitControls' own: autoRotateSpeed is "one orbit every
	// 60 / speed seconds at 60 fps", so the pace stays derived from turnS and
	// there is a single source for it. Dragging interrupts it and resumes it,
	// which is exactly the gesture we want — take the machine, turn it, let go.
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableZoom = false;
	controls.enablePan = false;
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 60 / VIEWER.turnS;
	controls.target.set(0, 0, 0);

	// The entry angle, straight off the shared model: the same three-quarter
	// view the archive portrait opens on.
	const start = viewerOrbit({ tMs: 0 });
	const polar = (90 - start.polarDeg) * DEG;
	const azimuth = start.azimuthDeg * DEG;
	camera.position.setFromSphericalCoords(distance, polar, azimuth);
	controls.update();

	let raf = 0;
	let stopped = false;
	let t0 = 0;
	const frame = (ms) => {
		if (stopped) return;
		raf = requestAnimationFrame(frame);
		if (!t0) t0 = ms;
		// The props stay still: the machine is dead. Only uTime moves, for the
		// material's own shimmer.
		setTime(mesh.material, (ms - t0) / 1000);
		setTime(mesh.ledMaterial, (ms - t0) / 1000);
		controls.update();
		renderer.render(scene, camera);
	};
	renderer.render(scene, camera);
	raf = requestAnimationFrame(frame);

	// Idempotent: setFlightEnd() can clear the screen more than once, and a
	// double dispose on a real WebGLRenderer is not free.
	const stop = () => {
		if (stopped) return;
		stopped = true;
		cancelAnimationFrame(raf);
		controls.dispose();
		mesh.dispose();
		renderer.dispose();
		renderer.domElement.remove?.();
		el.remove?.();
	};

	return { el, stop };
}

function defaultRenderer() {
	const r = new THREE.WebGLRenderer({ alpha: true, antialias: true });
	r.setClearColor(0x000000, 0);
	return r;
}
