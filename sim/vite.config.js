export default {
	server: { port: 5173 },
	// Rapier ships as wasm; keeping it unbundled in dev avoids a re-optimise loop.
	optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
	build: { target: 'es2022' },
};
