import * as THREE from 'three';
import { createTileMaterial, createArrayTexture } from './TileMaterial.js';

// Absolute, because the worker resolves relative URLs against /src/, not the
// page. import.meta.env.BASE_URL keeps this correct under a deployed subpath.
// Vite inlines it at build time; under bare Node — the selftests import this
// module — `import.meta.env` does not exist, hence the fallback to the root.
const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';

// A MISSING FILE DOES NOT ANSWER 404. Vite, and any static host with an SPA
// fallback, rewrites the unknown request to index.html and answers 200
// text/html. `res.ok` therefore says NOTHING about the file being there —
// measured: a missing scene and an installed one both answer 200, and differ
// only by content type (issue #275). Without this check the `res.json()` that
// follows dies on "Unexpected token '<'", and the player is handed an error
// that names nothing.
function servedJson(res) {
	return res.ok && (res.headers.get('content-type') || '').includes('json');
}

// A scene's URL prefix. Explicit, and CAPTURED when a load starts rather than
// re-read per request: the TARGET SCAN is cancellable (back to the zone
// choice), and a preload already in flight must go on reading ITS scene even
// if the player picks another one meanwhile. A mutable global made that mix
// possible — which is why there is none.
export function sceneBase(slug) {
	return `${BASE}scenes/${slug}/`;
}

// Lists maps prepared with tools/add-map.mjs, for the pre-flight menu.
export async function loadSceneList() {
	const res = await fetch(`${BASE}scenes.json`);
	if (!servedJson(res)) throw new Error(`scenes.json not found (HTTP ${res.status}, ${res.headers.get('content-type') || 'no type'}) — run "npm run add-map" first`);
	const all = await res.json();
	// Guard: skip the scenes whose folder is not physically there (typically
	// after a fresh clone, where scenes.json is committed but public/scenes/ is
	// not — it is gitignored). A HEAD tells what the server really serves, but
	// the TYPE is what has to be read, not the status: on `r.ok` alone this
	// filter never filtered anything, and it is what let the player pick a
	// phantom scene (issue #275).
	const checks = await Promise.all(all.map(async (s) => {
		try {
			const r = await fetch(sceneBase(s.slug) + 'manifest.json', { method: 'HEAD' });
			return servedJson(r) ? s : null;
		} catch {
			return null;
		}
	}));
	const present = checks.filter(Boolean);
	if (present.length < all.length) {
		const missing = all.filter((s, i) => !checks[i]).map((s) => s.slug);
		console.warn(`[loader] ${missing.length} scene(s) listed in scenes.json but missing from disk: ${missing.join(', ')}`);
	}
	return present;
}

export async function loadManifest(base) {
	const res = await fetch(base + 'manifest.json');
	// The message has to name WHAT is missing: it is all the player sees on the
	// loading screen when the boot fails.
	if (!servedJson(res)) throw new Error(`${base}manifest.json : scene not installed (HTTP ${res.status}, ${res.headers.get('content-type') || 'no type'}) — run "npm run add-map", or "node tools/sync-scenes.mjs" if scenes.json has drifted from disk`);
	return res.json();
}

// Chunk downloads run in workers so fetching and JPEG decoding overlap. Each
// worker holds ~135MB while unpacking its sheet, so only a few run at once.
const MAX_CONCURRENT = 3;
// A tile worker that has said nothing for this long is taken for dead. Chrome
// kills a worker that runs out of memory WITHOUT firing worker.onerror (issue
// #249): without this delay loadOne() never settled and the loading screen sat
// on "tiles 1/2..." forever. Measured: decoding one sheet takes 0.3-0.9 s; 60 s
// leaves the margin a slow machine needs.
const WORKER_SILENCE_MS = 60_000;

// One material per chunk, all sharing the same fog. Kept so the weather can
// move it after load: the rain (#24) scales the density with the intensity, and
// the fog instalment (#21) will take the same handle rather than growing a
// second one.
const tileMaterials = [];

