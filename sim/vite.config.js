import { readFileSync } from 'node:fs';
import mapApiPlugin from './tools/map-api-plugin.mjs';

// The build version comes from package.json (see CHANGELOG.md and
// tools/release.mjs): a single source of truth, injected at compile time.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default {
	server: { port: 5173 },
	// The map-adding API and GUI only exist in dev (apply: 'serve'), and
	// add-map.html is not a build entry: none of it ships to production.
	plugins: [mapApiPlugin()],
	// Rapier ships as wasm; keeping it unbundled in dev avoids a re-optimise loop.
	optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
	define: { __APP_VERSION__: JSON.stringify(version) },
	build: {
		target: 'es2022',
		// Vendor split (#21). Before: a single 2.9 MB chunk (1 MB gzipped) that
		// the slightest edit to the game invalidated whole. Three and Rapier
		// only change on a dependency bump: in their own chunk they stay in the
		// browser cache (`immutable`, server/static.mjs) from one game update
		// to the next, and download in parallel with the game code on a first
		// load. Rapier needs no naming here: physics.js loads it through a
		// dynamic import(), so Vite makes a chunk of it by itself. Leaflet and
		// geoman already follow scanner.js (dynamic import).
		// Rolldown (Vite 8) only takes the FUNCTION form of manualChunks: the
		// object form silently became "Invalid type: Expected Function but
		// received Object" and then threw. Same split, spelled the way the new
		// bundler reads it.
		rollupOptions: {
			output: {
				manualChunks: (id) => (/node_modules[\\/]three[\\/]/.test(id) ? 'three' : undefined),
			},
		},
		// Computing gzip sizes on every build is information, not a check —
		// tools/precompress.mjs produces the real .br/.gz.
		reportCompressedSize: false,
	},
};
