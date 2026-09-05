// Décodeur OBJ/MTL — le format que produit le Go exporter d'Apple Flyover.
// Extrait de prep.mjs sans modification de logique (issue #18) : tout ce qui
// suit le decode (rebase ENU, chunks, texture arrays, collision) reste dans
// prep.mjs et ne connaît pas le format d'entrée.
import fs from 'node:fs';
import path from 'node:path';
import { Growable } from '../growable.mjs';

export const id = 'obj';

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

// Liste ORDONNÉE des textures du dossier, une par couche, dans l'ordre que
// prep.mjs assigne aux couches. Chemins absolus, `null` pour un matériau sans
// texture.
//
// Existe pour tools/selftest.mjs (issue #110), dont le contrôle de convention
// UV relisait exp_model.mtl lui-même et reparsait newmtl/map_Kd à la main :
// c'était la dernière hypothèse « l'entrée est de l'OBJ » hors de ce dossier.
// Elle se mettait en SKIP dès que la tuile source n'était plus sur le disque,
// donc elle cessait simplement de vérifier quoi que ce soit — le pire état
// pour un contrôle dont le rôle est d'attraper les régressions de l'axe V.
//
// Beaucoup moins cher que decode() : on ne lit que le .mtl, pas la géométrie.
export async function textures(tileDir) {
	const mtlFile = path.join(tileDir, 'exp_model.mtl');
	if (!fs.existsSync(mtlFile)) throw new Error(`missing ${mtlFile}`);
	return parseMtl(mtlFile).materials
		.map((m) => (m.jpg ? path.join(tileDir, m.jpg) : null));
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

// Ne vérifie que la présence du .obj — le fichier qui porte le format — pas du
// .mtl compagnon ni du contenu de l'un ou l'autre : sniff() choisit le FORMAT,
// decode() valide l'USABILITÉ (le .mtl est bien là, ni l'un ni l'autre n'est
// vide, il y a de la géométrie). Exiger aussi le .mtl ici ferait lever pick()
// avant que decode() tourne pour un tileDir où seul le .mtl manque, et le
// diagnostic précis ci-dessous (`missing …/exp_model.mtl`) ne s'afficherait
// jamais sur le chemin CLI — juste le message générique et muet de pick()
// (issue #18, retour de revue).
export function sniff(tileDir) {
	return fs.existsSync(path.join(tileDir, 'exp_model.obj'));
}

// onLog reçoit des lignes NON horodatées, indentation comprise. C'est prep.mjs
// qui préfixe avec son stamp() : le décodeur n'emporte pas l'horloge, sinon les
// timings repartiraient à zéro et la sortie ne serait plus comparable.
//
// Les erreurs sont levées (jamais process.exit) : ce module est une bibliothèque
// avec un appelant (prep.mjs), pas un point d'entrée CLI ; c'est à l'appelant de
// décider comment terminer.
export async function decode(tileDir, { onLog } = {}) {
	const log = (line) => onLog?.(line);
	const objFile = path.join(tileDir, 'exp_model.obj');
	const mtlFile = path.join(tileDir, 'exp_model.mtl');

	for (const f of [objFile, mtlFile]) {
		if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
		// The Go exporter creates both files up front and only then streams tiles
		// into them, so a scan that found nothing leaves them at zero bytes. Catch
		// that here rather than three passes later, where an empty trimesh makes
		// Rapier abort with an opaque `RuntimeError: unreachable`.
		if (fs.statSync(f).size === 0) {
			throw new Error(`${f} est vide — aucune tuile n'a été téléchargée pour cet endroit.`);
		}
	}

	log(`parsing ${path.basename(mtlFile)}`);
	const { materials: rawMaterials, byName } = parseMtl(mtlFile);
	const missingTex = rawMaterials.filter(m => !m.jpg).length;
	log(`  ${rawMaterials.length} materials, ${missingTex} without a texture`);

	log(`streaming ${path.basename(objFile)} (~512MB)`);

	const vx = new Growable(Float64Array, 1 << 22);
	const vy = new Growable(Float64Array, 1 << 22);
	const vz = new Growable(Float64Array, 1 << 22);
	const tu = new Growable(Float32Array, 1 << 22);
	const tv = new Growable(Float32Array, 1 << 22);

	// Per material: flat list of (vertexIndex, uvIndex) pairs, 6 entries/triangle.
	const triByMat = rawMaterials.map(() => new Growable(Uint32Array, 1 << 10));

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
	log(`  ${vertCount.toLocaleString()} vertices, ${tu.length.toLocaleString()} uvs, ${faceCount.toLocaleString()} triangles`);
	log(`  ${polyFaces} non-triangular faces, ${unmatchedPairs} v/vt index mismatches`);

	if (vertCount === 0 || faceCount === 0) {
		throw new Error(`\n${objFile} ne contient aucune géométrie — rien à convertir.`);
	}

	// parseMtl rend { materials, byName } où chaque matériau porte un `.jpg`
	// relatif au tileDir. On le résout ici : prep.mjs ne connaîtra plus tileDir.
	const materials = rawMaterials.map((m) => ({
		name: m.name,
		texture: m.jpg ? path.join(tileDir, m.jpg) : null,
	}));

	return { materials, byName, vx, vy, vz, tu, tv, triByMat,
		vertCount, faceCount, polyFaces, unmatchedPairs, attribution: [] };
}
