// node tools/target-livery-selftest.mjs — la livrée d'un exemplaire (issue #284).
import { targetBuild, targetLivery } from './target-build.mjs';
import { liveryOf, liveryColors, liveryLabel, PROPS, BELLS, TPU, PACKS, LEDS, LOUD, WEAVE_M } from './target-livery.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const isHex = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;

console.log('target-livery');

// Déterminisme, et la livrée est DANS le build.
{
	const a = targetBuild({ seed: 'liv::1', family: 'race5' });
	const b = targetBuild({ seed: 'liv::1', family: 'race5' });
	check('même graine → même livrée', JSON.stringify(a.livery) === JSON.stringify(b.livery));
	check('targetLivery seul = celle du build', JSON.stringify(targetLivery({ seed: 'liv::1', family: 'race5' })) === JSON.stringify(a.livery));
	check('une autre famille, une autre livrée', JSON.stringify(targetBuild({ seed: 'liv::1', family: 'heavy5' }).livery) !== JSON.stringify(a.livery));
	let threw = false;
	try { targetLivery({ family: 'race5' }); } catch { threw = true; }
	check('sans graine : lève', threw);
	check('famille inconnue : retombe sur la famille par défaut', !!targetLivery({ seed: 'x', family: 'nope' }).prop);
}

// Le contrat qui protège les vols : ajouter la livrée n'a déplacé AUCUN tirage
// physique. On ne peut pas comparer à « avant » ici, mais on peut vérifier que
// la livrée sort d'un flux à part : deux appels de liveryOf sur deux flux
// différents diffèrent, et le profil ne dépend pas de la livrée.
{
	const seed = 'liv::flux';
	const b = targetBuild({ seed, family: 'freestyle5' });
	const again = targetBuild({ seed, family: 'freestyle5' });
	check('le profil physique est stable', JSON.stringify(b.profile) === JSON.stringify(again.profile) && JSON.stringify(b.rates) === JSON.stringify(again.rates));
	const src = (await import('node:fs')).readFileSync(new URL('./target-build.mjs', import.meta.url), 'utf8');
	check('la livrée lit son propre flux de graine (`::livery::`)', src.includes('::livery::'));
}

// Tout est un hex valide, tout a un nom, le tissage est dans ses bornes.
for (const family of FAMILIES) {
	for (let i = 0; i < 40; i++) {
		const l = targetLivery({ seed: `liv::${family}::${i}`, family });
		const ok = ['prop', 'bell', 'tpu', 'pack', 'led'].every((k) => isHex(l[k].hex) && typeof l[k].name === 'string' && l[k].name.length > 0)
			&& l.weave >= WEAVE_M[0] && l.weave <= WEAVE_M[1];
		if (!ok) { check(`${family} #${i}: livrée valide`, false, JSON.stringify(l)); break; }
		if (i === 39) check(`${family}: 40 livrées valides`, true);
	}
}

// Les pondérations font ce qu'elles disent : sur 400 tirages, un race5 a
// plus souvent des hélices vives qu'un long range.
{
	const vivid = (family) => {
		let n = 0;
		for (let i = 0; i < 400; i++) {
			const l = targetLivery({ seed: `pond::${i}`, family });
			if (PROPS.findIndex(([name]) => name === l.prop.name) >= 3) n++;
		}
		return n / 400;
	};
	const race = vivid('race5'), lr = vivid('longrange');
	check('race5 : hélices vives plus souvent que longrange', race > lr + 0.3, `${race.toFixed(2)} vs ${lr.toFixed(2)}`);
	check('race5 : proche de sa pondération', Math.abs(race - LOUD.race5.prop) < 0.08, `${race.toFixed(2)} pour ${LOUD.race5.prop}`);
	check('longrange : proche de sa pondération', Math.abs(lr - LOUD.longrange.prop) < 0.08, `${lr.toFixed(2)} pour ${LOUD.longrange.prop}`);
}

// Deux builds d'une même famille se DISTINGUENT : c'est tout l'intérêt.
{
	const seen = new Set();
	for (let i = 0; i < 60; i++) seen.add(JSON.stringify(targetLivery({ seed: `var::${i}`, family: 'freestyle5' })));
	check('60 freestyle → au moins 40 livrées distinctes', seen.size >= 40, `${seen.size}`);
}

// Ce que le maillage consomme.
{
	const l = targetLivery({ seed: 'liv::mesh', family: 'race5' });
	const c = liveryColors(l);
	check('liveryColors : prop bell tpu battery led weave', ['prop', 'bell', 'tpu', 'battery', 'led'].every((k) => isHex(c[k])) && c.weave > 0);
	check('liveryColors(null) : objet vide (les gris restent)', Object.keys(liveryColors(null)).length === 0 && Object.keys(liveryColors(undefined)).length === 0);
	check('liveryLabel : PROPS … · BELLS … · TPU …', /^PROPS .+ · BELLS .+ · TPU .+$/.test(liveryLabel(l)) && liveryLabel(l) === liveryLabel(l).toUpperCase());
	check('liveryLabel(null) : vide', liveryLabel(null) === '');
}

// Les tables : des noms uniques par table, des hex valides, les discrètes en
// tête (voir QUIET dans le module).
for (const [name, table] of Object.entries({ PROPS, BELLS, TPU, PACKS, LEDS })) {
	check(`${name} : hex valides et noms uniques`, table.every(([n, h]) => typeof n === 'string' && isHex(h)) && new Set(table.map(([n]) => n)).size === table.length);
}
{
	// rand → 1⁻ : jamais vif (1 < loud est faux), et la DERNIÈRE entrée
	// discrète de chaque table. rand → 0 : toujours vif, la première vive.
	const dull = liveryOf(() => 0.999999, 'race5');
	check('rand → 1 : les entrées discrètes', dull.prop.name === 'white' && dull.bell.name === 'silver' && dull.tpu.name === 'black' && dull.pack.name === 'black', JSON.stringify(dull));
	const loud = liveryOf(() => 0, 'race5');
	check('rand → 0 : les premières entrées vives', loud.prop.name === 'neon green' && loud.bell.name === 'red' && loud.tpu.name === 'orange' && loud.pack.name === 'blue', JSON.stringify(loud));
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
