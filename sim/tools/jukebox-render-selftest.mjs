// Selftest de l'ÉCRAN jukebox et de la radio (issue #120), monté sur le faux
// DOM. Comme bench-render-selftest.mjs : on vérifie l'ARBRE et le CÂBLAGE, pas
// l'apparence.
//
// La lecture passe par un faux `music` injecté dans la radio : ce qui compte
// ici n'est pas le son mais AVEC QUOI on appelle play() — `loop: false` et
// `remember: false` sont deux garanties qu'aucun test d'apparence n'attraperait.
//
// Lancer : node tools/jukebox-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

// AVANT l'import des écrans : menu-nav.js s'abonne à window au chargement.
const dom = installFakeDom();
const { runJukebox } = await import('../src/jukebox.js');
const { radio } = await import('../src/radio.js');
const { jukeboxRow, nowPlayingLine, STOPPED_LINE } = await import('./jukebox-model.mjs');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Mêmes compteurs de minuteurs que bench-render-selftest : un écran qui part
// sans se démonter les laisse battre sur un nœud détaché.
const _live = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
	const id = _setTimeout((...a) => { _live.delete(id); return fn(...a); }, ms, ...rest);
	_live.add(id);
	return id;
};
globalThis.clearTimeout = (id) => { _live.delete(id); return _clearTimeout(id); };
const timersAlive = () => _live.size;

const tick = () => new Promise((r) => _setTimeout(r, 0));

const track = (pool, id, durS = 84, bpm = 120) => ({
	id: `${pool}-${id}`, pool, file: `music/${pool}/${pool}-${id}.opus`, durS, bpm,
});

const MANIFEST = {
	schemaVersion: 1,
	tracks: [track('race5', 'cccc'), track('menu', 'aaaa'), track('menu', 'bbbb')],
};
// L'ordre attendu après buildLibrary : menu avant race5, id croissant.
const ORDER = ['menu-aaaa', 'menu-bbbb', 'race5-cccc'];

// Un faux `music` : il RECENSE. Aucun Web Audio, aucun fetch.
function fakeMusic(manifest = MANIFEST) {
	const calls = { play: [], decode: [], prepare: [], setVolume: [], kill: 0 };
	const m = {
		playing: false,
		_onEnded: null,
		async loadManifest() { return manifest; },
		async decode(entry) { calls.decode.push(entry.id); return { entry, buffer: {} }; },
		async prepare(entry) { calls.prepare.push(entry.id); return { entry, buffer: {} }; },
		play(opts) {
			calls.play.push(opts);
			m._onEnded = opts.onEnded ?? null;
			m.playing = true;
			return true;
		},
		kill() { calls.kill++; m.playing = false; m._onEnded = null; },
		setVolume(v) { calls.setVolume.push(v); },
		// La fin naturelle d'un morceau, telle que music.js la déclenche.
		fireEnd() { const cb = m._onEnded; m.playing = false; m._onEnded = null; cb?.(); },
	};
	return { m, calls };
}

const rows = () => dom.root.querySelectorAll('.terminal-row');
const btn = (label) => dom.root.querySelectorAll('button').find((b) => b.textContent.trim() === label);
const nowLine = () => dom.root.querySelectorAll('pre').find((p) => p.textContent.startsWith('ON AIR'));

// Écran neuf : stockage vide, radio remise à zéro, faux music injecté.
async function open(manifest = MANIFEST) {
	dom.storage.clear();
	dom.root.replaceChildren();
	dom.setActive(null);
	radio._reset();
	const { m, calls } = fakeMusic(manifest);
	radio._setMusic(m);
	const p = runJukebox(dom.root);
	await tick();
	return { p, m, calls };
}

await ta('la liste rend une ligne par morceau, dans l\'ordre du modèle', async () => {
	const { p } = await open();
	const labels = rows().map((r) => r.textContent);
	assert.equal(labels.length, 3);
	assert.deepEqual(labels, ORDER.map((id) => {
		const t = MANIFEST.tracks.find((x) => x.id === id);
		return jukeboxRow(t, { playing: false });
	}));
	assert.equal(nowLine().textContent, STOPPED_LINE);
	dom.key('Escape');
	await p;
});

await ta('un clic joue le bon morceau, sans boucler et SANS retenir le récent', async () => {
	const { p, calls } = await open();
	rows()[1].click();
	await tick();

	assert.equal(calls.play.length, 1);
	const opts = calls.play[0];
	assert.equal(opts.ready.entry.id, 'menu-bbbb');
	// Les deux garanties de la radio. `loop` faux est ce qui lui donne une fin
	// à laquelle enchaîner ; `remember` faux protège l'anneau des récents du
	// jeu, qu'une session d'écoute remplirait en douze morceaux.
	assert.equal(opts.loop, false);
	assert.equal(opts.remember, false);
	assert.equal(typeof opts.onEnded, 'function');
	// À plat : la radio n'est pas la musique du vol.
	assert.equal(opts.intensity, 1);

	assert.equal(radio.owns, true);
	assert.equal(radio.current.id, 'menu-bbbb');
	assert.equal(calls.setVolume.length, 1);
	dom.key('Escape');
	await p;
});

