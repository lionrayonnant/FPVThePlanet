import * as THREE from 'three';
import { createTileMaterial, createArrayTexture } from './TileMaterial.js';

// Absolute, because the worker resolves relative URLs against /src/, not the
// page. import.meta.env.BASE_URL keeps this correct under a deployed subpath.
// Le préfixe d'URL d'une scène. Explicite, et CAPTURÉ au départ d'un
// chargement plutôt que relu à chaque requête : le TARGET SCAN est annulable
// (retour au choix de zone), et un préchargement déjà en vol doit continuer de
// lire SA scène même si le joueur en désigne une autre entre-temps. Un global
// mutable rendait ce mélange possible — d'où sa disparition.
export function sceneBase(slug) {
	return `${import.meta.env.BASE_URL}scenes/${slug}/`;
}

// Lists maps prepared with tools/add-map.mjs, for the pre-flight menu.
export async function loadSceneList() {
	const res = await fetch(`${import.meta.env.BASE_URL}scenes.json`);
	if (!res.ok) throw new Error(`scenes.json: HTTP ${res.status} — run "npm run add-map" first`);
	const all = await res.json();
	// Garde-fou : ignorer les scènes dont le dossier n'existe pas physiquement
	// (typiquement après un clone fresh où scenes.json est commité mais pas
	// public/scenes/, qui est dans .gitignore).  fetch HEAD est plus fiable
	// qu'une simple existence de fichier : il vérifie ce que le serveur statique
	// sert réellement.
	const checks = await Promise.all(all.map(async (s) => {
		try {
			const r = await fetch(sceneBase(s.slug) + 'manifest.json', { method: 'HEAD' });
			return r.ok ? s : null;
		} catch {
			return null;
		}
	}));
	const present = checks.filter(Boolean);
	if (present.length < all.length) {
		const missing = all.filter((s, i) => !checks[i]).map((s) => s.slug);
		console.warn(`[loader] ${missing.length} scène(s) listée(s) dans scenes.json mais absente(s) du disque : ${missing.join(', ')}`);
	}
	return present;
}

export async function loadManifest(base) {
	const res = await fetch(base + 'manifest.json');
	if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status} — run "npm run add-map" (or "npm run prep") first`);
	return res.json();
}

// Chunk downloads run in workers so fetching and JPEG decoding overlap. Each
// worker holds ~135MB while unpacking its sheet, so only a few run at once.
const MAX_CONCURRENT = 3;

// One material per chunk, all sharing the same fog. Kept so the weather can
// move it after load: the rain (#24) scales the density with the intensity, and
// the fog instalment (#21) will take the same handle rather than growing a
// second one.
const tileMaterials = [];

// Retire des matières de tileMaterials quand leurs chunks sont libérés (issue
// #147) : `push` seul les y gardait pour toujours, avec elles
// `uniforms.uMap.value` → le `DataArrayTexture` dont `.image.data` (le buffer
// de pixels, ~135 Mo par zone) n'est PAS libéré par `texture.dispose()` — ce
// dernier ne fait que signaler le renderer côté GPU, il ne touche pas à la
// donnée JS. Sans ce retrait, une zone préchargée puis abandonnée ne rend
// jamais sa mémoire, et setFog()/setNight()/setDim() itèrent chaque frame de
// météo sur des matières mortes en plus des vivantes.
export function releaseTileMaterials(materials) {
	for (const m of materials) {
		const i = tileMaterials.indexOf(m);
		if (i !== -1) tileMaterials.splice(i, 1);
	}
}

// Le sol lointain (#139) suit exactement la même météo que les tuiles — sinon
// la ligne d'horizon se dédouble. Enregistré plutôt qu'importé : loader.js ne
// doit rien savoir de THREE au-delà de ce qu'il fait déjà.
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

// La profondeur de nuit (#112). Même forme que setDim : le modèle vit dans
// sun.js (nightAmount), ce fichier ne fait que le pousser sur chaque chunk.
export function setNight(night) {
	for (const m of tileMaterials) m.uniforms.uNight.value = night;
	distantGround?.setNight(night);
}

// L'assombrissement des nuages (#22). Même forme que setFog : le modèle vit
// dans cloud.js, ce fichier ne fait que le pousser sur chaque chunk.
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

	const report = () => onProgress?.({
		bytes, totalBytes, done, total: chunks.length, decoding,
	});

	const loadOne = (chunk, index) => new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
		worker.onerror = (e) => { worker.terminate(); reject(new Error(`chunk ${index}: ${e.message}`)); };
		worker.onmessage = (e) => {
			const msg = e.data;
			if (msg.progress) { bytes += msg.progress; report(); return; }
			if (msg.stage === 'decoding') { decoding++; report(); return; }

			worker.terminate();
			decoding--;
			if (!msg.ok) return reject(new Error(`chunk ${index}: ${msg.error}`));

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
	const runners = Array.from({ length: Math.min(MAX_CONCURRENT, chunks.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= chunks.length) return;
			await loadOne(chunks[i], i);
		}
	});
	return Promise.all(runners).then(() => ({ meshes, timings }));
}

export async function loadCollision(manifest, base, onProgress) {
	const res = await fetch(base + manifest.collision.file);
	if (!res.ok) throw new Error(`${manifest.collision.file}: HTTP ${res.status}`);

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
