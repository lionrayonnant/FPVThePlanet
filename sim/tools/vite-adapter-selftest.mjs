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
import http from 'node:http';
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

	// The origin guard travels with the API (issue #79), and it counts double
	// here: the plugin mounts the API ahead of Vite's middlewares, so
	// `allowedHosts` (the CVE-2025-24010 fix) covers neither /__operator nor
	// /__map-api — this guard, alone, is what closes DNS rebinding in dev.
	// fetch() protects `Host`; node:http sends what it is given.
	const u = new URL(base);
	const withHost = (host) => new Promise((resolve, reject) => {
		const r = http.request({
			hostname: u.hostname, port: u.port, path: '/__map-api/scenes', headers: { host },
		}, (res) => { res.resume(); resolve(res.statusCode); });
		r.on('error', reject);
		r.end();
	});
	check('npm run dev: a foreign Host is refused on the API (DNS rebinding)',
		await withHost('attacker.example') === 403);
	check('… and loopback passes',
		await withHost(`localhost:${u.port}`) === 200);

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
