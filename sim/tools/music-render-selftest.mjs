// Selftest du GRAPHE de src/music.js (issue #120). Le modèle pur est déjà
// couvert par music-selftest.mjs ; ici on monte les vraies voix sur un faux
// AudioContext pour affirmer ce qu'aucun test pur ne peut voir : qui possède
// `onended`, et ce qu'il fait selon la raison pour laquelle il part.
//
// C'est le test du piège de la radio. Une voix bouclée ne se termine jamais
// d'elle-même, donc `onended` ne partait historiquement que du stop() de
// _retire(). Une voix NON bouclée, elle, se termine toute seule — et c'est le
// signal d'enchaînement de la radio. Les deux passent par le même rappel : si
// rien ne les distingue, un NEXT pressé pendant un fondu fait double-avancer.
//
// Lancer : node tools/music-render-selftest.mjs
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';

// AVANT l'import de src/music.js : son constructeur lit localStorage.
const dom = installFakeDom();
const bus = await import('../src/audio-bus.js');
const { Music } = await import('../src/music.js');

const RECENT_KEY = 'fpvtp.musicRecent';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Un contexte neuf, un stockage vide, une Music neuve — dans cet ordre : la
// Music lit les récents à la construction.
const fresh = () => {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	dom.storage.clear();
	return { ctx, m: new Music() };
};

// Un morceau déjà décodé, dans la forme que rend decode().
const ready = (id) => ({
	entry: { id, pool: 'menu', file: `music/menu/${id}.opus`, durS: 84, bpm: 90 },
	buffer: { duration: 84 },
});

const parts = (voice) => [voice.source, voice.lowpass, voice.gain, voice.duck];

t('play() : le défaut boucle, monte 4 nœuds, atteint le bus musique', () => {
	const { ctx, m } = fresh();
	m.pending = ready('menu-aaaa');
	assert.equal(m.play(), true);
	assert.equal(m.current.source.loop, true);
	assert.equal(m.nodesCreated, 4);
	assert.ok(reaches(ctx, m.current.source.id, bus.musicIn().id));
});

t('play() : le défaut consomme le créneau partagé et retient le récent', () => {
	const { m } = fresh();
	m.pending = ready('menu-bbbb');
	m.play();
	assert.equal(m.pending, null);
	assert.deepEqual(JSON.parse(dom.localStorage.getItem(RECENT_KEY)), ['menu-bbbb']);
});

t('play({ ready }) ne vide PAS le créneau partagé', () => {
	// L'invariant qui protège la radio : le jeu peut avoir préparé son morceau
	// de hack pendant qu'elle joue, et elle ne doit pas le lui manger.
	const { m } = fresh();
	const shared = ready('menu-hack');
	m.pending = shared;
	m.play({ ready: ready('menu-radio'), loop: false, remember: false });
	assert.equal(m.pending, shared);
});

t('play({ remember: false }) ne touche pas l\'anneau des récents', () => {
	const { m } = fresh();
	m.play({ ready: ready('menu-cccc'), loop: false, remember: false });
	assert.equal(dom.localStorage.getItem(RECENT_KEY), null);
	assert.deepEqual(m.recent, []);
});

t('play({ loop: false }) : une fin naturelle s\'annonce UNE fois et démonte', () => {
	const { m } = fresh();
	const ended = [];
	m.play({ ready: ready('menu-dddd'), loop: false, remember: false, onEnded: (e) => ended.push(e.id) });
	const voice = m.current;
	assert.equal(voice.source.loop, false);
	assert.equal(voice.retired, false);

	voice.source.onended();

	assert.deepEqual(ended, ['menu-dddd']);
	// Plus rien ne joue : c'est ce qui rend `music.playing` honnête entre deux
	// morceaux de radio.
	assert.equal(m.current, null);
	assert.equal(m.intensity, 0);
	for (const p of parts(voice)) assert.equal(p.disconnected, true);
	assert.equal(voice.source.buffer, null);
});

t('une voix remplacée en fondu démonte mais n\'annonce AUCUNE fin', () => {
	// LE test de cette PR. Le rappel de la première voix part quand son fondu
	// s'achève, c'est-à-dire APRÈS que la seconde a commencé. Sans `retired`,
	// il enchaînerait une seconde fois et la radio sauterait un morceau.
	const { m } = fresh();
	let ends = 0;
	const onEnded = () => { ends++; };
	m.play({ ready: ready('menu-a'), loop: false, remember: false, onEnded });
	const first = m.current;
	m.play({ ready: ready('menu-b'), loop: false, remember: false, onEnded });
	const second = m.current;

	assert.equal(first.retired, true);
	assert.notEqual(first, second);

	first.source.onended();

	assert.equal(ends, 0);
	// La voix NEUVE n'a pas été annulée par la fin de l'ancienne : c'est le
	// garde d'identité `this.current === voice`.
	assert.equal(m.current, second);
	for (const p of parts(first)) assert.equal(p.disconnected, true);
	for (const p of parts(second)) assert.equal(p.disconnected, false);
});

t('kill() : retire, démonte, et n\'annonce aucune fin', () => {
	const { m } = fresh();
	let ends = 0;
	m.play({ ready: ready('menu-eeee'), loop: false, remember: false, onEnded: () => { ends++; } });
	const voice = m.current;
	m.kill();
	assert.equal(voice.retired, true);
	assert.equal(m.current, null);
	voice.source.onended();
	assert.equal(ends, 0);
	for (const p of parts(voice)) assert.equal(p.disconnected, true);
});

t('play() sans morceau et sans contexte : false, aucune exception', () => {
	const { m } = fresh();
	assert.equal(m.play(), false);
	bus._reset();
	bus._setContextFactory(() => null);
	assert.equal(m.play({ ready: ready('menu-ffff') }), false);
});

await ta('decode() ne touche jamais le créneau partagé', async () => {
	// Sous Node il n'y a ni fetch de bundle ni import.meta.env : decode() tombe
	// dans son propre catch et rend null. Ce qu'on vérifie ici est justement
	// qu'il échoue SANS rien écrire — prepare(), lui, est le seul à remplir le
	// créneau.
	const { m } = fresh();
	const shared = ready('menu-gggg');
	m.pending = shared;
	assert.equal(await m.decode({ id: 'menu-hhhh', file: 'music/menu/menu-hhhh.opus' }), null);
	assert.equal(m.pending, shared);
});

dom.restore();
console.log(`\n${n} tests music-render OK`);