// Drops materials from tileMaterials when their chunks are freed (issue #147):
// `push` alone kept them there forever, and with them `uniforms.uMap.value` —
// the `DataArrayTexture` whose `.image.data` (the pixel buffer, ~135 MB per
// zone) is NOT freed by `texture.dispose()`, which only signals the renderer on
// the GPU side and never touches the JS data. Without this removal a zone that
// was preloaded then abandoned never gives its memory back, and
// setFog()/setNight()/setDim() iterate over dead materials as well as live ones
// on every weather frame.
export function releaseTileMaterials(materials) {
	for (const m of materials) {
		const i = tileMaterials.indexOf(m);
		if (i !== -1) tileMaterials.splice(i, 1);
	}
}

// The distant ground (#139) follows exactly the same weather as the tiles —
// otherwise the horizon line doubles. Registered rather than imported: loader.js
// must know nothing more about THREE than it already does.
let distantGround = null;
export function setDistantGround(g) { distantGround = g; }

// color is a THREE.Color or a hex; density is the exp-squared coefficient in
// TileMaterial.js. Both are written straight through — the whole colour pipeline
// is pass-through (main.js, HANDOFF bug #10), so anything converted here comes
// out wrong.
export function setFog(color, density) {
	for (const m of tileMaterials) {
		if (color !== undefined) m.uniforms.uFogColor.value.set(color);
		if (density !== undefined) m.uniforms.uFogDensity.value = density;
	}
	distantGround?.setFog(color, density);
}

// Night depth (#112). Same shape as setDim: the model lives in sun.js
// (nightAmount), this file only pushes it onto each chunk.
export function setNight(night) {
	for (const m of tileMaterials) m.uniforms.uNight.value = night;
	distantGround?.setNight(night);
}

// Cloud dimming (#22). Same shape as setFog: the model lives in cloud.js, this
// file only pushes it onto each chunk.
export function setDim(dim) {
	for (const m of tileMaterials) m.uniforms.uDim.value = dim;
	distantGround?.setDim(dim);
}

