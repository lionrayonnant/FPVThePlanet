// L'adaptateur Vite de l'API du jeu.
//
// Toute la logique vit dans server/api.mjs (issue #259) : ce fichier ne fait que
// monter le même middleware sur le connect que Vite expose déjà, avec son
// logger. `apply: 'serve'` le garde hors du build — en production c'est
// server/index.mjs qui sert la même API, et add-map.html reste une page de dev
// que Vite seul déclare en entrée.

import { createApi } from '../server/api.mjs';

export default function mapApiPlugin() {
	return {
		name: 'fpvtp-map-api',
		apply: 'serve',
		configureServer(server) {
			// Mounted DURING the hook, on purpose — and it has to be (issue #79).
			// Mounting here puts the API ahead of Vite's own middlewares, so
			// `hostCheckMiddleware` (allowedHosts, the CVE-2025-24010 fix) and
			// `corsMiddleware` never see /__operator nor /__map-api. Deferring it
			// by RETURNING the use() — the post hook, which is how Vite says to run
			// after those — would put the API behind `htmlFallbackMiddleware` too:
			// that one rewrites every GET whose Accept allows HTML to /index.html,
			// so the routes would answer the page instead of JSON and the game
			// would break. There is no position that has one without the other.
			//
			// So the API carries its own guard instead, in server/api.mjs
			// (server/origin.mjs): loopback-only Host, and no cross-site unsafe
			// method. It is stricter than allowedHosts, and it protects the
			// standalone server as well, which Vite never covered.
			server.middlewares.use(createApi({ mode: 'local', logger: server.config.logger }));
			server.config.logger.info(`  ➜  Cartes:  http://localhost:${server.config.server.port ?? 5173}/add-map.html`);
		},
	};
}
