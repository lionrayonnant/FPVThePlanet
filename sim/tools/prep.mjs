// Converts an Apple Flyover OBJ tile export into artifacts the viewer can load
// directly: chunked binary geometry, texture-array sheets, and a Rapier-ready
// collision mesh.
//
//   node tools/prep.mjs <tileDir> --out <outDir> [--cell 256] [--quality 85]
//
// The source is ~512MB of ASCII OBJ in ECEF coordinates with one 512x512 JPEG
// per material (4732 of them). Naively that is 4732 draw calls and ~4.9GB of
// VRAM, so here we regroup materials into slabs of 1024 that become a single
// texture array, and rebase coordinates to local ENU metres.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const LAYERS_PER_CHUNK = 1024; // below MAX_ARRAY_TEXTURE_LAYERS everywhere
const MAX_SHEET = 4096;        // see CELLS_PER_ROW below

// ---------------------------------------------------------------- args

function parseArgs(argv) {
	const positional = [];
	const opts = { out: null, cell: 256, quality: 85 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--out') opts.out = argv[++i];
		else if (a === '--cell') opts.cell = parseInt(argv[++i], 10);
		else if (a === '--quality') opts.quality = parseInt(argv[++i], 10);
		else positional.push(a);
	}
	if (positional.length !== 1 || !opts.out) {
		console.error('usage: prep.mjs <tileDir> --out <outDir> [--cell 256] [--quality 85]');
		process.exit(1);
	}
	opts.tileDir = path.resolve(positional[0]);
	opts.outDir = path.resolve(opts.out);
	return opts;
}

// ---------------------------------------------------------------- growable typed arrays

class Growable {
	constructor(Type, initial = 1 << 16) {
		this.Type = Type;
		this.buf = new Type(initial);
		this.length = 0;
	}
	_room(n) {
		if (this.length + n <= this.buf.length) return;
		let cap = this.buf.length;
		while (cap < this.length + n) cap *= 2;
		const next = new this.Type(cap);
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
	}
	push(...vals) {
		this._room(vals.length);
		for (const v of vals) this.buf[this.length++] = v;
	}
	view() { return this.buf.subarray(0, this.length); }
}

// ---------------------------------------------------------------- geodesy

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

// Bowring's closed-form ECEF -> geodetic
function ecefToGeodetic(x, y, z) {
	const p = Math.hypot(x, y);
	const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
	const lat = Math.atan2(
		z + EP2 * WGS84_B * Math.sin(theta) ** 3,
		p - E2 * WGS84_A * Math.cos(theta) ** 3,
	);
	const lon = Math.atan2(y, x);
	const N = WGS84_A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
	const alt = p / Math.cos(lat) - N;
	return { lat, lon, alt };
}

// Local tangent frame at (lat, lon), expressed in three.js Y-up convention:
// X = east, Y = up, Z = -north (so -Z, the camera's forward, points north).
function enuBasis(lat, lon) {
	const sla = Math.sin(lat), cla = Math.cos(lat);
	const slo = Math.sin(lon), clo = Math.cos(lon);
	return {
		east: [-slo, clo, 0],
		up: [cla * clo, cla * slo, sla],
		south: [sla * clo, sla * slo, -cla], // -north
	};
}

// ---------------------------------------------------------------- MTL

function parseMtl(file) {
	const materials = [];       // [{ name, jpg }]
	const byName = new Map();   // name -> global layer index
	let current = null;
	for (const raw of fs.readFileSync(file, 'latin1').split('\n')) {
		const line = raw.trim();
		if (line.startsWith('newmtl ')) {
			current = { name: line.slice(7).trim(), jpg: null };
			byName.set(current.name, materials.length);
			materials.push(current);
		} else if (line.startsWith('map_Kd ') && current) {
			current.jpg = line.slice(7).trim();
		}
	}
	return { materials, byName };
}

// ---------------------------------------------------------------- OBJ streaming

