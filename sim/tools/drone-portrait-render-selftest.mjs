// node tools/drone-portrait-render-selftest.mjs — le portrait à l'écran
// (issue #264), sur le faux DOM. Ce qu'on vérifie est l'ARBRE et le CÂBLAGE :
// ce qui est produit, ce qui est monochrome, ce qui s'arrête au démontage.
// L'apparence se juge à l'oeil, pas ici.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

// `raf: true` : ce test est le seul à rejouer lui-même des frames — voir
// l'en-tête d'installFakeDom pour la raison pour laquelle ce n'est pas le
// défaut.
const dom = installFakeDom({ raf: true });
const { dronePortrait } = await import('../src/drone-portrait.js');
const { FAMILIES, nominalBuildSeed } = await import('../src/drone-profiles.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('drone-portrait');

t('une cible donne un SVG', () => {
	const p = dronePortrait({ family: 'freestyle5', buildSeed: 'seed::0' });
	assert.ok(p, 'aucun portrait rendu');
	assert.equal(p.el.tagName.toLowerCase(), 'svg');
	assert.ok(p.el.querySelectorAll('line').length > 60, 'trop peu de traits');
	p.stop();
});

t('aucune couleur en dur : tout est currentColor', () => {
	const p = dronePortrait({ family: 'race5', buildSeed: 'seed::1' });
	const html = p.el.outerHTML ?? '';
	assert.ok(!/#[0-9a-f]{3,6}/i.test(html), `couleur littérale dans le portrait : ${html.slice(0, 200)}`);
	assert.ok(/currentColor/.test(html), 'la couleur ne vient pas du contexte');
	p.stop();
});

t('sans cible : rien, et pas d\'exception', () => {
	assert.equal(dronePortrait({ family: null, buildSeed: null }), null);
	assert.equal(dronePortrait({}), null);
	// « Aucune migration » : une session d'AVANT #264 porte la famille mais pas
	// toujours la graine. Elle ne doit ni lever, ni rendre un cadre vide qui
	// tiendrait la place — elle ne rend rien, et la fiche se referme dessus.
	assert.equal(dronePortrait({ family: 'heavy5' }), null);
	assert.equal(dronePortrait({ buildSeed: 'seed::9' }), null);
	assert.equal(dronePortrait(), null);
});

t('une famille inconnue ne casse pas la fiche', () => {
	// targetBuild()/targetCamera() retombent sur la famille par défaut : le
	// portrait suit plutôt que de lever au milieu d'un écran déjà monté.
	const p = dronePortrait({ family: 'famille-morte', buildSeed: 'seed::3' });
	assert.ok(p, 'aucun portrait rendu');
	assert.ok(p.el.querySelectorAll('line').length > 60, 'trop peu de traits');
	p.stop();
});

t('stop() coupe l\'animation', () => {
	const p = dronePortrait({ family: 'cinewhoop', buildSeed: 'seed::2' });
	p.stop();
	const before = dom.window.__rafCount ?? 0;
	dom.tick?.(100);
	assert.equal(dom.window.__rafCount ?? 0, before, 'le portrait continue de tourner après stop()');
});

t('sans stop(), il tourne : le dessin change d\'une frame à l\'autre', () => {
	const p = dronePortrait({ family: 'freestyle5', buildSeed: 'seed::4' });
	// Un trait témoin plutôt que tout le balisage : un échec doit se lire, pas
	// déverser soixante mille caractères.
	const x1 = () => p.el.querySelector('line').getAttribute('x1');
	const before = x1();
	dom.tick(0);        // la première frame ne fait que poser l'origine du temps
	dom.tick(1000);     // une seconde plus tard : 15° d'orbite à PERIOD_S = 24 s
	assert.notEqual(x1(), before, 'le portrait ne tourne pas');
	p.stop();
});

t('chaque famille a un portrait avec sa graine NOMINALE', () => {
	// D12 : un vol nominal (override ?family=, NOMINAL au banc, ?scene= sans
	// cible) n'avait pas de graine, donc pas de portrait. nominalBuildSeed()
	// lui en donne une — les six familles doivent se dessiner avec.
	for (const family of FAMILIES) {
		const p = dronePortrait({ family, buildSeed: nominalBuildSeed(family) });
		assert.ok(p, `${family} n'a pas de portrait`);
		assert.ok(p.el.querySelectorAll('line').length > 60, `${family} : trop peu de traits`);
		p.stop();
	}
});

t('deux familles ne donnent pas le même dessin', () => {
	const a = dronePortrait({ family: 'toothpick', buildSeed: 's' });
	const b = dronePortrait({ family: 'longrange', buildSeed: 's' });
	assert.notEqual(a.el.outerHTML, b.el.outerHTML);
	a.stop(); b.stop();
});

dom.restore();
console.log(`\n${n} ok`);
