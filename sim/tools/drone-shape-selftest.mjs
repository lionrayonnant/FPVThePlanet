// node tools/drone-shape-selftest.mjs — la recette PURE du quad (issue #250).
import { shapeOf, RECIPE_PROFILES, eyeOf } from '../src/drone-shape.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { motorsOf } from '../src/quad.js';
import { createHash } from 'node:crypto';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const roles = (s, role) => s.parts.filter((p) => p.role === role);
const make = (family, seed = `shape::${family}`, detail = undefined) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }), detail });
};

console.log('drone-shape');
for (const family of FAMILIES) {
	const s = make(family);
	check(`${family}: 4 bras, 4 moteurs, 4 hélices`, roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
	check(`${family}: une plaque, une caméra, une batterie, une LED`, roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
	const prop = roles(s, 'prop')[0];
	check(`${family}: disque = propRadius`, Math.abs(prop.size[0] - PROFILES[family].propRadius) < 1e-9);
	const motors = roles(s, 'motor');
	check(`${family}: moteurs à (±armX, ±armZ)`, motors.every((m) => Math.abs(Math.abs(m.at[0]) - PROFILES[family].armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - PROFILES[family].armZ) < 1e-9));
	check(`${family}: rayon englobant > hypot(arm) + prop`, s.boundingRadius >= Math.hypot(PROFILES[family].armX, PROFILES[family].armZ) + PROFILES[family].propRadius);
	check(`${family}: toutes les pièces sous le rayon englobant`, s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
	check(`${family}: caméra inclinée du uptilt`, Math.abs(roles(s, 'camera')[0].rotX - targetCamera({ seed: `shape::${family}`, family }).uptiltDeg * Math.PI / 180) < 1e-9);
	check(`${family}: LED à l'arrière (+Z)`, roles(s, 'led')[0].at[2] > 0);
	check(`${family}: caméra à l'avant (−Z)`, roles(s, 'camera')[0].at[2] < 0);
}

// Issue #264 : la géométrie visible et le mixeur lisent la MÊME table.
// quad.js:64-71 — 1 arrière-droit spin +1, 2 avant-droit spin −1,
// 3 arrière-gauche spin −1, 4 avant-gauche spin +1.
for (const family of FAMILIES) {
	const s = make(family);
	const props = roles(s, 'prop');
	const motors = motorsOf(PROFILES[family]);
	check(`${family}: chaque hélice porte son index moteur`,
		props.every((p, i) => p.motor === i) && props.length === 4,
		props.map((p) => p.motor).join(','));
	check(`${family}: l'hélice k est à la position du moteur k`,
		props.every((p) => {
			const m = motors[p.motor];
			return Math.abs(p.at[0] - m.x) < 1e-9 && Math.abs(p.at[2] - m.z) < 1e-9;
		}));
	check(`${family}: l'hélice k porte le spin du moteur k`,
		props.every((p) => p.spin === motors[p.motor].spin));
	// Les deux hélices DANS LE CHAMP sont les avant : moteurs 1 et 3.
	const front = props.filter((p) => p.at[2] < 0).map((p) => p.motor).sort();
	check(`${family}: les deux hélices avant sont les moteurs 1 et 3`,
		front.join(',') === '1,3', front.join(','));
	check(`${family}: les deux avant tournent en sens opposés`,
		props[1].spin === -props[3].spin);
	// Bras, moteurs et conduits portent le même index que leur hélice.
	for (const role of ['arm', 'motor', 'duct']) {
		const r = roles(s, role);
		if (!r.length) continue;
		check(`${family}: chaque ${role} porte son index moteur`,
			r.every((p, i) => p.motor === i) && r.length === 4,
			r.map((p) => p.motor).join(','));
	}
}
// Issue #264 : non-régression. shapeOf() SANS `detail` doit rendre exactement
// la même géométrie d'une session à l'autre — mêmes primitives, mêmes
// positions, mêmes tailles —, sinon les drones ambiants changeraient d'aspect
// en douce. L'empreinte est insensible à l'ORDRE des parts (les hélices
// naissent maintenant de motorsOf(), qui les énumère dans l'ordre Betaflight)
// et ignore les champs ajoutés (`motor`, `spin`) : ce qu'on gèle, c'est la
// forme, pas la recette.
//
// Elles ont été recalculées une seconde fois quand tools/tune-mount.mjs a
// re-mesuré le montage : sa règle de hauteur est passée de « la plus grande que
// la borne autorise » à « celle qui rend les hélices le plus présentes sous la
// borne » (les deux disent la même chose au bord de la plaque, la seconde reste
// juste si l'objectif avance), ce qui a déplacé quatre familles de 0,1 à 0,2 mm.
//
// Les six empreintes ont été recalculées une première fois quand la part caméra
// est passée AU-DESSUS du plan d'hélice — le bloc MOUNT mesuré (#264, voir l'en-tête de
// tools/tune-mount.mjs) l'a montée de quelques millimètres, son avancée étant
// restée celle de la recette. Rien d'autre n'a bougé, et les ambiants ne sont
// pas rendus autrement pour autant : src/drone-mesh.js traite la part `camera`
// comme toutes les autres, c'est une boîte de 19×19×10 mm qui a changé de
// hauteur. Toute autre dérive de ces empreintes est une régression.
{
	const GOLDEN = {
		freestyle5: '7060140541d230dd',
		race5: 'd8da56b6dd4c251f',
		cinewhoop: 'e8adbcc42d131eb3',
		longrange: 'afdf242d80843cd8',
		heavy5: '962cbf465e9905b9',
		toothpick: '0fd72cf210f35616',
	};
	for (const family of FAMILIES) {
		const rows = make(family).parts
			.map((p) => JSON.stringify({ kind: p.kind, role: p.role, at: p.at, size: p.size, rotX: p.rotX ?? 0, rotY: p.rotY ?? 0, blades: p.blades ?? 0 }))
			.sort();
		const digest = createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
		check(`${family}: géométrie par défaut inchangée`, digest === GOLDEN[family], digest);
	}
}
check('long range : disques de 88,9 mm', Math.abs(roles(make('longrange'), 'prop')[0].size[0] - 0.0889) < 1e-4);
check('micro : deux pales', roles(make('toothpick'), 'prop')[0].blades === 2);
check('micro : empattement 76 mm', Math.abs(2 * PROFILES.toothpick.armX - 0.076) < 1e-3);
check('cinewhoop : 4 conduits', roles(make('cinewhoop'), 'duct').length === 4);
check('micro : 4 conduits', roles(make('toothpick'), 'duct').length === 4);
check('race : pas de conduit', roles(make('race5'), 'duct').length === 0);
check('cinewhoop : une GoPro', roles(make('cinewhoop'), 'gopro').length === 1);
check('long range : deux antennes', roles(make('longrange'), 'antenna').length === 2);
check('race : une antenne', roles(make('race5'), 'antenna').length === 1);
check('heavy : plaque de 10 mm', Math.abs(roles(make('heavy5'), 'plate')[0].size[1] - 0.010) < 1e-9);
check('freestyle : plaque de 6 mm', Math.abs(roles(make('freestyle5'), 'plate')[0].size[1] - 0.006) < 1e-9);
{
	// Batterie : longueur = 20 mm · cells.
	const s = make('longrange');
	check('batterie 6S = 120 mm', Math.abs(roles(s, 'battery')[0].size[2] - 0.12) < 1e-9);
}
{
	// Un build lourd de freestyle porte une GoPro ; un léger non. On cherche
	// deux graines : la variation de masse est ±12 %.
	let heavy = null, light = null;
	for (let i = 0; i < 200 && !(heavy && light); i++) {
		const b = targetBuild({ seed: `gp::${i}`, family: 'freestyle5' });
		const ratio = b.profile.mass / PROFILES.freestyle5.mass;
		if (ratio > 1.05 && !heavy) heavy = `gp::${i}`;
		if (ratio < 1.0 && !light) light = `gp::${i}`;
	}
	check('freestyle lourd : GoPro', roles(make('freestyle5', heavy), 'gopro').length === 1, heavy);
	check('freestyle léger : pas de GoPro', roles(make('freestyle5', light), 'gopro').length === 0, light);
}
check('même build → même recette', JSON.stringify(make('race5', 'same')) === JSON.stringify(make('race5', 'same')));

// Issue #264 : trois niveaux de détail, et le défaut ne bouge PAS.
{
	const seed = 'lod::freestyle5';
	const build = targetBuild({ seed, family: 'freestyle5' });
	const camera = targetCamera({ seed, family: 'freestyle5' });
	const base = shapeOf({ profile: build.profile, build, camera });
	const silhouette = shapeOf({ profile: build.profile, build, camera, detail: 'silhouette' });
	const onboard = shapeOf({ profile: build.profile, build, camera, detail: 'onboard' });
	const portrait = shapeOf({ profile: build.profile, build, camera, detail: 'portrait' });

	check('detail absent ≡ silhouette', JSON.stringify(base) === JSON.stringify(silhouette));
	check('silhouette : aucune pale', silhouette.parts.every((p) => p.role !== 'blade'));
	check('onboard : 3 pales par hélice (freestyle)', onboard.parts.filter((p) => p.role === 'blade').length === 12);
	check('onboard : le disque enveloppe est conservé', onboard.parts.filter((p) => p.role === 'prop').length === 4);
	// L'enveloppe balayée est ce que tools/prop-coverage.mjs mesure et ce que le
	// shader fond en flou : si un niveau la retirait, la borne DA deviendrait
	// aveugle. Les pales S'AJOUTENT au disque, elles ne le remplacent pas.
	check('le disque enveloppe survit aux trois niveaux',
		[silhouette, onboard, portrait].every((s) => s.parts.filter((p) => p.role === 'prop').length === 4));
	// `onboard` RETIRE délibérément la carrosserie — l'objectif ne filme pas son
	// propre boîtier — et n'ajoute que les pales. Ce qu'il ne doit jamais
	// retirer, c'est un rotor : sans eux la vue embarquée n'a plus de sujet.
	// Les BRAS, eux, changent avec le châssis (#285) : leur point de départ
	// dépend du patron. Ce qui ne bouge jamais, c'est le moteur au bout.
	const ROTOR = new Set(['motor', 'prop', 'duct']);
	check('onboard garde tous les rotors de la silhouette',
		silhouette.parts.filter((p) => ROTOR.has(p.role))
			.every((p) => onboard.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('onboard : quatre bras, chacun arrivant à son moteur',
		onboard.parts.filter((p) => p.role === 'arm').length === 4);
	check('onboard retire la carrosserie',
		onboard.parts.every((p) => ROTOR.has(p.role) || ['arm', 'blade', 'tape', 'bell'].includes(p.role)));
	check('portrait ajoute à la silhouette, ne retire rien (la plaque et les bras suivent le châssis)',
		silhouette.parts.filter((p) => !['plate', 'arm'].includes(p.role)).every((p) => portrait.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('portrait ajoute, ne retire rien',
		onboard.parts.every((p) => portrait.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('portrait ⊇ onboard', onboard.parts.length < portrait.parts.length);
	check('portrait : cloches moteur', portrait.parts.filter((p) => p.role === 'bell').length === 4);
	check('rayon englobant identique aux trois niveaux',
		silhouette.boundingRadius === onboard.boundingRadius && onboard.boundingRadius === portrait.boundingRadius);
	check('chaque pale porte le moteur et le sens de son hélice',
		onboard.parts.filter((p) => p.role === 'blade').every((p) => Number.isInteger(p.motor) && Math.abs(p.spin) === 1));
	check('micro : 2 pales par hélice', shapeOf({
		profile: targetBuild({ seed: 'lod::tp', family: 'toothpick' }).profile,
		build: targetBuild({ seed: 'lod::tp', family: 'toothpick' }),
		camera: targetCamera({ seed: 'lod::tp', family: 'toothpick' }),
		detail: 'onboard',
	}).parts.filter((p) => p.role === 'blade').length === 8);
	// Un niveau inconnu est une faute de frappe, pas un silhouette silencieux.
	let threw = false;
	try { shapeOf({ profile: build.profile, build, camera, detail: 'moyen' }); } catch { threw = true; }
	check('un niveau inconnu lève', threw);
	// Toutes les pièces des trois niveaux restent sous le rayon englobant.
	check('les pales et les cloches tiennent sous le rayon englobant',
		portrait.parts.every((p) => Math.hypot(...p.at) <= portrait.boundingRadius + 1e-9));
}

// Issue #264 : ce que l'objectif peut voir. Le niveau `onboard` ne porte QUE
// les rotors — un objectif ne filme pas son propre boîtier (la part `camera`
// est centrée sur l'oeil : rendue, elle couvre tout le cadre), ni le pack, la
// GoPro et les antennes, qui vivent derrière lui. Le `portrait`, lui, montre la
// machine entière : c'est une fiche, pas une vue subjective.
{
	const ROTORS = new Set(['arm', 'motor', 'prop', 'duct', 'blade', 'tape', 'bell']);
	for (const family of FAMILIES) {
		const embarque = new Set(make(family, `shape::${family}`, 'onboard').parts.map((p) => p.role));
		check(`${family}: la vue embarquée ne porte que les rotors`,
			[...embarque].every((r) => ROTORS.has(r)), [...embarque].join(' '));
		check(`${family}: la vue embarquée porte bien ses hélices et ses pales`,
			embarque.has('prop') && embarque.has('blade'));
		const portrait = new Set(make(family, `shape::${family}`, 'portrait').parts.map((p) => p.role));
		check(`${family}: le portrait garde la machine entière`,
			portrait.has('camera') && portrait.has('battery') && portrait.has('plate') && portrait.has('led'),
			[...portrait].join(' '));
	}
}

// --------------------------------------------------------- l'essaim (#29)
//
// Deux machines de plus, et une seule d'entre elles est une famille : le nœud
// vit dans PROFILES (on le pilote), l'unité n'existe que comme recette (on ne
// la pilote jamais, donc elle n'a ni PID ni tune). Le selftest les traite
// exactement pareil, parce que shapeOf() les traite exactement pareil : il
// prend un PROFIL, pas un nom de famille.
console.log('\ndrone-shape : essaim (#29)');
{
	const node = make('swarmNode', 'shape::swarmNode');
	const unitProfile = RECIPE_PROFILES.swarmUnit;
	const unit = shapeOf({ profile: unitProfile, build: {}, camera: targetCamera({ seed: 'shape::swarmUnit', family: 'swarmUnit' }) });

	for (const [name, s, profile] of [['swarmNode', node, PROFILES.swarmNode], ['swarmUnit', unit, unitProfile]]) {
		check(`${name}: 4 bras, 4 moteurs, 4 disques`,
			roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
		check(`${name}: une plaque, une caméra, une batterie, une LED`,
			roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
		check(`${name}: disque = propRadius`, Math.abs(roles(s, 'prop')[0].size[0] - profile.propRadius) < 1e-9);
		check(`${name}: trois pales`, roles(s, 'prop').every((p) => p.blades === 3));
		check(`${name}: moteurs à (±armX, ±armZ)`,
			roles(s, 'motor').every((m) => Math.abs(Math.abs(m.at[0]) - profile.armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - profile.armZ) < 1e-9));
		// Géométrie FINIE : pas un NaN, pas un Infinity, pas une taille nulle.
		// Une recette qui lirait un champ absent du profil sortirait d'ici.
		check(`${name}: toutes les dimensions finies et positives`,
			s.parts.every((p) => p.at.every(Number.isFinite) && p.size.every((v) => Number.isFinite(v) && v > 0))
			&& Number.isFinite(s.boundingRadius) && s.boundingRadius > 0);
		check(`${name}: toutes les pièces sous le rayon englobant`,
			s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
		check(`${name}: caméra à l'avant, LED à l'arrière`,
			roles(s, 'camera')[0].at[2] < 0 && roles(s, 'led')[0].at[2] > 0);
		check(`${name}: l'oeil est au bord avant de la plaque`,
			Math.abs(eyeOf(profile)[2] + 0.55 * profile.armZ) < 1e-9, `${eyeOf(profile)[2]}`);
	}

	check('swarmUnit : carènes, comme le cinewhoop', roles(unit, 'duct').length === 4);
	check('swarmUnit : anneau r = 1,12·propRadius',
		Math.abs(roles(unit, 'duct')[0].size[0] - 1.12 * unitProfile.propRadius) < 1e-9);
	check('swarmUnit : une seule antenne', roles(unit, 'antenna').length === 1);
	check('swarmUnit : batterie 3S = 60 mm', Math.abs(roles(unit, 'battery')[0].size[2] - 0.060) < 1e-9);
	check('swarmUnit : pas de GoPro, pas de dôme',
		roles(unit, 'gopro').length === 0 && roles(unit, 'dome').length === 0);
	check('swarmUnit : LED plus forte que celle d\'un ambiant ordinaire',
		roles(unit, 'led')[0].size[0] > roles(make('freestyle5'), 'led')[0].size[0]);

	check('swarmNode : un dôme sur le dessus', roles(node, 'dome').length === 3
		&& roles(node, 'dome').every((d) => d.at[1] > roles(node, 'battery')[0].at[1]));
	check('swarmNode : le dôme se rétrécit en montant',
		roles(node, 'dome').every((d, i, a) => i === 0 || d.size[0] < a[i - 1].size[0]));
	check('swarmNode : deux antennes', roles(node, 'antenna').length === 2);
	check('swarmNode : pas de carène, pas de GoPro',
		roles(node, 'duct').length === 0 && roles(node, 'gopro').length === 0);
	check('swarmNode : batterie 6S = 120 mm', Math.abs(roles(node, 'battery')[0].size[2] - 0.12) < 1e-9);

	// Le compte de triangles, dans l'ORDRE annoncé par la spec (~300 pour
	// l'unité). On compte ce que src/drone-mesh.js monterait, sans monter quoi
	// que ce soit : la primitive et ses segments suffisent. Un disque à 12
	// côtés, un cylindre à 8, un anneau ouvert à 12.
	const tris = (s) => s.parts.reduce((n, p) => n + ({
		box: 12, cylinder: 8 * 2 + 2 * 8, ring: 12 * 2, disc: 12, point: 0,
	}[p.kind] ?? 0), 0);
	const tUnit = tris(unit), tNode = tris(node);
	const RING = 12 * 2, CYL = 8 * 2 + 2 * 8;
	check('swarmUnit : ~300 triangles (< 500)', tUnit > 150 && tUnit < 500, `${tUnit}`);
	// Le nœud est l'unité MOINS ses quatre carènes, PLUS les trois étages du
	// dôme et une seconde antenne. À l'unité près : si une pièce apparaît ou
	// disparaît d'un côté sans l'autre, cette égalité tombe.
	check('swarmNode : exactement unité − 4 carènes + 3 étages de dôme + 1 antenne',
		tNode === tUnit - 4 * RING + 3 * CYL + CYL, `${tNode} vs ${tUnit - 4 * RING + 4 * CYL}`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
