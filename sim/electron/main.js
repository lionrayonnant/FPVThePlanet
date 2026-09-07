// Le process principal d'Electron : il EST le serveur du jeu (issue #259,
// tranche T2).
//
// Electron embarque déjà Node et Chromium dans un seul binaire : pas de second
// runtime à côté, pas de sous-processus. `server/index.mjs` (tranche T1) est
// importé ici et démarré dans ce contexte Node, sur 127.0.0.1 port 0 — un port
// éphémère ne peut entrer en collision avec rien, et la boucle locale reste la
// frontière de sécurité du mode `local`. Une fois le serveur en écoute, une
// BrowserWindow charge l'URL résolue ; le renderer est le `dist/` inchangé.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';

import { startServer } from '../server/index.mjs';

const { autoUpdater } = electronUpdater;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(HERE);

// Le VPS qui hébergera les flux de mise à jour n'existe pas encore (tranche
// T4) : l'URL d'`electron-builder.yml` est un point d'ancrage, pas un domaine.
// `.invalid` est réservé par la RFC 2606 et ne résoudra jamais — tant qu'elle
// est en place, la vérification est sautée plutôt que d'échouer en boucle dans
// le dos du joueur. FPVTP_UPDATE_URL la remplace sans reconstruire l'app.
const PLACEHOLDER_MARK = '.invalid';

let serverHandle = null;

function log(line) {
	console.log(`fpvtp: ${line}`);
}

// electron-builder écrit app-update.yml à côté des ressources ; c'est lui qui
// porte le provider et l'URL bakés au build.
function bakedFeed() {
	try {
		return fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
	} catch { return null; }
}

function wireUpdater() {
	// electron-updater refuse de tourner hors d'une app packagée, et c'est bien :
	// `npm run electron` ne doit pas aller chercher une release.
	if (!app.isPackaged) return;

	const override = process.env.FPVTP_UPDATE_URL?.trim();
	if (override) {
		autoUpdater.setFeedURL({ provider: 'generic', url: override });
	} else {
		const baked = bakedFeed();
		if (!baked) return void log('mise à jour désactivée : pas de app-update.yml');
		if (baked.includes(PLACEHOLDER_MARK)) {
			return void log('mise à jour désactivée : le flux est encore le placeholder (tranche T4)');
		}
	}

	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.on('error', (e) => log(`mise à jour : ${e?.message ?? e}`));
	autoUpdater.on('update-available', (i) => log(`mise à jour ${i?.version} disponible, téléchargement`));
	autoUpdater.on('update-downloaded', async (info) => {
		const { response } = await dialog.showMessageBox({
			type: 'info',
			buttons: ['Redémarrer maintenant', 'Plus tard'],
			defaultId: 0,
			cancelId: 1,
			title: 'Mise à jour prête',
			message: `FPVTP! ${info?.version ?? ''} est téléchargée.`,
			detail: 'Elle s\'installera au prochain démarrage.',
		});
		if (response === 0) autoUpdater.quitAndInstall();
	});
	autoUpdater.checkForUpdates().catch((e) => log(`mise à jour : ${e?.message ?? e}`));
}

function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		show: false,
		autoHideMenuBar: true,
		// Le fond du terminal opérateur : sans lui la fenêtre flashe en blanc
		// avant le premier rendu.
		backgroundColor: '#121110',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			// Le jeu tourne sur requestAnimationFrame ; Chromium étrangle les
			// frames d'une fenêtre en arrière-plan, ce qui ferait décrocher la
			// physique au premier alt-tab.
			backgroundThrottling: false,
		},
	});

	win.once('ready-to-show', () => win.show());

	// Une fenêtre noire ne dit rien par elle-même : sans ces relais, l'échec du
	// bundle, d'un worker ou du contexte WebGL reste dans une console que
	// personne n'ouvre. Tout remonte donc sur la sortie du process principal.
	const wc = win.webContents;
	wc.on('console-message', (_e, level, message, line, source) => {
		if (level >= 2) log(`renderer: ${message} (${source}:${line})`);
	});
	wc.on('did-fail-load', (_e, code, desc, url) => log(`chargement échoué ${code} ${desc} — ${url}`));
	wc.on('render-process-gone', (_e, details) => log(`renderer perdu : ${details.reason}`));
	wc.on('unresponsive', () => log('renderer figé'));
	// Rien du jeu ne s'ouvre dans une seconde fenêtre : un lien externe part
	// dans le navigateur du système.
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		shell.openExternal(target);
		return { action: 'deny' };
	});

	win.loadURL(url);
	return win;
}

async function boot() {
	// Le répertoire de données est celui de la plateforme, hors du dossier du
	// programme : une mise à jour remplace l'app et ne touche à rien des scènes,
	// des sessions ni de l'état opérateur.
	const dataDir = app.getPath('userData');

	try {
		serverHandle = await startServer({
			dataDir,
			host: '127.0.0.1',
			port: 0,
			mode: 'local',
			distDir: path.join(APP_ROOT, 'dist'),
		});
	} catch (e) {
		dialog.showErrorBox('FPVTP! n\'a pas pu démarrer', String(e?.stack ?? e));
		app.exit(1);
		return;
	}

	log(`v${app.getVersion()} — données ${dataDir} — ${serverHandle.url}`);
	createWindow(serverHandle.url);
	wireUpdater();
}

// Sous Windows, `userData` tombe par défaut dans %APPDATA% — le profil
// itinérant, que certains domaines synchronisent sur le réseau. Une scène pèse
// des centaines de mégaoctets : la spec (#259, D3) nomme %LOCALAPPDATA%\FPVTP,
// et c'est là que ça doit vivre.
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
	app.setPath('userData', path.join(process.env.LOCALAPPDATA, app.getName()));
}

// Un joueur double-clique deux fois sur l'icône : la seconde instance rend la
// main à la première au lieu d'ouvrir un second serveur.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const [win] = BrowserWindow.getAllWindows();
		if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
	});

	app.whenReady().then(boot);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && serverHandle) createWindow(serverHandle.url);
	});

	app.on('window-all-closed', () => app.quit());

	// Fermer le socket avant de rendre la main. server.close() attend la fin des
	// connexions en cours : une keep-alive laissée par le renderer, ou le
	// téléchargement d'un chunk de scène de 40 Mo, tiendrait le process en vie
	// indéfiniment. On coupe donc les connexions, et un délai de garde assure
	// que fermer la fenêtre ferme toujours l'app.
	app.on('will-quit', (e) => {
		if (!serverHandle) return;
		const handle = serverHandle;
		serverHandle = null;
		e.preventDefault();
		handle.server.closeAllConnections?.();
		const quit = () => app.quit();
		const guard = setTimeout(quit, 2000);
		handle.close().finally(() => { clearTimeout(guard); quit(); });
	});
}
