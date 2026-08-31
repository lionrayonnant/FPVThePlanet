import { readFields, varints, doubles, floats } from './pb.mjs';

const all = (fields, num) => fields.filter((f) => f.num === num).map((f) => f.value);
const one = (fields, num) => fields.find((f) => f.num === num)?.value;

// path_and_flags (NodeMetadata champ 1) : 2 bits de longueur, puis `level`
// digits de 3 bits (poids faible = premier digit), puis les flags.
export function unpackPathAndFlags(v) {
	const level = 1 + (v & 3);
	v = Math.floor(v / 4);
	let relPath = '';
	for (let i = 0; i < level; i++) { relPath += String(v & 7); v = Math.floor(v / 8); }
	return { relPath, flags: v };
}

export function parsePlanetoid(buf) {
	const f = readFields(buf);
	const meta = readFields(one(f, 1));
	// Champ 2 du message racine (pas de `meta` — sibling de field 1, un float32
	// nu) : le rayon de la sphère que rocktree.mjs utilise pour reconvertir ses
	// sommets en ellipsoïde WGS84. Constaté 6 371 010.0 exactement sur la
	// capture Paris du 2026-08-31 (planetoid.pb) — voyage désormais avec la
	// tuile plutôt que d'être recopié en dur côté décodeur.
	return { rootEpoch: Number(one(meta, 5) ?? one(meta, 2)), radius: one(f, 2) };
}

export function parseBulk(buf) {
	const f = readFields(buf);
	const nodes = new Map();
	for (const raw of all(f, 1)) {
		const m = readFields(raw);
		const { relPath, flags } = unpackPathAndFlags(one(m, 1));
		nodes.set(relPath, {
			relPath, flags,
			epoch: one(m, 2) ?? null,           // absent -> epoch du bulk courant
			bulkEpoch: one(m, 5) ?? null,       // epoch du bulk ENFANT à ce chemin
			imageryEpoch: one(m, 7) ?? null,
			metersPerTexel: one(m, 4) ?? null,
		});
	}
	return {
		nodes,
		headNodeCenter: doubles(one(f, 3) ?? new Uint8Array(0)),
		metersPerTexel: floats(one(f, 4) ?? new Uint8Array(0)),
		defaultImageryEpoch: one(f, 5) ?? null,
	};
}

export function parseNode(buf) {
	const f = readFields(buf);
	// copyright_ids : le champ 3 arrive packed (wire 2) ou éclaté (wire 0)
	// selon la taille — les deux existent dans la capture.
	const copyrightIds = f.filter((x) => x.num === 3)
		.flatMap((x) => (x.wire === 2 ? varints(x.value) : [x.value]));
	return {
		matrix: doubles(one(f, 1)),
		copyrightIds,
		meshes: all(f, 2).map(parseMesh),
	};
}

function parseMesh(buf) {
	const f = readFields(buf);
	const texRaw = one(f, 6);
	let texture = null;
	if (texRaw) {
		const t = readFields(texRaw);
		texture = { data: one(t, 1), format: one(t, 2) ?? 1, width: one(t, 3) ?? 256, height: one(t, 4) ?? 256 };
	}
	return {
		vertices: one(f, 1),
		indices: one(f, 3),
		texCoords: one(f, 7) ?? null,
		uvOffsetAndScale: one(f, 10) ? floats(one(f, 10)) : null,
		layerAndOctantCounts: one(f, 8),
		texture,
		meshId: one(f, 12) ?? 0,
	};
}

const utf8 = new TextDecoder('utf-8');

export function parseCopyrights(buf) {
	const map = new Map();
	for (const raw of all(readFields(buf), 1)) {
		const c = readFields(raw);
		map.set(one(c, 1), utf8.decode(one(c, 2)));
	}
	return map;
}