// Reads the OBJ in large blocks rather than line-by-line; at 512MB the
// per-line overhead of readline dominates otherwise.
function streamObj(file, onLine) {
	const fd = fs.openSync(file, 'r');
	const CHUNK = 1 << 24; // 16MB
	const buf = Buffer.allocUnsafe(CHUNK);
	let tail = '';
	let read;
	while ((read = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
		const text = tail + buf.toString('latin1', 0, read);
		let start = 0;
		for (;;) {
			const nl = text.indexOf('\n', start);
			if (nl === -1) break;
			onLine(text, start, nl);
			start = nl + 1;
		}
		tail = text.slice(start);
	}
	fs.closeSync(fd);
	if (tail.length) onLine(tail, 0, tail.length);
}

// Parses up to `max` whitespace-separated floats out of text[from..to).
function readFloats(text, from, to, out, max) {
	let n = 0, i = from;
	while (i < to && n < max) {
		while (i < to && text.charCodeAt(i) === 32) i++;
		if (i >= to) break;
		let j = i;
		while (j < to && text.charCodeAt(j) !== 32) j++;
		out[n++] = parseFloat(text.slice(i, j));
		i = j;
	}
	return n;
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
fs.mkdirSync(opts.outDir, { recursive: true });

// A chunk's 1024 layers are packed into square sheets. Capping a sheet at
// MAX_SHEET rather than always fitting all 1024 keeps the viewer's peak memory
// flat as the cell size grows: the worker holds one ImageBitmap plus one
// getImageData band per sheet, times MAX_CONCURRENT workers. 128px cells still
// fit a chunk in a single sheet; 256px needs four, 512px sixteen.
const CELL = opts.cell;
const CELLS_PER_ROW = Math.min(32, Math.floor(MAX_SHEET / CELL));
const CELLS_PER_SHEET = CELLS_PER_ROW * CELLS_PER_ROW;
const SHEET = CELL * CELLS_PER_ROW;

const objFile = path.join(opts.tileDir, 'exp_model.obj');
const mtlFile = path.join(opts.tileDir, 'exp_model.mtl');
for (const f of [objFile, mtlFile]) {
	if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
}

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

console.log(`${stamp()} parsing ${path.basename(mtlFile)}`);
const { materials, byName } = parseMtl(mtlFile);
const missingTex = materials.filter(m => !m.jpg).length;
console.log(`${stamp()}   ${materials.length} materials, ${missingTex} without a texture`);

const chunkCount = Math.ceil(materials.length / LAYERS_PER_CHUNK);
console.log(`${stamp()}   -> ${chunkCount} chunks of up to ${LAYERS_PER_CHUNK} layers`);

// ---- pass over the OBJ ------------------------------------------------

console.log(`${stamp()} streaming ${path.basename(objFile)} (~512MB)`);

const vx = new Growable(Float64Array, 1 << 22);
const vy = new Growable(Float64Array, 1 << 22);
const vz = new Growable(Float64Array, 1 << 22);
const tu = new Growable(Float32Array, 1 << 22);
const tv = new Growable(Float32Array, 1 << 22);

// Per material: flat list of (vertexIndex, uvIndex) pairs, 6 entries/triangle.
const triByMat = materials.map(() => new Growable(Uint32Array, 1 << 10));

let curMat = -1;
let faceCount = 0, unmatchedPairs = 0, polyFaces = 0;
const tmp = new Float64Array(4);
const fv = new Int32Array(64), ft = new Int32Array(64);

streamObj(objFile, (text, from, to) => {
	if (to > from && text.charCodeAt(to - 1) === 13) to--; // CRLF
	if (to <= from) return;
	const c0 = text.charCodeAt(from);

	if (c0 === 118 /* v */) {
		const c1 = text.charCodeAt(from + 1);
		if (c1 === 32) {
			readFloats(text, from + 2, to, tmp, 3);
			vx.push(tmp[0]); vy.push(tmp[1]); vz.push(tmp[2]);
		} else if (c1 === 116 /* t */) {
			readFloats(text, from + 3, to, tmp, 2);
			// OBJ puts the UV origin at the bottom-left; DataArrayTexture forces
			// flipY = false, so row 0 of the pixel data is the top of the image.
			// Convert here, at the OBJ -> engine boundary, alongside ECEF -> ENU.
			// Left unflipped, 21% of the visible surface samples the grey padding
			// Flyover leaves outside each patch's used region.
			tu.push(tmp[0]); tv.push(1 - tmp[1]);
		}
		return;
	}

	if (c0 === 117 /* u(semtl) */) {
		const name = text.slice(from + 7, to).trim();
		const idx = byName.get(name);
		if (idx === undefined) throw new Error(`unknown material: ${name}`);
		curMat = idx;
		return;
	}

	if (c0 === 102 /* f */) {
		if (curMat < 0) throw new Error('face before any usemtl');
		// Collect the polygon's vertex/uv index pairs.
		let n = 0, i = from + 1;
		while (i < to && n < fv.length) {
			while (i < to && text.charCodeAt(i) === 32) i++;
			if (i >= to) break;
			let j = i;
			while (j < to && text.charCodeAt(j) !== 32) j++;
			const slash = text.indexOf('/', i);
			let vi, ti;
			if (slash !== -1 && slash < j) {
				vi = parseInt(text.slice(i, slash), 10);
				let k = slash + 1, e = k;
				while (e < j && text.charCodeAt(e) !== 47 /* / */) e++;
				ti = e > k ? parseInt(text.slice(k, e), 10) : vi;
			} else {
				vi = parseInt(text.slice(i, j), 10);
				ti = vi;
			}
			// OBJ is 1-based; negatives count back from the current end.
			fv[n] = vi > 0 ? vi - 1 : vx.length + vi;
			ft[n] = ti > 0 ? ti - 1 : tu.length + ti;
			if (fv[n] !== ft[n]) unmatchedPairs++;
			n++;
			i = j;
		}
		if (n < 3) return;
		if (n > 3) polyFaces++;
		const dst = triByMat[curMat];
		for (let k = 1; k + 1 < n; k++) { // fan-triangulate
			dst.push(fv[0], ft[0], fv[k], ft[k], fv[k + 1], ft[k + 1]);
			faceCount++;
		}
		return;
	}
});

const vertCount = vx.length;
console.log(`${stamp()}   ${vertCount.toLocaleString()} vertices, ${tu.length.toLocaleString()} uvs, ${faceCount.toLocaleString()} triangles`);
console.log(`${stamp()}   ${polyFaces} non-triangular faces, ${unmatchedPairs} v/vt index mismatches`);

// ---- ECEF -> local ENU metres -----------------------------------------

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
const VX = vx.view(), VY = vy.view(), VZ = vz.view();
for (let i = 0; i < vertCount; i++) {
	if (VX[i] < minX) minX = VX[i]; if (VX[i] > maxX) maxX = VX[i];
	if (VY[i] < minY) minY = VY[i]; if (VY[i] > maxY) maxY = VY[i];
	if (VZ[i] < minZ) minZ = VZ[i]; if (VZ[i] > maxZ) maxZ = VZ[i];
}
const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2, oz = (minZ + maxZ) / 2;
const origin = ecefToGeodetic(ox, oy, oz);
const basis = enuBasis(origin.lat, origin.lon);
console.log(`${stamp()} origin ${(origin.lat * 180 / Math.PI).toFixed(6)}, ${(origin.lon * 180 / Math.PI).toFixed(6)} @ ${origin.alt.toFixed(1)}m`);

// Rewrite the vertex buffers in place as local metres.
for (let i = 0; i < vertCount; i++) {
	const dx = VX[i] - ox, dy = VY[i] - oy, dz = VZ[i] - oz;
	const e = basis.east[0] * dx + basis.east[1] * dy + basis.east[2] * dz;
	const u = basis.up[0] * dx + basis.up[1] * dy + basis.up[2] * dz;
	const s = basis.south[0] * dx + basis.south[1] * dy + basis.south[2] * dz;
	VX[i] = e; VY[i] = u; VZ[i] = s;
}

// ---- build chunks ------------------------------------------------------

const TU = tu.view(), TV = tv.view();
const chunks = [];
let totalOutVerts = 0;

for (let c = 0; c < chunkCount; c++) {
	const layerBase = c * LAYERS_PER_CHUNK;
	const layerEnd = Math.min(layerBase + LAYERS_PER_CHUNK, materials.length);
	const layerCount = layerEnd - layerBase;

	const pos = new Growable(Float32Array, 1 << 20);
	const uv = new Growable(Float32Array, 1 << 20);
	const lay = new Growable(Uint16Array, 1 << 19);
	const idx = new Growable(Uint32Array, 1 << 20);

	let bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];

	for (let m = layerBase; m < layerEnd; m++) {
		const tris = triByMat[m].view();
		if (tris.length === 0) continue;
		// One map per material: a position shared across materials needs its own
		// vertex anyway, since the layer index lives on the vertex.
		// Nested rather than keyed on vi * 2^32 + ti: that overflows 2^53 past
		// vi = 2^21 and silently drops ti's low bits.
		const seen = new Map();
		const localLayer = m - layerBase;
		for (let k = 0; k < tris.length; k += 2) {
			const vi = tris[k], ti = tris[k + 1];
			let byUv = seen.get(vi);
			if (byUv === undefined) { byUv = new Map(); seen.set(vi, byUv); }
			let local = byUv.get(ti);
			if (local === undefined) {
				local = lay.length;
				const x = VX[vi], y = VY[vi], z = VZ[vi];
				pos.push(x, y, z);
				uv.push(TU[ti], TV[ti]);
				lay.push(localLayer);
				if (x < bmin[0]) bmin[0] = x; if (x > bmax[0]) bmax[0] = x;
				if (y < bmin[1]) bmin[1] = y; if (y > bmax[1]) bmax[1] = y;
				if (z < bmin[2]) bmin[2] = z; if (z > bmax[2]) bmax[2] = z;
				byUv.set(ti, local);
			}
			idx.push(local);
		}
	}

	const vCount = lay.length, iCount = idx.length;
	totalOutVerts += vCount;

	// header (32B) | pos f32*3 | uv f32*2 | layer u16 | pad | index u32
	const headerBytes = 32;
	const posBytes = vCount * 12, uvBytes = vCount * 8;
	const layBytes = vCount * 2;
	const layPadded = (layBytes + 3) & ~3;
	const total = headerBytes + posBytes + uvBytes + layPadded + iCount * 4;

	const out = Buffer.allocUnsafe(total);
	out.write('FPVG', 0, 'latin1');
	out.writeUInt32LE(1, 4);
	out.writeUInt32LE(vCount, 8);
	out.writeUInt32LE(iCount, 12);
	out.writeUInt32LE(layerBase, 16);
	out.writeUInt32LE(layerCount, 20);
	out.writeUInt32LE(0, 24);
	out.writeUInt32LE(0, 28);
	let off = headerBytes;
	Buffer.from(pos.view().buffer, 0, posBytes).copy(out, off); off += posBytes;
	Buffer.from(uv.view().buffer, 0, uvBytes).copy(out, off); off += uvBytes;
	Buffer.from(lay.view().buffer, 0, layBytes).copy(out, off); off += layPadded;
	Buffer.from(idx.view().buffer, 0, iCount * 4).copy(out, off);

	const name = `chunk${c}.geo.bin`;
	fs.writeFileSync(path.join(opts.outDir, name), out);

	const sheetCount = Math.ceil(layerCount / CELLS_PER_SHEET);
	chunks.push({
		geo: name,
		tex: Array.from({ length: sheetCount }, (_, s) => `chunk${c}.tex${s}.jpg`),
		geoBytes: total,
		texBytes: 0, // summed once the sheets are written
		layerBase, layerCount,
		vertexCount: vCount, indexCount: iCount,
		bbox: { min: bmin, max: bmax },
	});
	const size = (bmax.map((v, i) => v - bmin[i])).map(v => v.toFixed(0)).join(' x ');
	console.log(`${stamp()} chunk ${c}: ${vCount.toLocaleString()} verts, ${(iCount / 3).toLocaleString()} tris, bbox ${size} m, ${(total / 1e6).toFixed(1)} MB`);

	// Hand the buffers back to the GC before the next chunk.
	for (let m = layerBase; m < layerEnd; m++) triByMat[m] = null;
}

console.log(`${stamp()} ${totalOutVerts.toLocaleString()} output vertices (+${((totalOutVerts / vertCount - 1) * 100).toFixed(1)}% from seam splits)`);

fs.writeFileSync(path.join(opts.outDir, '_geometry.json'), JSON.stringify({ chunks, origin, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } }));
console.log(`${stamp()} geometry done`);