await ta('la radio précharge par decode() et n\'appelle JAMAIS prepare()', async () => {
	// prepare() écrit dans music.pending, créneau UNIQUE partagé avec le jeu :
	// un hack lancé pendant que la radio joue y échangerait son buffer.
	const { p, calls } = await open();
	rows()[0].click();
	await tick();
	assert.deepEqual(calls.prepare, []);
	assert.ok(calls.decode.includes('menu-aaaa'), 'le morceau joué');
	assert.ok(calls.decode.includes('menu-bbbb'), 'et le suivant, préchargé');
	dom.key('Escape');
	await p;
});

await ta('la ligne ON AIR et le marqueur suivent l\'antenne', async () => {
	const { p } = await open();
	rows()[2].click();
	await tick();
	const played = MANIFEST.tracks.find((x) => x.id === 'race5-cccc');
	assert.equal(nowLine().textContent, nowPlayingLine(played));
	assert.equal(rows()[2].textContent, jukeboxRow(played, { playing: true }));
	assert.equal(rows()[0].textContent, jukeboxRow(MANIFEST.tracks.find((x) => x.id === 'menu-aaaa'), { playing: false }));
	assert.equal(btn('STOP')?.textContent, 'STOP');
	dom.key('Escape');
	await p;
});

await ta('NEXT et PREV circulent, ←/→ font la même chose', async () => {
	const { p } = await open();
	rows()[0].click();
	await tick();
	assert.equal(radio.index, 0);

	btn('NEXT').click();
	await tick();
	assert.equal(radio.current.id, ORDER[1]);

	dom.key('ArrowRight');
	await tick();
	assert.equal(radio.current.id, ORDER[2]);

	// Circulaire : depuis la dernière, on revient à la première.
	dom.key('ArrowRight');
	await tick();
	assert.equal(radio.current.id, ORDER[0]);

	btn('PREV').click();
	await tick();
	assert.equal(radio.current.id, ORDER[2]);
	dom.key('Escape');
	await p;
});

await ta('l\'enchaînement repeint SANS reconstruire la liste', async () => {
	// Le point de l'écran : l'avance automatique survient pendant qu'on parcourt
	// la liste, et un replaceChildren() à cet instant arracherait le curseur.
	const { p, m } = await open();
	rows()[0].click();
	await tick();
	const before = rows();
	const firstEl = before[0];

	m.fireEnd();
	await tick();

	const after = rows();
	assert.equal(radio.current.id, ORDER[1], 'la radio a bien avancé');
	assert.equal(after[0], firstEl, 'le même élément de ligne, pas un neuf');
	assert.equal(after.length, before.length);
	assert.equal(after[1].textContent, jukeboxRow(MANIFEST.tracks.find((x) => x.id === ORDER[1]), { playing: true }));
	dom.key('Escape');
	await p;
});

await ta('le filtre de pool ne montre que son pool', async () => {
	const { p } = await open();
	btn('RACE5').click();
	assert.deepEqual(rows().map((r) => r.textContent.includes('RACE5')), [true]);
	btn('ALL').click();
	assert.equal(rows().length, 3);
	dom.key('Escape');
	await p;
});

await ta('Échap remonte, détache — et la radio CONTINUE de jouer', async () => {
	// La décision qui fait de cette fonctionnalité une radio et non un lecteur.
	const { p, m, calls } = await open();
	rows()[0].click();
	await tick();
	const played = calls.play.length;

	dom.key('Escape');
	await p;

	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'l\'écran est parti');
	assert.equal(radio.owns, true, 'la radio tient toujours l\'antenne');
	assert.equal(calls.play.length, played, 'et rien n\'a été relancé');

	// Et elle enchaîne encore, écran fermé.
	m.fireEnd();
	await tick();
	assert.equal(radio.current.id, ORDER[1]);
	assert.equal(calls.play.length, played + 1);
});

await ta('STOP rend l\'antenne', async () => {
	const { p, calls } = await open();
	rows()[0].click();
	await tick();
	btn('STOP').click();
	await tick();
	assert.equal(calls.kill, 1);
	assert.equal(radio.owns, false);
	assert.equal(nowLine().textContent, STOPPED_LINE);
	dom.key('Escape');
	await p;
});

await ta('une bibliothèque vide le dit et ne casse rien', async () => {
	const { p } = await open({ schemaVersion: 1, tracks: [] });
	assert.equal(rows().length, 0);
	assert.ok(dom.root.textContent.includes('NO MUSIC LIBRARY'));
	// La transport sur une bibliothèque vide ne doit pas jeter.
	btn('NEXT').click();
	await tick();
	assert.equal(radio.owns, false);
	dom.key('Escape');
	await p;
});

await ta('l\'écran ne laisse aucun minuteur derrière lui', async () => {
	const before = timersAlive();
	const { p } = await open();
	rows()[0].click();
	await tick();
	dom.key('Escape');
	await p;
	await tick();
	assert.ok(timersAlive() <= before, `minuteurs : ${before} avant, ${timersAlive()} après`);
});

radio._reset();
dom.restore();
console.log(`\n${n} tests jukebox-render OK`);
