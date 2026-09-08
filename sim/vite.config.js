import { readFileSync } from 'node:fs';
import mapApiPlugin from './tools/map-api-plugin.mjs';

// La version du build vient de package.json (voir CHANGELOG.md et
// tools/release.mjs) : une seule source de vérité, injectée à la compilation.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default {
	server: { port: 5173 },
	// L'API et la GUI d'ajout de cartes n'existent qu'en dev (apply: 'serve'),
	// et add-map.html n'est pas une entrée de build : rien de tout ça ne part en prod.
	plugins: [mapApiPlugin()],
	// Rapier ships as wasm; keeping it unbundled in dev avoids a re-optimise loop.
	optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
	define: { __APP_VERSION__: JSON.stringify(version) },
	build: {
		target: 'es2022',
		// Découpage des vendeurs (#21). Avant : un seul chunk de 2,9 Mo
		// (1 Mo gzip) que la moindre retouche du jeu invalidait en entier. Trois
		// et Rapier ne changent qu'à une montée de version de dépendance : dans
		// leur propre chunk, ils restent en cache navigateur (`immutable`,
		// server/static.mjs) d'une mise à jour du jeu à l'autre, et se
		// téléchargent en parallèle du code du jeu au premier chargement.
		// Rapier n'a pas besoin d'être nommé ici : physics.js le charge par
		// import() dynamique, Vite en fait un chunk de lui-même. Leaflet et
		// geoman suivent déjà scanner.js (import dynamique).
		rollupOptions: {
			output: {
				manualChunks: {
					three: ['three'],
				},
			},
		},
		// Le calcul des tailles gzip à chaque build est de l'information, pas
		// une vérification — tools/precompress.mjs produit les vrais .br/.gz.
		reportCompressedSize: false,
	},
};