// ---- texture sheets ----------------------------------------------------

console.log(`${stamp()} building texture sheets: ${SHEET}x${SHEET}, ${CELL}px cells, ${CELLS_PER_SHEET}/sheet`);

async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}));
	return results;
}

for (const chunk of chunks) {
	chunk.texBytes = 0;
	for (let s = 0; s < chunk.tex.length; s++) {
		const first = s * CELLS_PER_SHEET;
		const count = Math.min(CELLS_PER_SHEET, chunk.layerCount - first);
		// Grey only ever shows through where a sheet is not full; those cells are
		// past the layer count and can never be sampled.
		const sheet = Buffer.alloc(SHEET * SHEET * 3, 64);

		await mapLimit(Array.from({ length: count }, (_, i) => i), 8, async (cell) => {
			const mat = materials[chunk.layerBase + first + cell];
			if (!mat.jpg) return;
			const src = path.join(opts.tileDir, mat.jpg);
			if (!fs.existsSync(src)) return;
			const cellBuf = await sharp(src)
				.resize(CELL, CELL, { fit: 'fill' })
				.removeAlpha()
				.raw()
				.toBuffer();
			// Blit the cell into its slot in the sheet, row by row.
			const cx = (cell % CELLS_PER_ROW) * CELL;
			const cy = Math.floor(cell / CELLS_PER_ROW) * CELL;
			for (let row = 0; row < CELL; row++) {
				cellBuf.copy(sheet, ((cy + row) * SHEET + cx) * 3, row * CELL * 3, (row + 1) * CELL * 3);
			}
		});

		const outPath = path.join(opts.outDir, chunk.tex[s]);
		await sharp(sheet, { raw: { width: SHEET, height: SHEET, channels: 3 } })
			.jpeg({ quality: opts.quality, chromaSubsampling: '4:4:4' })
			.toFile(outPath);
		const bytes = fs.statSync(outPath).size;
		chunk.texBytes += bytes;
		console.log(`${stamp()}   ${chunk.tex[s]}: ${count} layers, ${(bytes / 1e6).toFixed(1)} MB`);
	}
}