export function loadChunks(manifest, base, { fogColor, fogDensity, maxChunks = Infinity, mipmaps = true, anisotropy = 8 }, onProgress) {
	const { cellSize, cellsPerRow } = manifest;
	const chunks = manifest.chunks.slice(0, maxChunks);
	const meshes = new Array(chunks.length);
	const timings = new Array(chunks.length);
	const totalBytes = chunks.reduce((s, c) => s + c.geoBytes + c.texBytes, 0);
	let bytes = 0;
	let done = 0;
	let decoding = 0;
	// The workers alive right now. A chunk that fails rejects the whole load, and
	// without this its siblings went on decoding into a scene nobody would mount
	// — three workers at ~135 MB each, held for as long as they took to finish.
	const live = new Set();
	// The materials THIS load created. tileMaterials is module-level, so a load
	// that never reaches main.js has no other owner to release it: the same trap
	// as #147, on the failure path rather than the abandoned-preload one.
	const mine = [];

	const report = () => onProgress?.({
		bytes, totalBytes, done, total: chunks.length, decoding,
	});

	const loadOne = (chunk, index) => new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
		live.add(worker);
		let watchdog = null;
		// Whether this worker has announced its decoding stage. The counter is
		// what the loading screen prints, and it was incremented on that one
		// message but decremented on EVERY terminal message — including the
		// `ok:false` a worker sends when the fetch failed before decoding ever
		// started. One 404 sheet and the screen read "DECODING -1 SHEET(S)".
		let announced = false;
		// One way out for all three endings (done, failed, gone silent), so the
		// counter and the live set cannot drift apart.
		const stop = () => {
			clearTimeout(watchdog);
			if (announced) { announced = false; decoding--; }
			live.delete(worker);
			worker.terminate();
		};
		const arm = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				stop();
				report();
				reject(new Error(`chunk ${index}: tile worker silent for ${WORKER_SILENCE_MS / 1000} s — out of memory? close the game's other tabs, then reload`));
			}, WORKER_SILENCE_MS);
		};
		arm();
		worker.onerror = (e) => { stop(); report(); reject(new Error(`chunk ${index}: ${e.message}`)); };
		worker.onmessage = (e) => {
			const msg = e.data;
			arm();
			if (msg.progress) { bytes += msg.progress; report(); return; }
			if (msg.stage === 'decoding') { announced = true; decoding++; report(); return; }

			stop();
			if (!msg.ok) { report(); return reject(new Error(`chunk ${index}: ${msg.error}`)); }

			const g = msg.geometry;
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
			geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
			geometry.setAttribute('aLayer', new THREE.BufferAttribute(g.layers, 1));
			geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));

			const b = chunk.bbox;
			geometry.boundingBox = new THREE.Box3(
				new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
			geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

			const texture = createArrayTexture(msg.pixels, msg.cell, g.layerCount, { mipmaps, anisotropy });
			const material = createTileMaterial(texture, fogColor, fogDensity, manifest.bbox);
			tileMaterials.push(material);
			mine.push(material);
			const mesh = new THREE.Mesh(geometry, material);
			mesh.frustumCulled = true;
			mesh.name = `chunk${index}`;
			meshes[index] = mesh;
			timings[index] = msg.timing;

			done++;
			report();
			resolve();
		};
		worker.postMessage({
			index, baseUrl: base,
			geo: chunk.geo, tex: chunk.tex,
			cell: cellSize, cellsPerRow,
		});
	});

	// Simple pool: keep MAX_CONCURRENT workers busy until every chunk is done.
	let next = 0;
	// A failure stops the pool from starting anything new. Promise.all rejects on
	// the first one, but its siblings' runner loops do not know that.
	let failed = false;
	const runners = Array.from({ length: Math.min(MAX_CONCURRENT, chunks.length) }, async () => {
		for (;;) {
			const i = next++;
			if (failed || i >= chunks.length) return;
			try {
				await loadOne(chunks[i], i);
			} catch (e) {
				failed = true;
				throw e;
			}
		}
	});

	// A load that fails owns nothing afterwards: whoever called it gets an error,
	// not a half-built scene, so nothing downstream will ever free this.
	const abandon = () => {
		for (const w of live) w.terminate();
		live.clear();
		releaseTileMaterials(mine);
		for (const m of mine) {
			m.uniforms?.uMap?.value?.dispose();
			m.dispose();
		}
		mine.length = 0;
		for (const mesh of meshes) mesh?.geometry?.dispose();
		meshes.length = 0;
	};

	return Promise.all(runners).then(() => ({ meshes, timings }), (err) => {
		abandon();
		throw err;
	});
}

export async function loadCollision(manifest, base, onProgress) {
	const res = await fetch(base + manifest.collision.file);
	// The same trap as the manifest (issue #275): when it is missing, this binary
	// arrives as 200 text/html. Without this check the game's own index.html gets
	// decoded as a soup of triangles, and the failure surfaces far later, with no
	// visible connection to its cause. The real file is served as octet-stream.
	if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
		throw new Error(`${manifest.collision.file} : collision not found (HTTP ${res.status}, ${res.headers.get('content-type') || 'no type'}) — incomplete scene, re-run "npm run prep"`);
	}

	// ~90MB: stream it so the loading screen can show real progress.
	const total = Number(res.headers.get('content-length')) || 0;
	const reader = res.body.getReader();
	const parts = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		received += value.length;
		if (total) onProgress?.(received / total, received);
	}
	const buf = new Uint8Array(received);
	let off = 0;
	for (const p of parts) { buf.set(p, off); off += p.length; }

	const head = new DataView(buf.buffer);
	const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
	if (magic !== 'FPVC') throw new Error(`bad collision magic: ${magic}`);
	const vertexCount = head.getUint32(8, true);
	const indexCount = head.getUint32(12, true);

	return {
		vertices: new Float32Array(buf.buffer, 16, vertexCount * 3),
		indices: new Uint32Array(buf.buffer, 16 + vertexCount * 12, indexCount),
	};
}
