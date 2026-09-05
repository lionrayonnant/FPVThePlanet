// Selftest de la COLLE navigateur du dialogue (src/dialogue.js) : ce que
// tools/dialogue-selftest.mjs ne peut pas voir, parce qu'il vérifie les modules
// purs de tools/dialogue/ et qu'il n'y a pas de DOM chez lui.
//
// Ce qui est vérifié ici est la MÉCANIQUE du toast (issue #243) : le calque
// existe, il meurt avec son écran, et il ne laisse pas de minuteur derrière
// lui. Ce qui ne l'est PAS, et qui demande un œil : l'apparition en fondu, la
// pile bornée à trois cartes, et le fait que le coin bas-droite soit le bon
// endroit. Un banc headless ne juge pas une surimpression.
//
//   node tools/dialogue-render-selftest.mjs
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();
const { notify, mount, appendRtc } = await import('../src/dialogue.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Compte relatif des minuteurs armés : d'autres modules en posent aussi.
const live = new Set();
const _set = globalThis.setTimeout, _clear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...r) => {
	const id = _set((...a) => { live.delete(id); return fn(...a); }, ms, ...r);
	live.add(id); return id;
};
globalThis.clearTimeout = (id) => { live.delete(id); return _clear(id); };

t('notify : le calque est posé sur son hôte, et il est décoratif', () => {
	dom.root.replaceChildren();
	const stop = notify({ event: 'ACQUIRE_AREA', context: {}, host: dom.root });
	const layer = dom.root.querySelector('.rtc-toasts');
	assert.ok(layer, 'le calque existe');
	// Bible §10 : le crew est décoratif. Un lecteur d'écran n'a pas à réciter
	// une conversation qu'on peut ignorer.
	assert.equal(layer.getAttribute('aria-hidden'), 'true');
	stop();
});

t('notify : stop() retire le calque et n\'en laisse pas la trace', () => {
	dom.root.replaceChildren();
	const stop = notify({ event: 'ACQUIRE_AREA', context: {}, host: dom.root });
	stop();
	assert.equal(dom.root.querySelector('.rtc-toasts'), null);
});

t('notify : le flux s\'arrête avec le calque, aucun minuteur ne survit', () => {
	dom.root.replaceChildren();
	const before = live.size;
	const stop = notify({ event: 'ACQUIRE_AREA', context: {}, host: dom.root });
	assert.ok(live.size > before, 'un tick est armé');
	stop();
	assert.equal(live.size, before, 'et il est désarmé');
});

t('notify sans hôte : un no-op, pas une exception', () => {
	// Les chemins de preview du scanner et du hack peuvent monter sans panneau.
	// Un écran qui casse parce que le DÉCOR n'a pas où se poser serait une
	// inversion de priorité (PHASE 05 : le dialogue ne bloque jamais rien).
	const stop = notify({ event: 'ACQUIRE_AREA', context: {}, host: null });
	assert.equal(typeof stop, 'function');
	stop();
});

t('mount : même promesse, le minuteur meurt avec le stop()', () => {
	dom.root.replaceChildren();
	const before = live.size;
	const stop = mount(appendRtc(dom.root), { event: ['ACQUIRE_AREA', 'HACK'], context: {} });
	assert.ok(live.size > before, 'un tick est armé');
	stop();
	assert.equal(live.size, before);
});

t('appendRtc : rend le <pre> où écrire, pas la section', () => {
	dom.root.replaceChildren();
	const log = appendRtc(dom.root);
	assert.ok(log.classList.contains('sc-rtc'), 'c\'est le journal');
	assert.ok(dom.root.querySelector('.sc-rtc-block'), 'la section est bien posée');
});

console.log(`\n${n} tests dialogue-render OK`);