// ---- collision mesh ----------------------------------------------------

console.log(`${stamp()} assembling collision mesh`);

const colPos = new Float32Array(totalOutVerts * 3);
const colIdx = new Uint32Array(chunks.reduce((s, c) => s + c.indexCount, 0));
let vOff = 0, iOff = 0;

for (const chunk of chunks) {
	const raw = fs.readFileSync(path.join(opts.outDir, chunk.geo));
	const vCount = raw.readUInt32LE(8), iCount = raw.readUInt32LE(12);
	let off = 32;
	const p = new Float32Array(raw.buffer, raw.byteOffset + off, vCount * 3);
	off += vCount * 12 + vCount * 8 + ((vCount * 2 + 3) & ~3);
	const ind = new Uint32Array(raw.buffer, raw.byteOffset + off, iCount);

	colPos.set(p, vOff * 3);
	for (let i = 0; i < iCount; i++) colIdx[iOff + i] = ind[i] + vOff;
	vOff += vCount; iOff += iCount;
}

{
	const header = Buffer.alloc(16);
	header.write('FPVC', 0, 'latin1');
	header.writeUInt32LE(1, 4);
	header.writeUInt32LE(vOff, 8);
	header.writeUInt32LE(iOff, 12);
	const fdOut = fs.openSync(path.join(opts.outDir, 'collision.bin'), 'w');
	fs.writeSync(fdOut, header);
	fs.writeSync(fdOut, Buffer.from(colPos.buffer, 0, vOff * 12));
	fs.writeSync(fdOut, Buffer.from(colIdx.buffer, 0, iOff * 4));
	fs.closeSync(fdOut);
	console.log(`${stamp()}   collision.bin: ${vOff.toLocaleString()} verts, ${(iOff / 3).toLocaleString()} tris, ${((16 + vOff * 12 + iOff * 4) / 1e6).toFixed(1)} MB`);
}

