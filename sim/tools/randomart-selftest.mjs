// Selftest du randomart (issue #57). Le module est une FEUILLE : aucune
// dépendance, aucun `node:` — c'est ce qui lui permet d'être importé aussi
// bien par le serveur que par le client bundlé par Vite.
// Lancer : node tools/randomart-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomart, randomartWalk, randomartFrame, RANDOMART_DIMS } from './randomart.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('déterministe : deux appels sur la même graine rendent la même image', () => {
	const a = randomart('tokyo::3', { title: 'TGT 042', tag: 'ke::3' });
	const b = randomart('tokyo::3', { title: 'TGT 042', tag: 'ke::3' });
	assert.equal(a, b);
});

t('deux exemplaires voisins d\'un même scan rendent des images différentes', () => {
	assert.notEqual(randomart('tokyo::0'), randomart('tokyo::1'));
});

t('dimensions et cadre', () => {
	const lines = randomart('tokyo::3', { title: 'TGT 042', tag: 'a1b2' }).split('\n');
	assert.equal(lines.length, RANDOMART_DIMS.LINES);
	assert.ok(lines.every((l) => l.length === RANDOMART_DIMS.WIDTH + 2));
	assert.ok(lines[0].includes('[TGT 042]'));
	assert.ok(lines[lines.length - 1].includes('a1b2'));
});

t('S et E sont posés sur l\'image complète', () => {
	const a = randomart('tokyo::3');
	assert.ok(a.includes('S'));
	assert.ok(a.includes('E'));
});

// La propriété qui rend l'animation gratuite : jouer la marche jusqu'au bout
// donne EXACTEMENT l'image que rend randomart().
t('continuité : la dernière image de la marche est l\'image complète', () => {
	const walk = randomartWalk('tokyo::3');
	const opts = { title: 'TGT 042', tag: 'a1b2' };
	assert.equal(randomartFrame(walk, walk.steps.length, opts), randomart('tokyo::3', opts));
});

t('la marche a 128 pas et son dernier pas est `end`', () => {
	const walk = randomartWalk('tokyo::3');
	assert.equal(walk.steps.length, 128);
	assert.equal(walk.end, walk.steps[walk.steps.length - 1]);
});

t('au pas 0 : le fou est au départ, S seul, aucun E', () => {
	const walk = randomartWalk('tokyo::3');
	const first = randomartFrame(walk, 0);
	assert.equal((first.match(/S/g) ?? []).length, 1);
	assert.equal(first.includes('E'), false, 'E est sous S au pas 0');
});

// Le fou EST le curseur : E se déplace pendant la marche.
t('pendant la marche, E est la case du dernier pas', () => {
	const walk = randomartWalk('tokyo::3');
	const at = (n) => {
		const rows = randomartFrame(walk, n).split('\n').slice(1, -1);
		for (let y = 0; y < rows.length; y++) {
			const x = rows[y].indexOf('E');
			if (x > 0) return (x - 1) + y * RANDOMART_DIMS.WIDTH;
		}
		return null;
	};
	assert.equal(at(40), walk.steps[39]);
	assert.equal(at(90), walk.steps[89]);
});

t('n hors bornes est ramené dans les bornes, sans lever', () => {
	const walk = randomartWalk('tokyo::3');
	assert.equal(randomartFrame(walk, -5), randomartFrame(walk, 0));
	assert.equal(randomartFrame(walk, 9999), randomartFrame(walk, walk.steps.length));
});

t('pureté : le module n\'importe rien de `node:`', () => {
	const src = readFileSync(new URL('./randomart.mjs', import.meta.url), 'utf8');
	assert.equal(/from\s+['"]node:/.test(src), false, 'importation node: interdite');
	assert.equal(/^import\s/m.test(src), false, 'le module doit rester une feuille sans dépendance');
});

console.log(`\n${n} tests OK — randomart`);
