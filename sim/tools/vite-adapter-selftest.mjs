// Check de fumée de l'adaptateur Vite (tools/map-api-plugin.mjs).
//
// Depuis l'extraction du serveur autonome (issue #259), toute l'API vit dans
// server/api.mjs et session-api-selftest.mjs l'exerce sans Vite. Ce fichier est
// la seule chose qui garde l'adaptateur honnête : il démarre un vrai
// `npm run dev` et vérifie que les DEUX préfixes répondent, avec le même
// contrat qu'en autonome. Sans lui, le plugin pourrait dériver du serveur sans
// qu'aucun test ne le voie.
//
// Volontairement minimal : un boot de Vite, trois requêtes. Le contenu des
// routes se teste ailleurs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-vite-'));
process.env.FPVTP_DATA_DIR = DIR;
delete process.env.FPV_OPERATOR_DIR;

const { createServer } = await import('vite');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// `strictPort: false` + port 0 : n'importe quel port libre, pour ne pas entrer
// en collision avec un `npm run dev` déjà ouvert. On lit l'URL que Vite a
// RÉSOLUE plutôt que de la reconstruire : `httpServer.address()` rend le port
// mais pas l'hôte, et Vite écoute sur `localhost` — qui vaut `::1` ici, pas
// `127.0.0.1`.
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

try {
	const scenes = await fetch(base + '/__map-api/scenes');
	check('npm run dev répond sur /__map-api/scenes',
		scenes.status === 200
		&& scenes.headers.get('cache-control') === 'no-store'
		&& Array.isArray((await scenes.json()).scenes));

	const operators = await fetch(base + '/__operator');
	check('… et sur /__operator', operators.status === 200
		&& Array.isArray((await operators.json()).operators));

	// L'adaptateur doit rendre la main à Vite sur tout le reste : sans le
	// `next()`, la page ne se chargerait plus.
	const page = await fetch(base + '/');
	check('… et laisse Vite servir la page',
		page.ok && (page.headers.get('content-type') ?? '').includes('html'));
} finally {
	await server.close();
	fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
