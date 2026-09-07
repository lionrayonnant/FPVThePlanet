// Le serveur autonome : le jeu sans Vite (issue #259).
//
//   node server/index.mjs [--data <dir>] [--port 8080] [--host 127.0.0.1]
//                         [--mode local|shared] [--open] [--dist <dir>]
//   node server/index.mjs key <operatorId> [--data <dir>]
//
// Variables d'environnement équivalentes : FPVTP_DATA_DIR, FPVTP_PORT,
// FPVTP_HOST, FPVTP_MODE. L'option de ligne de commande gagne. FPVTP_ACQUIRE
// (issue #60) n'a pas d'équivalent en ligne de commande à dessein : ce n'est pas
// un réglage de lancement, c'est un interrupteur d'environnement que la CI et
// electron-builder ne posent jamais — voir server/auth.mjs.
//
// L'API (server/api.mjs) est montée en premier, le serveur de fichiers
// (server/static.mjs) derrière : ce qui ne commence pas par /__operator ou
// /__map-api est un fichier.
//
// startServer() est exporté parce que le process principal d'Electron (T2) le
// démarrera dans son propre contexte Node, sans passer par cette CLI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.dirname(HERE);

const MODES = new Set(['local', 'shared']);
// `localhost` n'est qu'un alias des deux autres : il ne résout que sur la boucle
// locale.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const USAGE = `usage: node server/index.mjs [--data <dir>] [--port <n>] [--host <addr>]
                            [--mode local|shared] [--dist <dir>] [--open]
       node server/index.mjs key <operatorId> [--data <dir>]`;

export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--open') { out.open = true; continue; }
		if (a === '--help' || a === '-h') { out.help = true; continue; }
		const key = { '--data': 'dataDir', '--port': 'port', '--host': 'host', '--mode': 'mode', '--dist': 'distDir' }[a];
		if (!key) throw new Error(`option inconnue : ${a}\n${USAGE}`);
		const v = argv[++i];
		if (v === undefined) throw new Error(`${a} attend une valeur\n${USAGE}`);
		out[key] = v;
	}
	return out;
}

// Fusionne CLI, environnement et défauts. Le répertoire de données par défaut
// est celui du dépôt (tools/lib/paths.mjs) : c'est l'app installée qui posera
// le répertoire de plateforme, via --data, quand T2 l'apportera.
export function resolveOptions(cli = {}) {
	const port = cli.port ?? process.env.FPVTP_PORT ?? 8080;
	const opts = {
		dataDir: cli.dataDir ?? process.env.FPVTP_DATA_DIR ?? null,
		port: Number(port),
		host: cli.host ?? process.env.FPVTP_HOST ?? '127.0.0.1',
		mode: cli.mode ?? process.env.FPVTP_MODE ?? 'local',
		distDir: cli.distDir ?? path.join(SIM_ROOT, 'dist'),
		open: cli.open === true,
	};
	if (!MODES.has(opts.mode)) throw new Error(`mode inconnu : ${opts.mode} (local ou shared)`);
	if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
		throw new Error(`port invalide : ${port}`);
	}
	// LE garde-fou de la tranche T1 : en `local` la frontière de sécurité est le
	// socket local, la même qu'avec le serveur de dev depuis deux mois. Ouvrir
	// l'écoute demande de le dire explicitement — `shared` amènera sa propre
	// authentification (T3), et rien ne doit pouvoir s'exposer par accident
	// avant qu'elle existe.
	if (opts.mode === 'local' && !LOOPBACK.has(opts.host)) {
		throw new Error(`--host ${opts.host} refusé en mode local : hors de 127.0.0.1/::1, passez --mode shared`);
	}
	return opts;
}

// Résout le répertoire de données comme startServer(), et pour la même raison :
// tools/lib/paths.mjs lit FPVTP_DATA_DIR à SON import, il faut donc la poser
// avant. D'où l'import dynamique.
async function resolvePaths(cli = {}) {
	const dataDir = cli.dataDir ?? process.env.FPVTP_DATA_DIR ?? null;
	if (dataDir) process.env.FPVTP_DATA_DIR = path.resolve(dataDir);
	const { paths } = await import('../tools/lib/paths.mjs');
	return paths;
}

export async function startServer(cli = {}) {
	const opts = resolveOptions(cli);

	// tools/lib/paths.mjs lit FPVTP_DATA_DIR à SON import, et add-map-core comme
	// providers/google-earth en dérivent leurs constantes au leur : la variable
	// doit être posée avant le premier import de l'un d'eux. D'où l'import
	// dynamique ci-dessous — et le contrôle qui suit, pour qu'un second
	// startServer() sur un autre répertoire échoue franchement au lieu de servir
	// silencieusement les données du premier.
	if (opts.dataDir) process.env.FPVTP_DATA_DIR = path.resolve(opts.dataDir);
	const { paths } = await import('../tools/lib/paths.mjs');
	const wanted = opts.dataDir ? path.resolve(opts.dataDir) : paths.DATA_DIR;
	if (paths.DATA_DIR !== wanted) {
		throw new Error(`répertoire de données déjà figé sur ${paths.DATA_DIR} : ${wanted} arrive trop tard`);
	}

	const { createApi } = await import('./api.mjs');
	const { createStatic } = await import('./static.mjs');

	const api = createApi({ paths, mode: opts.mode, logger: console });
	const serveStatic = createStatic({ distDir: opts.distDir, paths });

	const server = http.createServer((req, res) => {
		api(req, res, () => serveStatic(req, res));
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); });
	});

	const addr = server.address();
	// Une adresse IPv6 s'écrit entre crochets dans une URL.
	const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
	const url = `http://${host}:${addr.port}/`;

	return {
		server, url, port: addr.port, paths, mode: opts.mode, distDir: opts.distDir,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

// Pas de dépendance npm pour ça : un spawn détaché de l'ouvreur de la
// plateforme suffit, et son échec ne doit pas emporter le serveur.
function openBrowser(url) {
	const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
		: process.platform === 'darwin' ? ['open', [url]]
			: ['xdg-open', [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => {});
		child.unref();
	} catch { /* pas de navigateur : ce n'est pas une raison d'arrêter le serveur */ }
}

// `key <operatorId>` : donne une clé neuve à un opérateur existant. Le seul
// chemin de récupération — une clé perdue ne se relit pas, elle se remplace — et
// la migration des fichiers d'avant #60, qui n'en ont aucune. Imprimée UNE fois
// sur stdout : le serveur n'en garde que l'empreinte.
async function keyCommand(argv) {
	const id = argv[0];
	if (!id || id.startsWith('-')) { console.error(`key attend un id d'opérateur\n${USAGE}`); process.exit(2); }
	let cli;
	try { cli = parseArgs(argv.slice(1)); }
	catch (e) { console.error(e.message); process.exit(2); }
	const paths = await resolvePaths(cli);
	const { issueKey } = await import('./auth.mjs');
	let key;
	try { key = issueKey(paths.OPERATOR_DIR, id); }
	catch (e) { console.error(`fpvtp: ${e.message}`); process.exit(1); }
	console.log(key);
	console.error(`fpvtp: nouvelle clé pour « ${id} » — notez-la, elle ne sera plus jamais affichée.`);
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === 'key') return keyCommand(argv.slice(1));

	let cli;
	try { cli = parseArgs(argv); }
	catch (e) { console.error(e.message); process.exit(2); }

	if (cli.help) { console.log(USAGE); return; }

	let started;
	try { started = await startServer(cli); }
	catch (e) { console.error(`fpvtp: ${e.message}`); process.exit(1); }

	const { version } = JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'package.json'), 'utf8'));
	const { acquireEnabled } = await import('./auth.mjs');
	const acquire = acquireEnabled(started.mode) ? 'acquisition ouverte' : 'acquisition fermée';
	console.log(`FPVTP! v${version} — mode ${started.mode} — ${acquire} — données ${started.paths.DATA_DIR} — ${started.url}`);
	if (!fs.existsSync(started.distDir)) {
		console.warn(`fpvtp: ${started.distDir} n'existe pas — lancez « npm run build », ou passez --dist`);
	}
	if (cli.open) openBrowser(started.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
