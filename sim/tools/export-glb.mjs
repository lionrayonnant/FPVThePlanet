// Packs a prepped scene (public/scenes/<slug>) into one self-contained .glb —
// the format every engine reads (Blender, Godot, Unity via glTFast, Unreal,
// three.js). This is the "hand it to someone else" path; the engine here keeps
// eating the chunked binaries directly.
//
//   node tools/export-glb.mjs public/scenes/tour-eiffel [--out x.glb]
//                             [--max-tex 2048] [--tex-quality 85] [--unlit]
//
// The one real translation is texturing. prep.mjs packs 1024 patch textures per
// chunk into DataArrayTexture sheets and stores (uv, layer) per vertex; glTF has
// no array textures, so each sheet becomes an ordinary 2D texture and the layer
// index is folded into the UV — cell (col,row) inside a cellsPerRow grid. That
// is lossless only because every source UV sits inside [0,1] (verified: 0 of
// 1.4M coords outside on chunk0), so no patch tiles across its cell boundary.
//
// Coordinates pass through untouched: prep.mjs already emits ENU metres as
// X=east, Y=up, Z=south, which is right-handed and Y-up — exactly glTF's frame.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
	const positional = [];
	const opts = { out: null, maxTex: 0, texQuality: 85, unlit: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--out') opts.out = argv[++i];
		else if (a === '--max-tex') opts.maxTex = parseInt(argv[++i], 10);
		else if (a === '--tex-quality') opts.texQuality = parseInt(argv[++i], 10);
		else if (a === '--unlit') opts.unlit = true;
		else positional.push(a);
	}
	if (positional.length !== 1) {
		console.error('usage: export-glb.mjs <sceneDir> [--out file.glb] [--max-tex N] [--tex-quality N] [--unlit]');
		process.exit(1);
	}
	opts.sceneDir = path.resolve(positional[0]);
	if (!opts.out) opts.out = path.join(opts.sceneDir, `${path.basename(opts.sceneDir)}.glb`);
	opts.out = path.resolve(opts.out);
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
const manifestPath = path.join(opts.sceneDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
	console.error(`missing ${manifestPath} — point this at a prepped scene directory`);
	process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const CELLS_PER_ROW = manifest.cellsPerRow;
const CELLS_PER_SHEET = CELLS_PER_ROW * CELLS_PER_ROW;

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

// ---------------------------------------------------------------- geo.bin

// header (32B) | pos f32*3 | uv f32*2 | layer u16 | pad4 | index u32
function readGeo(file) {
	const b = fs.readFileSync(file);
	if (b.toString('latin1', 0, 4) !== 'FPVG') throw new Error(`${file}: bad magic`);
	const version = b.readUInt32LE(4);
	if (version !== 1) throw new Error(`${file}: unsupported geo version ${version}`);
	const vCount = b.readUInt32LE(8), iCount = b.readUInt32LE(12);
	let off = 32;
	// Copy rather than view: the header is 32B so f32 views are aligned, but the
	// index block sits after a u16 run padded only to 4, and Buffer's own
	// byteOffset carries no alignment guarantee at all.
	const pos = new Float32Array(vCount * 3);
	Buffer.from(pos.buffer).set(b.subarray(off, off + vCount * 12)); off += vCount * 12;
	const uv = new Float32Array(vCount * 2);
	Buffer.from(uv.buffer).set(b.subarray(off, off + vCount * 8)); off += vCount * 8;
	const lay = new Uint16Array(vCount);
	Buffer.from(lay.buffer).set(b.subarray(off, off + vCount * 2));
	off += (vCount * 2 + 3) & ~3;
	const idx = new Uint32Array(iCount);
	Buffer.from(idx.buffer).set(b.subarray(off, off + iCount * 4));
	return { vCount, iCount, pos, uv, lay, idx };
}

// ---------------------------------------------------------------- glTF assembly

const gltf = {
	asset: { version: '2.0', generator: 'FPVTP export-glb' },
	scene: 0,
	scenes: [{ nodes: [0] }],
	nodes: [{ mesh: 0, name: path.basename(opts.sceneDir) }],
	meshes: [{ name: path.basename(opts.sceneDir), primitives: [] }],
	materials: [],
	textures: [],
	images: [],
	samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
	accessors: [],
	bufferViews: [],
	buffers: [],
};
if (opts.unlit) gltf.extensionsUsed = ['KHR_materials_unlit'];

const parts = [];      // Buffer[] making up the BIN chunk, in bufferView order
let binLength = 0;

function addView(buf, target) {
	const pad = (4 - (binLength & 3)) & 3;
	if (pad) { parts.push(Buffer.alloc(pad)); binLength += pad; }
	const view = { buffer: 0, byteOffset: binLength, byteLength: buf.length };
	if (target) view.target = target;
	gltf.bufferViews.push(view);
	parts.push(buf);
	binLength += buf.length;
	return gltf.bufferViews.length - 1;
}

function addAccessor(bufferView, componentType, count, type, extra = {}) {
	gltf.accessors.push({ bufferView, componentType, count, type, ...extra });
	return gltf.accessors.length - 1;
}

// ---------------------------------------------------------------- textures

// Sheets are embedded byte-for-byte unless --max-tex asks for a downscale; they
// are already JPEG, so re-encoding at the same size would only lose quality.
async function loadSheet(file) {
	if (!opts.maxTex) return fs.readFileSync(file);
	const { default: sharp } = await import('sharp');
	const img = sharp(file);
	const meta = await img.metadata();
	if (meta.width <= opts.maxTex) return fs.readFileSync(file);
	return img
		.resize(opts.maxTex, opts.maxTex, { fit: 'fill' })
		.jpeg({ quality: opts.texQuality, chromaSubsampling: '4:4:4' })
		.toBuffer();
}

// ---------------------------------------------------------------- per-chunk

let totalVerts = 0, totalTris = 0, splitTris = 0;

for (let c = 0; c < manifest.chunks.length; c++) {
	const chunk = manifest.chunks[c];
	const geo = readGeo(path.join(opts.sceneDir, chunk.geo));

	// Every vertex belongs to exactly one patch layer, hence one sheet.
	const sheetOf = new Uint8Array(geo.vCount);
	for (let v = 0; v < geo.vCount; v++) sheetOf[v] = Math.floor(geo.lay[v] / CELLS_PER_SHEET);

	// Route triangles by sheet. prep.mjs builds vertices per material, so a
	// triangle's three corners always share a layer; verify rather than assume,
	// and fall back to the first corner's sheet if that ever stops holding.
	const triSheet = new Uint8Array(geo.iCount / 3);
	for (let t = 0, k = 0; k < geo.iCount; t++, k += 3) {
		const s = sheetOf[geo.idx[k]];
		if (sheetOf[geo.idx[k + 1]] !== s || sheetOf[geo.idx[k + 2]] !== s) splitTris++;
		triSheet[t] = s;
	}

	for (let s = 0; s < chunk.tex.length; s++) {
		const firstLayer = s * CELLS_PER_SHEET;
		const cellCount = Math.min(CELLS_PER_SHEET, chunk.layerCount - firstLayer);
		if (cellCount <= 0) continue;

		let triCount = 0;
		for (let t = 0; t < triSheet.length; t++) if (triSheet[t] === s) triCount++;
		if (triCount === 0) continue;

		// Compact this sheet's vertices into their own accessor.
		const remap = new Int32Array(geo.vCount).fill(-1);
		const outIdx = new Uint32Array(triCount * 3);
		let nextLocal = 0, w = 0;
		for (let t = 0, k = 0; k < geo.iCount; t++, k += 3) {
			if (triSheet[t] !== s) continue;
			for (let j = 0; j < 3; j++) {
				const vi = geo.idx[k + j];
				let local = remap[vi];
				if (local < 0) { local = nextLocal++; remap[vi] = local; }
				outIdx[w++] = local;
			}
		}

		const outPos = new Float32Array(nextLocal * 3);
		const outUv = new Float32Array(nextLocal * 2);
		const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
		for (let vi = 0; vi < geo.vCount; vi++) {
			const local = remap[vi];
			if (local < 0) continue;
			const x = geo.pos[vi * 3], y = geo.pos[vi * 3 + 1], z = geo.pos[vi * 3 + 2];
			outPos[local * 3] = x; outPos[local * 3 + 1] = y; outPos[local * 3 + 2] = z;
			if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
			if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
			if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
			// Array layer -> cell in the sheet's CELLS_PER_ROW grid. prep.mjs already
			// flipped V for row-0-is-top, which is glTF's convention too, so the cell
			// offset is a plain add with no second flip.
			const cell = geo.lay[vi] - firstLayer;
			const col = cell % CELLS_PER_ROW, row = Math.floor(cell / CELLS_PER_ROW);
			outUv[local * 2] = (col + geo.uv[vi * 2]) / CELLS_PER_ROW;
			outUv[local * 2 + 1] = (row + geo.uv[vi * 2 + 1]) / CELLS_PER_ROW;
		}

		const posView = addView(Buffer.from(outPos.buffer, 0, outPos.byteLength), 34962);
		const posAcc = addAccessor(posView, 5126, nextLocal, 'VEC3', { min, max });
		const uvView = addView(Buffer.from(outUv.buffer, 0, outUv.byteLength), 34962);
		const uvAcc = addAccessor(uvView, 5126, nextLocal, 'VEC2');

		// u16 where it fits: halves the index block on the smaller primitives.
		let idxBuf, idxComponent;
		if (nextLocal <= 65535) {
			const u16 = new Uint16Array(outIdx.length);
			for (let i = 0; i < outIdx.length; i++) u16[i] = outIdx[i];
			idxBuf = Buffer.from(u16.buffer, 0, u16.byteLength); idxComponent = 5123;
		} else {
			idxBuf = Buffer.from(outIdx.buffer, 0, outIdx.byteLength); idxComponent = 5125;
		}
		const idxView = addView(idxBuf, 34963);
		const idxAcc = addAccessor(idxView, idxComponent, outIdx.length, 'SCALAR');

		const sheetBuf = await loadSheet(path.join(opts.sceneDir, chunk.tex[s]));
		const imgView = addView(sheetBuf);
		gltf.images.push({ bufferView: imgView, mimeType: 'image/jpeg', name: chunk.tex[s] });
		gltf.textures.push({ sampler: 0, source: gltf.images.length - 1 });
		const material = {
			name: `chunk${c}_sheet${s}`,
			pbrMetallicRoughness: {
				baseColorTexture: { index: gltf.textures.length - 1 },
				metallicFactor: 0,
				roughnessFactor: 1,
			},
			doubleSided: true,
		};
		if (opts.unlit) material.extensions = { KHR_materials_unlit: {} };
		gltf.materials.push(material);

		gltf.meshes[0].primitives.push({
			attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc },
			indices: idxAcc,
			material: gltf.materials.length - 1,
		});

		totalVerts += nextLocal;
		totalTris += triCount;
		console.log(`${stamp()} chunk ${c} sheet ${s}: ${nextLocal.toLocaleString()} verts, ${triCount.toLocaleString()} tris, tex ${(sheetBuf.length / 1e6).toFixed(1)} MB`);
	}
}

