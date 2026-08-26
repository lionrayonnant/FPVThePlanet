// Loads one chunk: parses the binary geometry and unpacks its texture sheet
// into the layer-major layout a DataArrayTexture expects.

function parseGeometry(buf) {
	const head = new DataView(buf);
	const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
	if (magic !== 'FPVG') throw new Error(`bad geometry magic: ${magic}`);
	const vertexCount = head.getUint32(8, true);
	const indexCount = head.getUint32(12, true);
	const layerBase = head.getUint32(16, true);
	const layerCount = head.getUint32(20, true);

	let off = 32;
	const positions = new Float32Array(buf, off, vertexCount * 3); off += vertexCount * 12;
	const uvs = new Float32Array(buf, off, vertexCount * 2); off += vertexCount * 8;
	const layers = new Uint16Array(buf, off, vertexCount); off += (vertexCount * 2 + 3) & ~3;
	const indices = new Uint32Array(buf, off, indexCount);

	return { positions, uvs, layers, indices, vertexCount, indexCount, layerBase, layerCount };
}

// Each sheet is a cellsPerRow x cellsPerRow grid of square cells; a texture
// array wants each cell contiguous, so every cell is copied out row by row.
// A chunk's layers may span several sheets (see CELLS_PER_ROW in prep.mjs), and
// each sheet is read one band of cells at a time rather than whole: getImageData
// over a full 4096x4096 sheet allocates 67MB in a single go, per worker.
async function unpackSheets(blobs, cell, cellsPerRow, layerCount) {
	const sheet = cell * cellsPerRow;
	const cellsPerSheet = cellsPerRow * cellsPerRow;
	const cellStride = cell * 4;
	const out = new Uint8Array(layerCount * cell * cell * 4);
	const canvas = new OffscreenCanvas(sheet, sheet);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });

	for (let s = 0; s < blobs.length; s++) {
		const bitmap = await createImageBitmap(blobs[s]);
		if (bitmap.width !== sheet || bitmap.height !== sheet) {
			throw new Error(`sheet ${s} is ${bitmap.width}x${bitmap.height}, expected ${sheet}x${sheet}`);
		}
		ctx.drawImage(bitmap, 0, 0);
		bitmap.close();

		for (let band = 0; band < cellsPerRow; band++) {
			const firstLayer = s * cellsPerSheet + band * cellsPerRow;
			if (firstLayer >= layerCount) break;
			const src = ctx.getImageData(0, band * cell, sheet, cell).data;
			for (let c = 0; c < cellsPerRow && firstLayer + c < layerCount; c++) {
				const base = (firstLayer + c) * cell * cell * 4;
				const cx = c * cell;
				for (let row = 0; row < cell; row++) {
					const from = (row * sheet + cx) * 4;
					out.set(src.subarray(from, from + cellStride), base + row * cellStride);
				}
			}
		}
	}
	return out;
}

// Downloads with progress, so a 25MB file does not look like a frozen bar.
async function fetchWithProgress(url, onBytes) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url.split('/').pop()}: HTTP ${res.status}`);
	const reader = res.body.getReader();
	const parts = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		received += value.length;
		onBytes(value.length);
	}
	const out = new Uint8Array(received);
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.length; }
	return out;
}

self.onmessage = async (e) => {
	const { index, baseUrl, geo, tex, cell, cellsPerRow } = e.data;
	const t0 = performance.now();
	try {
		let sent = 0;
		const report = (n) => {
			sent += n;
			// Coalesce into ~256KB updates; posting per chunk floods the main thread.
			if (sent >= 262144) { self.postMessage({ index, progress: sent }); sent = 0; }
		};

		const [geoBytes, ...sheetBytes] = await Promise.all([
			fetchWithProgress(baseUrl + geo, report),
			...tex.map(name => fetchWithProgress(baseUrl + name, report)),
		]);
		if (sent) self.postMessage({ index, progress: sent });
		const tFetched = performance.now();

		const g = parseGeometry(geoBytes.buffer);
		self.postMessage({ index, stage: 'decoding' });
		const pixels = await unpackSheets(sheetBytes.map(b => new Blob([b])), cell, cellsPerRow, g.layerCount);
		const tDecoded = performance.now();

		// The typed arrays are views onto the geometry buffer, so transferring it
		// moves them all.
		self.postMessage({
			index, ok: true, geometry: g, pixels, cell,
			timing: { fetchMs: Math.round(tFetched - t0), decodeMs: Math.round(tDecoded - tFetched) },
		}, [geoBytes.buffer, pixels.buffer]);
	} catch (err) {
		self.postMessage({ index, ok: false, error: String(err && err.message || err) });
	}
};