// ---- Rapier trimesh timing + spawn point -------------------------------

const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();

const tBuild = Date.now();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.trimesh(colPos, colIdx), ground);
world.step(); // castRay only sees colliders once the query pipeline is populated
const buildMs = Date.now() - tBuild;
console.log(`${stamp()} Rapier trimesh build: ${(buildMs / 1000).toFixed(1)}s`);

// Ground height under a point, or null if the ray misses.
const bbTop = Math.max(...chunks.map(c => c.bbox.max[1])) + 50;
function groundAt(x, z) {
	const hit = world.castRay(new RAPIER.Ray({ x, y: bbTop, z }, { x: 0, y: -1, z: 0 }), 2000, true);
	return hit ? bbTop - hit.timeOfImpact : null;
}

// Look for open, flat, low ground a little way out from the centre: on this
// tile that lands on the Champ-de-Mars rather than inside the tower.
let spawn = null, bestScore = Infinity;
for (let x = -300; x <= 300; x += 20) {
	for (let z = -300; z <= 300; z += 20) {
		const r = Math.hypot(x, z);
		if (r < 80 || r > 320) continue;
		const h = groundAt(x, z);
		if (h === null) continue;
		const n = [groundAt(x + 12, z), groundAt(x - 12, z), groundAt(x, z + 12), groundAt(x, z - 12)];
		if (n.some(v => v === null)) continue;
		const roughness = Math.max(...n.map(v => Math.abs(v - h)));
		const score = roughness * 10 + h; // flat first, then low
		if (score < bestScore) { bestScore = score; spawn = { x, y: h + 0.25, z, roughness, ground: h }; }
	}
}
if (!spawn) {
	const h = groundAt(0, 0);
	if (h === null) throw new Error('no ground found anywhere: collision mesh or raycast is broken');
	console.warn(`${stamp()}   no open ground in the search ring, falling back to centre`);
	spawn = { x: 0, y: h + 0.25, z: 0, roughness: 0, ground: h };
}
console.log(`${stamp()} spawn at x=${spawn.x} z=${spawn.z}, ground ${spawn.ground.toFixed(1)}m, roughness ${spawn.roughness.toFixed(2)}m`);

