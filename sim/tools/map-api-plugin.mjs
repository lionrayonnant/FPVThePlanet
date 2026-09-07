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
		name: 'fpvmaps-map-api',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use(createApi({ mode: 'local', logger: server.config.logger }));
			server.config.logger.info(`  ➜  Cartes:  http://localhost:${server.config.server.port ?? 5173}/add-map.html`);
		},
	};
}
