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
// par postMessage(). L'annulation est le problème du fil principal
// (rocktree-worker-pool.js), pas de celui-ci : ce worker étant PARTAGÉ, elle
// ne peut plus le terminer — elle saute la requête si elle est encore en file,
// et sinon laisse celle-ci finir et ignore sa réponse.
import { nodeUrl } from '../tools/lib/rocktree/url.mjs';
import { parseNode } from '../tools/lib/rocktree/proto.mjs';
import { buildNodeGeometries } from '../tools/lib/rocktree/build-node.mjs';

// Persistant (#170) : ce worker traite UN message, répond, et REVIENT
// écouter — contrairement à un usage un-coup comme celui que loadChunks()
// fait de worker.js. L'appelant (rocktree-worker-pool.js) crée un petit
// nombre de ces workers une fois pour toute la session de vol et les
// réutilise ; `id` corrèle chaque réponse à sa requête, plusieurs pouvant
// être en vol en même temps sur le même worker comme sur d'autres du pool —
// ce handler est asynchrone, donc rien ne les sérialise ici. C'est le pool
// qui borne leur nombre (#179), pas ce fichier.
//
// Le build géométrique (ECEF→ENU, strip→triangles, UV, boundingSphere)
// tourne ICI (#187) : sur le fil principal il participait à faire déborder
// la frame de 16,7 ms pendant les vagues, ce qui amorçait la spirale de
// rattrapage de l'accumulateur physique. sphereRadius/originEcef/originBasis
// arrivent avec chaque requête (stateless), fournis par la fenêtre.
self.onmessage = async (e) => {
	const { id, path, epoch, imageryEpoch, flags, sphereRadius, originEcef, originBasis, exclude } = e.data;
	try {
		const url = nodeUrl({ path, epoch, imageryEpoch, flags });
		const res = await fetch(url);
		if (!res.ok) { const err = new Error(`${res.status} ${url}`); err.status = res.status; throw err; }
		const buf = new Uint8Array(await res.arrayBuffer());
		const node = parseNode(buf);

		const geoms = buildNodeGeometries({
			matrix: node.matrix, meshes: node.meshes, sphereRadius, originEcef, originBasis, exclude,
		});
		const transfers = [];
		const meshes = (await Promise.all(node.meshes.map(async (m, i) => {
			const g = geoms[i];
			// 0 triangle : le sous-maillage tronque entièrement à layerBounds[3]
			// (ou tous ses triangles sont dégénérés/exclus). Rien à dessiner NI
			// à collisionner — passer quand même sa texture (jusqu'à 580 Kio
			// d'ImageBitmap décodé, #191) au fil principal serait du travail
			// jeté, et lui faire atteindre physics.addNodeCollider() plante le
			// WASM de Rapier (trimesh à 0 triangle, mesuré hors navigateur).
			if (g.indices.length === 0) return null;
			transfers.push(g.positions.buffer, g.indices.buffer);
			if (g.uvs) transfers.push(g.uvs.buffer);
			let bitmap = null;
			if (m.texture) {
				bitmap = await createImageBitmap(new Blob([m.texture.data]));
				transfers.push(bitmap);
			}
			return { ...g, bitmap };
		}))).filter(Boolean);

		// Les buffers construits et les bitmaps sont TRANSFÉRÉS (zéro copie).
		// buf (le protobuf brut) meurt ici : plus rien côté fil principal n'en
		// consomme une vue depuis que le build se fait dans ce worker.
		self.postMessage(
			{ id, ok: true, matrix: node.matrix, copyrightIds: node.copyrightIds, meshes },
			transfers,
		);
	} catch (err) {
		// status: 404/410 = nœud absent, résultat NORMAL du protocole rocktree
		// (voir tools/lib/providers/google-earth.mjs), pas une panne — le fil
		// principal doit pouvoir le distinguer sans parser le message d'erreur.
		self.postMessage({ id, ok: false, error: String((err && err.message) || err), status: err?.status ?? null });
	}
};