// A slow build would stall startup, so bake the world out instead.
let snapshot = null;
if (buildMs > 10000) {
	const snap = world.takeSnapshot();
	fs.writeFileSync(path.join(opts.outDir, 'rapier-snapshot.bin'), Buffer.from(snap));
	snapshot = 'rapier-snapshot.bin';
	console.log(`${stamp()}   baked rapier-snapshot.bin (${(snap.length / 1e6).toFixed(1)} MB)`);
}

// ---- manifest ----------------------------------------------------------

const manifest = {
	version: 2,
	source: opts.tileDir, // the selftest reads the source JPEGs back from here
	origin: {
		latitude: origin.lat * 180 / Math.PI,
		longitude: origin.lon * 180 / Math.PI,
		altitude: origin.alt,
	},
	bbox: {
		min: [Math.min(...chunks.map(c => c.bbox.min[0])), Math.min(...chunks.map(c => c.bbox.min[1])), Math.min(...chunks.map(c => c.bbox.min[2]))],
		max: [Math.max(...chunks.map(c => c.bbox.max[0])), Math.max(...chunks.map(c => c.bbox.max[1])), Math.max(...chunks.map(c => c.bbox.max[2]))],
	},
	cellSize: CELL,
	cellsPerRow: CELLS_PER_ROW,
	chunks,
	collision: {
		file: 'collision.bin',
		bytes: fs.statSync(path.join(opts.outDir, 'collision.bin')).size,
		vertexCount: vOff, indexCount: iOff, buildMs, snapshot,
	},
	spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
};
fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.rmSync(path.join(opts.outDir, '_geometry.json'), { force: true });

const bytes = fs.readdirSync(opts.outDir).reduce((s, f) => s + fs.statSync(path.join(opts.outDir, f)).size, 0);
console.log(`${stamp()} done -> ${opts.outDir} (${(bytes / 1e6).toFixed(1)} MB total)`);
