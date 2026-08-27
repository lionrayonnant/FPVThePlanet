import mapApiPlugin from './tools/map-api-plugin.mjs';

export default {
	server: { port: 5173 },
	// L'API et la GUI d'ajout de cartes n'existent qu'en dev (apply: 'serve'),
	// et add-map.html n'est pas une entrée de build : rien de tout ça ne part en prod.
	plugins: [mapApiPlugin()],
	// Rapier ships as wasm; keeping it unbundled in dev avoids a re-optimise loop.
	optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
	build: { target: 'es2022' },
};
