// Lecteur protobuf minimal (wire format uniquement — pas de schéma). Trois
// types suffisent à tout rocktree : varint (0), 64-bit (1), len-delimited (2),
// 32-bit (5). Écrit à la main pour ne tirer aucune dépendance : le .proto de
// référence est connu, le schéma est porté par proto.mjs.
export function readVarint(buf, pos) {
	let v = 0, shift = 0, b;
	do {
		b = buf[pos.i++];
		// Au-delà de 2^53 un varint ne tient plus dans un Number ; rocktree n'en
		// émet pas (epochs, ids, compteurs). On lève plutôt que de corrompre.
		if (shift >= 53) throw new Error('varint > 2^53');
		v += (b & 0x7f) * 2 ** shift;
		shift += 7;
	} while (b & 0x80);
	return v;
}

export function readFields(buf) {
	const out = [];
	const pos = { i: 0 };
	while (pos.i < buf.length) {
		const key = readVarint(buf, pos);
		const num = Math.floor(key / 8), wire = key & 7;
		let value;
		if (wire === 0) value = readVarint(buf, pos);
		else if (wire === 1) { value = buf.readDoubleLE(pos.i); pos.i += 8; }
		else if (wire === 2) { const len = readVarint(buf, pos); value = buf.subarray(pos.i, pos.i + len); pos.i += len; }
		else if (wire === 5) { value = buf.readFloatLE(pos.i); pos.i += 4; }
		else throw new Error(`wire type ${wire} inattendu (champ ${num})`);
		out.push({ num, wire, value });
	}
	return out;
}

export function varints(buf) {
	const out = [], pos = { i: 0 };
	while (pos.i < buf.length) out.push(readVarint(buf, pos));
	return out;
}

export function doubles(buf) {
	return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function floats(buf) {
	return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
