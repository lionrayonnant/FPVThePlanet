// node tools/target-livery-selftest.mjs — la livrée d'un exemplaire (issue #284).
import { targetBuild, targetLivery } from './target-build.mjs';
import { liveryOf, liveryColors, liveryLabel, PROPS, BELLS, TPU, PACKS, LEDS, LOUD, WEAVE_M, OWNER } from './target-livery.mjs';
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
	// Le build ajoute `wear` par-dessus : tout le reste est la livrée seule.
	const { wear, ...sansUsure } = a.livery;
	check('targetLivery seul = celle du build (moins l\'usure)', JSON.stringify(targetLivery({ seed: 'liv::1', family: 'race5' })) === JSON.stringify(sansUsure));
	check('l\'usure du build est dans [0, 1]', wear >= 0 && wear <= 1, `${wear}`);
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

// Les schémas assortis (#284, deuxième passe) : sur les builds aux hélices
// vives dont la table TPU connaît la couleur, une part nette a le TPU de la
// même couleur — et pas toutes, les machines dépareillées existent.
{
	let eligible = 0, matched = 0, tips = 0, n = 600;
	for (let i = 0; i < n; i++) {
		const l = targetLivery({ seed: `match::${i}`, family: 'race5' });
		if (l.tip) tips++;
		if (PROPS.findIndex(([nm]) => nm === l.prop.name) >= 3 && TPU.some(([nm]) => nm === l.prop.name)) {
			eligible++;
			if (l.tpu.name === l.prop.name) matched++;
		}
	}
	const ratio = matched / eligible;
	check('TPU assorti aux hélices : entre 45 et 75 % des éligibles', ratio > 0.45 && ratio < 0.75, `${(100 * ratio).toFixed(0)} % de ${eligible}`);
	check('hélices bicolores : proche de la pondération race5', Math.abs(tips / n - LOUD.race5.tip) < 0.07, `${(tips / n).toFixed(2)} pour ${LOUD.race5.tip}`);
	check('longrange : bicolores rares', (() => { let t = 0; for (let i = 0; i < 300; i++) if (targetLivery({ seed: `lr::${i}`, family: 'longrange' }).tip) t++; return t / 300 < 0.12; })());
}

// L'usure se LIT dans le build : un pack plus vieux ⇒ plus usé, jamais tiré.
{
	const { wearOf, BUILD_BOUNDS } = await import('./target-build.mjs');
	const { PROFILES } = await import('../src/drone-profiles.js');
	const base = PROFILES.freestyle5;
	const mk = (ohmK, dragK) => ({ battery: { internalOhm: base.battery.internalOhm * ohmK }, bodyDrag: { x: base.bodyDrag.x * dragK } });
	check('usure : pack neuf et montage propre ⇒ 0', wearOf(mk(BUILD_BOUNDS.internalOhm[0], BUILD_BOUNDS.bodyDrag[0]), base) === 0);
	check('usure : pack mort et machine qui traîne ⇒ 1', Math.abs(wearOf(mk(BUILD_BOUNDS.internalOhm[1], BUILD_BOUNDS.bodyDrag[1]), base) - 1) < 1e-9);
	check('usure : monotone avec l\'âge du pack', wearOf(mk(1.3, 1), base) < wearOf(mk(1.5, 1), base));
	check('usure : bornée', wearOf(mk(5, 5), base) === 1 && wearOf(mk(0.5, 0.5), base) === 0);
	let spread = new Set();
	for (let i = 0; i < 50; i++) spread.add(targetBuild({ seed: `wear::${i}`, family: 'freestyle5' }).livery.wear.toFixed(1));
	check('50 builds : l\'usure varie', spread.size >= 4, `${[...spread].sort().join(' ')}`);
}

// Le propriétaire (#285) : un numéro pour une part des builds, du ruban pour
// une autre, et la GoPro dans son boîtier.
{
	let nums = 0, tapes = 0, gop = { black: 0, tpu: 0, white: 0 }, n = 600;
	for (let i = 0; i < n; i++) {
		const l = targetLivery({ seed: `own::${i}`, family: 'freestyle5' });
		if (l.owner.number) { nums++; if (!(l.owner.number >= 1 && l.owner.number <= 999)) { check('numéro dans 1..999', false, String(l.owner.number)); break; } }
		if (l.owner.tape) tapes++;
		gop[l.gopro.name]++;
	}
	check('numéro : proche de sa pondération', Math.abs(nums / n - OWNER.number) < 0.07, `${(nums / n).toFixed(2)}`);
	check('ruban : proche de sa pondération', Math.abs(tapes / n - OWNER.tape) < 0.07, `${(tapes / n).toFixed(2)}`);
	check('GoPro : noire le plus souvent, TPU parfois, blanche rarement', gop.black > gop.tpu && gop.tpu > gop.white && gop.white > 0, JSON.stringify(gop));
	const withNum = [...Array(200).keys()].map((i) => targetLivery({ seed: `own::${i}`, family: 'race5' })).find((l) => l.owner.number);
	check('liveryLabel porte le numéro', /^#\d{3} · /.test(liveryLabel(withNum)), liveryLabel(withNum));
}

// Ce que le maillage consomme.
{
	const l = targetLivery({ seed: 'liv::mesh', family: 'race5' });
	const c = liveryColors(l);
	check('liveryColors : prop bell tpu battery strap led weave wear', ['prop', 'bell', 'tpu', 'battery', 'strap', 'led'].every((k) => isHex(c[k])) && c.weave > 0 && c.wear >= 0 && (c.tip === null || isHex(c.tip)));
	check('liveryColors(null) : objet vide (les gris restent)', Object.keys(liveryColors(null)).length === 0 && Object.keys(liveryColors(undefined)).length === 0);
	check('liveryLabel : [#NNN ·] PROPS … · BELLS … · TPU …', /^(#\d{3} · )?PROPS .+ · BELLS .+ · TPU .+$/.test(liveryLabel(l)) && liveryLabel(l) === liveryLabel(l).toUpperCase(), liveryLabel(l));
	check('liveryColors : gopro, tape, number', (c.gopro === null || isHex(c.gopro)) && isHex(c.tape) && (c.number === null || (c.number >= 1 && c.number <= 999)));
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
	// rand → 0 : tout est vif ET assorti — TPU, sangle et LED reprennent les
	// hélices ; la cloche n'a pas de vert dans sa table, elle prend la
	// première vive ; le bout de pale prend la première vive autre que le corps.
	const loud = liveryOf(() => 0, 'race5');
	check('rand → 0 : vif et assorti', loud.prop.name === 'neon green' && loud.tpu.name === 'neon green' && loud.strap.name === 'neon green'
		&& loud.led.name === 'green' && loud.bell.name === 'red' && loud.pack.name === 'blue' && loud.tip?.name === 'orange', JSON.stringify(loud));
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
