// Dépaquetage des maillages rocktree. Réécrit d'après la documentation de
// protocole d'earth-reverse-engineering (le dépôt n'a pas de licence : on ne
// copie pas, on réimplémente le format décrit).
import { readVarint } from './pb.mjs';

// 3 plans d'octets (tous les X, tous les Y, tous les Z), delta-encodés mod 256.
export function unpackVertices(buf) {
	const count = Math.floor(buf.length / 3);
	const xyz = new Uint8Array(count * 3);
	let x = 0, y = 0, z = 0;
	for (let i = 0; i < count; i++) {
		xyz[i * 3] = (x = (x + buf[i]) & 0xff);
		xyz[i * 3 + 1] = (y = (y + buf[count + i]) & 0xff);
		xyz[i * 3 + 2] = (z = (z + buf[count * 2 + i]) & 0xff);
	}
	return { xyz, count };
}

// En-tête 4 octets : (uMod-1, vMod-1) en uint16 LE. Puis 4 plans d'octets :
// lo(u), lo(v), hi(u), hi(v) — delta-encodés modulo uMod/vMod.
export function unpackTexCoords(buf, count) {
	const dv = new DataView(buf.buffer, buf.byteOffset, 4);
	const uMod = 1 + dv.getUint16(0, true), vMod = 1 + dv.getUint16(2, true);
	const data = buf.subarray(4);
	if (data.length !== count * 4) throw new Error(`texcoords : ${data.length} octets pour ${count} sommets`);
	const uv = new Uint16Array(count * 2);
	let u = 0, v = 0;
	for (let i = 0; i < count; i++) {
		uv[i * 2] = (u = (u + data[i] + (data[count * 2 + i] << 8)) % uMod);
		uv[i * 2 + 1] = (v = (v + data[count + i] + (data[count * 3 + i] << 8)) % vMod);
	}
	return { uv, uMod, vMod };
}

// Triangle strip compressé : chaque valeur est un recul par rapport au nombre
// de zéros déjà vus. Rendu en indices absolus, l'appelant déroule le strip.
export function unpackIndices(buf) {
	const pos = { i: 0 };
	const len = readVarint(buf, pos);
	const strip = new Uint32Array(len);
	let zeros = 0;
	for (let i = 0; i < len; i++) {
		const val = readVarint(buf, pos);
		strip[i] = zeros - val;
		if (val === 0) zeros++;
	}
	return strip;
}

// layer_and_octant_counts : `len` varints ; tous les 8 une borne de couche
// (indices dans le strip), et chaque varint v peint l'octant (i & 7) sur les
// v indices suivants du strip. layerBounds[m] = index du strip où commence le
// groupe m ; layerBounds[3] est donc le DÉBUT de TERRAIN_HIDDEN — l'aval garde
// i < layerBounds[3], c'est-à-dire les couches 0-2 (OVERGROUND + terrain
// visible). Ne pas décaler : la référence enregistre la borne AVANT le groupe.
export function unpackLayerBoundsAndOctants(buf, strip, vertCount) {
	const pos = { i: 0 };
	const len = readVarint(buf, pos);
	const layerBounds = new Int32Array(10);
	const octantOf = new Uint8Array(vertCount);
	let k = 0, m = 0, idx = 0;
	for (let i = 0; i < len; i++) {
		if (i % 8 === 0 && m < 10) layerBounds[m++] = k;
		const v = readVarint(buf, pos);
		for (let j = 0; j < v; j++) octantOf[strip[idx++]] = i & 7;
		k += v;
	}
	while (m < 10) layerBounds[m++] = k;
	return { layerBounds, octantOf };
}
