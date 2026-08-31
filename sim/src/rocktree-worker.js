// Fetch + décodage d'UN nœud rocktree, en direct, pendant le vol (#168).
// Miroir de src/worker.js (qui décode les chunks pré-cuits) : même motif de
// message { ok, ... }, mais ici rien n'est pré-cuit — le fetch() part
// pendant que le drone vole.
//
// Pas de `sharp` : le JPEG brut extrait du protobuf va directement à
// createImageBitmap(), le décodeur JPEG natif du navigateur — le même chemin
// que worker.js emprunte déjà pour les planches JPEG des chunks pré-cuits. La
// réparation des texels noirs (#158, qui utilise sharp côté Node) reste une
// passe de qualité pour le bake ; elle n'est pas requise pour qu'un nœud
// s'affiche et n'est pas dans ce périmètre.
//
// Pas de `signal` dans le message reçu : un AbortSignal n'est pas clonable
// par postMessage(). L'annulation est le problème de rocktree-loader.js, sur
// le fil principal (worker.terminate()), pas de celui-ci.
import { nodeUrl } from '../tools/lib/rocktree/url.mjs';
import { parseNode } from '../tools/lib/rocktree/proto.mjs';

self.onmessage = async (e) => {
	const { path, epoch, imageryEpoch, flags } = e.data;
	try {
		const url = nodeUrl({ path, epoch, imageryEpoch, flags });
		const res = await fetch(url);
		if (!res.ok) { const err = new Error(`${res.status} ${url}`); err.status = res.status; throw err; }
		const buf = new Uint8Array(await res.arrayBuffer());
		const node = parseNode(buf);

		const bitmaps = [];
		const meshes = await Promise.all(node.meshes.map(async (m) => {
			if (!m.texture) return { ...m, bitmap: null };
			const bitmap = await createImageBitmap(new Blob([m.texture.data]));
			bitmaps.push(bitmap);
			return { ...m, bitmap };
		}));

		self.postMessage(
			{ ok: true, matrix: node.matrix, copyrightIds: node.copyrightIds, meshes },
			bitmaps,
		);
	} catch (err) {
		self.postMessage({ ok: false, error: String((err && err.message) || err) });
	}
};
