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
	build: { target: 'es2022' },
};