if (splitTris) console.warn(`warning: ${splitTris} triangles span two sheets; they follow their first corner and may sample the wrong patch`);

gltf.buffers.push({ byteLength: binLength });

// ---------------------------------------------------------------- write GLB

const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBuf.length & 3)) & 3;
const binPad = (4 - (binLength & 3)) & 3;
const jsonChunk = jsonBuf.length + jsonPad;
const binChunk = binLength + binPad;
const total = 12 + 8 + jsonChunk + 8 + binChunk;
if (total > 0xffffffff) { console.error('GLB exceeds 4GB; re-run with --max-tex'); process.exit(1); }

const out = fs.createWriteStream(opts.out);
const write = (b) => new Promise((res, rej) => out.write(b, (e) => e ? rej(e) : res()));

const header = Buffer.alloc(12);
header.write('glTF', 0, 'latin1');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
await write(header);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk, 0);
jsonHeader.write('JSON', 4, 'latin1');
await write(jsonHeader);
await write(jsonBuf);
if (jsonPad) await write(Buffer.alloc(jsonPad, 0x20)); // spaces, per spec

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk, 0);
binHeader.write('BIN\0', 4, 'latin1');
await write(binHeader);
for (const p of parts) await write(p);
if (binPad) await write(Buffer.alloc(binPad));

await new Promise((res, rej) => out.end((e) => e ? rej(e) : res()));

console.log(`${stamp()} wrote ${opts.out}`);
console.log(`${stamp()}   ${totalVerts.toLocaleString()} verts, ${totalTris.toLocaleString()} tris, ${gltf.meshes[0].primitives.length} primitives, ${(total / 1e6).toFixed(1)} MB`);
