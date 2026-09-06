// node tools/loader-guard-selftest.mjs — le chargeur face à un fichier absent
// (issue #275).
//
// Le piège que ce fichier verrouille : un serveur statique de SPA ne rend PAS
// 404 sur un fichier absent. Vite — et n'importe quel hébergement avec un
// fallback SPA — rabat la requête sur index.html et répond 200 text/html.
// `res.ok` est donc vrai pour une scène qui n'existe pas, et le `res.json()`
// qui suit meurt sur « Unexpected token '<' ». Les réponses ne se distinguent
// que par le TYPE DE CONTENU.
//
// Les faux `fetch` ci-dessous reproduisent les deux réponses au mot près,
// telles que `curl -I` les a mesurées sur le serveur de dev.
import { loadManifest, loadSceneList, sceneBase } from '../src/loader.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

// Ce que Vite renvoie pour un fichier statique absent : le index.html du jeu,
// en 200. C'est ce corps-là qui produit le « Unexpected token '<' ».
const INDEX_HTML = '<!doctype html>\n<html lang="fr">\n  <head><title>FPVThePlanet!</title></head>\n</html>\n';

function htmlFallback() {
	return new Response(INDEX_HTML, {
		status: 200,
		headers: { 'content-type': 'text/html' },
	});
}
function jsonBody(obj) {
	return new Response(JSON.stringify(obj), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

// Une scène présente et une scène fantôme, servies par le même faux serveur.
const MANIFEST = { version: 2, origin: { latitude: 48.8583, longitude: 2.297, altitude: 99 }, chunks: [] };
const CATALOGUE = [{ slug: 'presente', name: 'Présente' }, { slug: 'fantome', name: 'Fantôme' }];

function server({ catalogue = CATALOGUE, present = ['presente'] } = {}) {
	const seen = [];
	globalThis.fetch = async (url, opts) => {
		seen.push({ url: String(url), method: opts?.method ?? 'GET' });
		const u = String(url);
		if (u.endsWith('scenes.json')) return catalogue === 'html' ? htmlFallback() : jsonBody(catalogue);
		const m = u.match(/scenes\/([^/]+)\/manifest\.json$/);
		if (m) return present.includes(m[1]) ? jsonBody(MANIFEST) : htmlFallback();
		return htmlFallback();
	};
	return seen;
}

console.log('loader-guard');

// 1. Le cas du rapport de bug : boot sur une scène absente.
{
	server();
	let err = null;
	try {
		await loadManifest(sceneBase('fantome'));
	} catch (e) {
		err = e;
	}
	check('scène absente : loadManifest() lève', err !== null);
	check('scène absente : ce n\'est PAS un SyntaxError de JSON.parse',
		err !== null && !(err instanceof SyntaxError),
		err ? `${err.constructor.name}` : 'aucune erreur');
	// Le message doit être actionnable : il nomme le fichier et dit quoi faire.
	check('scène absente : le message nomme le fichier attendu',
		err !== null && /manifest\.json/.test(err.message), err?.message);
	check('scène absente : le message dit que la scène n\'est pas installée',
		err !== null && /install/i.test(err.message), err?.message);
}

// 2. La même fonction, sur une scène qui existe : rien ne change.
{
	server();
	const m = await loadManifest(sceneBase('presente'));
	check('scène présente : le manifeste est rendu tel quel', m.version === 2 && m.origin.latitude === 48.8583);
}

// 3. Le garde-fou anti-fantômes de loadSceneList() filtre POUR DE VRAI.
//    C'est lui qui laissait le joueur choisir une scène absente : il gardait
//    la scène dès que `r.ok`, ce qui est toujours le cas avec un fallback SPA.
{
	const seen = server();
	const list = await loadSceneList();
	check('catalogue : la scène fantôme est retirée', list.length === 1 && list[0].slug === 'presente',
		list.map((s) => s.slug).join(', ') || '(vide)');
	check('catalogue : le test de présence reste un HEAD (on ne télécharge pas les manifestes)',
		seen.filter((r) => /manifest\.json$/.test(r.url)).every((r) => r.method === 'HEAD'));
}

// 4. Et si c'est scenes.json LUI-MÊME qui est absent, on le dit au lieu de
//    laisser JSON.parse parler à notre place.
{
	server({ catalogue: 'html' });
	let err = null;
	try {
		await loadSceneList();
	} catch (e) {
		err = e;
	}
	check('scenes.json absent : loadSceneList() lève un message lisible',
		err !== null && !(err instanceof SyntaxError) && /scenes\.json/.test(err.message),
		err ? `${err.constructor.name}: ${err.message}` : 'aucune erreur');
}

// 5. Un vrai 404 (serveur statique sans fallback) reste couvert, évidemment.
{
	globalThis.fetch = async () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
	let err = null;
	try {
		await loadManifest(sceneBase('fantome'));
	} catch (e) {
		err = e;
	}
	check('404 franc : loadManifest() lève toujours', err !== null && !(err instanceof SyntaxError), err?.message);
}

console.log(failures ? `\n${failures} échec(s).` : '\n5 blocs, tout passe.');
process.exit(failures ? 1 : 0);
