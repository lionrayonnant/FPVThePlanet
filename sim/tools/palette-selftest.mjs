// Selftest du langage visuel (PHASE 19, issue #56). Aucune E/S DOM, aucun réseau.
// Lancer : node tools/palette-selftest.mjs
//
// Ce test ne juge rien d'esthétique — ça, c'est l'œil de l'opérateur. Il vérifie
// mécaniquement les deux critères d'acceptation de l'issue qui SONT vérifiables :
//
//   « src/style.css refondu autour de tokens »
//   « Aucun écran quotidien n'utilise la palette demo »
//
// plus les contraintes matérielles que les polices imposent et qu'un humain ne
// verra pas en relisant du CSS : la grille 11 px de Departure Mono, et le fait
// que les deux familles ne partagent pas la même chasse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sim = join(here, '..');
const read = (p) => readFileSync(join(sim, p), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const TOKENS = read('src/tokens.css');
const GAME = read('src/style.css');
const MAPGUI = read('tools/map-gui/style.css');

// Les couleurs demo (Bible §19), et les seuls endroits qui ont le droit d'y
// toucher : le rituel et l'intro. Le hack, lui, reste en monochrome — c'est le
// rituel qui explose, pas l'analyse qui le précède.
const DEMO_TOKENS = ['--cyan', '--magenta', '--violet', '--electric'];
const EVENT_SELECTORS = ['.intro'];

// Découpe grossière mais suffisante : une règle = ce qui précède `{`, une fois
// les commentaires retirés. Les blocs @media/@keyframes laissent leur préambule
// dans le sélecteur, d'où le `lastIndexOf('{')`.
function rules(css) {
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	for (const chunk of bare.split('}')) {
		const i = chunk.lastIndexOf('{');
		if (i < 0) continue;
		out.push({ selector: chunk.slice(0, i).trim(), body: chunk.slice(i + 1) });
	}
	return out;
}

// Les lignes annotées `/* palette-ok: … */` sont des exceptions déclarées : des
// stops de masque alpha, un halo de lumière. Elles doivent dire pourquoi.
function colourLiterals(css) {
	// Les commentaires sont effacés en gardant leurs sauts de ligne, pour que le
	// numéro rapporté soit celui du fichier — un commentaire peut parfaitement
	// citer une ancienne valeur, et c'est même souhaitable.
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
	const src = css.split('\n');
	const hits = [];
	bare.split('\n').forEach((line, i) => {
		if (src[i].includes('palette-ok:')) return;
		if (/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/.test(line)) {
			hits.push(`${i + 1}: ${src[i].trim()}`);
		}
	});
	return hits;
}

// ---------------------------------------------------------------- les jetons

t('tokens.css : les 5 gris, les 4 fonctionnelles et les 4 demo sont définis', () => {
	for (const name of ['--black', '--dark-grey', '--grey', '--light-grey', '--warm-white',
		'--green', '--yellow', '--orange', '--red', ...DEMO_TOKENS]) {
		assert.match(TOKENS, new RegExp(`\\n\\t${name}:`), `${name} manque dans tokens.css`);
	}
});

t('tokens.css : la rampe de gris est neutre chaude (R ≥ G ≥ B) et monotone', () => {
	const ramp = ['--black', '--dark-grey', '--grey', '--light-grey', '--warm-white'];
	let prev = -1;
	for (const name of ramp) {
		const hex = TOKENS.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1];
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
		assert.ok(r >= g && g >= b, `${name} (${hex}) n'est pas chaud : R ${r} G ${g} B ${b}`);
		const lum = r + g + b;
		assert.ok(lum > prev, `${name} n'est pas plus clair que le jeton précédent`);
		prev = lum;
	}
});

t('les deux feuilles ne contiennent aucun littéral de couleur hors tokens.css', () => {
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		const hits = colourLiterals(css);
		assert.deepEqual(hits, [], `${name} peint en dur :\n    ${hits.join('\n    ')}`);
	}
});

t('map-gui importe bien le socle partagé plutôt que de redéclarer ses jetons', () => {
	assert.match(MAPGUI, /@import '\.\.\/\.\.\/src\/tokens\.css';/);
	assert.match(GAME, /@import '\.\/tokens\.css';/);
	// Un seul jeton lui appartient encore, et c'est une mesure, pas un pigment.
	const own = [...MAPGUI.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]);
	assert.deepEqual(own, ['--rail']);
	// Côté jeu, un seul aussi (#73) : la taille de la marque sur le cracktro.
	// Une mesure, pas un pigment — et elle DOIT être une variable, parce que le
	// verrouillage empilé exprime tous ses écarts en modules de cette taille
	// (docs/marque.md : l'écart au nom vaut 1 module, la zone de respect 4).
	// Elle est locale et pas un jeton parce qu'elle ne vaut que là : rien
	// d'autre dans le jeu ne se mesure en modules de marque.
	const gameOwn = [...GAME.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]);
	assert.deepEqual(gameOwn, ['--mark-size', '--tour-band'],
		'un jeton local s\'est ajouté à src/style.css : est-ce bien une mesure, et pas un pigment ?');
});

t('tout var(--…) référencé par les feuilles est défini dans tokens.css', () => {
	const defined = new Set([...TOKENS.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]));
	// Les deux mesures locales, déclarées par la feuille qui s'en sert et
	// vérifiées juste au-dessus : ce sont les seules dispenses.
	defined.add('--rail');
	defined.add('--mark-size');
	// La hauteur de la bande du tour (#86) : une mesure, pas un pigment, et la
	// seule chose du jeu qui se mesure contre le tour — la bande elle-même, le
	// rembourrage que chaque écran lui réserve, et le décalage des toasts RTC.
	defined.add('--tour-band');
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		for (const m of css.matchAll(/var\((--[a-z-]+)\)/g)) {
			assert.ok(defined.has(m[1]), `${name} utilise ${m[1]}, que tokens.css ne définit pas`);
		}
	}
});

// ------------------------------------------------- la ségrégation de la demo

t('la palette demo ne sort que sur le rituel et l\'intro', () => {
	for (const { selector, body } of rules(GAME)) {
		const used = DEMO_TOKENS.filter((tk) => body.includes(`var(${tk})`));
		if (!used.length) continue;
		assert.ok(EVENT_SELECTORS.some((s) => selector.includes(s)),
			`« ${selector} » emploie ${used.join(', ')} hors d'un événement (Bible §19)`);
	}
});

t('la console de préparation n\'a aucun accès à la palette demo', () => {
	for (const tk of DEMO_TOKENS) {
		assert.ok(!MAPGUI.includes(`var(${tk})`), `map-gui emploie ${tk} : ce n'est pas un événement`);
	}
});

t('aucun écran quotidien ne rappelle l\'ancien accent cyan', () => {
	// --accent a disparu avec la PHASE 19 : l'accent de l'UI courante est le
	// WARM WHITE, et le cyan est redevenu une couleur d'événement.
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		assert.ok(!css.includes('var(--accent)'), `${name} utilise encore var(--accent)`);
	}
	assert.ok(!TOKENS.includes('--accent:'), 'tokens.css redéfinit --accent');
});

// ------------------------------------------------------------ la typographie

t('les trois niveaux, et pas un de plus, sont déclarés', () => {
	for (const cls of ['.t-display', '.t-ui', '.t-data']) {
		assert.ok(TOKENS.includes(cls), `${cls} manque`);
	}
	const families = [...TOKENS.matchAll(/^\t--font-[a-z]+: '([^']+)'/gm)].map((m) => m[1]);
	assert.deepEqual([...new Set(families)].sort(), ['Departure Mono', 'IBM Plex Mono'],
		'exactement deux familles embarquées');
});

t('les deux familles ne se mélangent jamais dans une même pile', () => {
	// Leurs chasses diffèrent (0,6 em contre 0,6364) : un repli glyphe par glyphe
	// désalignerait tous les cadres ┌─┐ de la Bible §38.
	for (const m of TOKENS.matchAll(/--font-[a-z]+:([^;]+);/g)) {
		const stack = m[1];
		assert.ok(!(stack.includes('Departure Mono') && stack.includes('IBM Plex Mono')),
			`pile mixte interdite : ${stack.trim()}`);
	}
});

t('Departure Mono ne sert qu\'à des tailles multiples de 11 px', () => {
	// La police est dessinée sur une grille de 50 unités pour 550 d'em : hors des
	// multiples de 11 px, ses pixels tombent entre deux pixels d'écran et le
	// « bitmap » devient un flou. Mesuré sur le woff2 embarqué.
	for (const m of TOKENS.matchAll(/--fs-display[a-z-]*: (\d+)px;/g)) {
		assert.equal(Number(m[1]) % 11, 0, `--fs-display… = ${m[1]}px n'est pas sur la grille`);
	}
	for (const { selector, body } of rules(GAME)) {
		if (!/var\(--font-(display|ascii)\)/.test(body)) continue;
		for (const c of body.matchAll(/font-size: clamp\((\d+)px,[^,]+, ?(\d+)px\)/g)) {
			for (const px of [c[1], c[2]]) {
				assert.equal(Number(px) % 11, 0,
					`« ${selector} » : ${px}px hors de la grille 11 px de Departure Mono`);
			}
		}
	}
});

t('aucune graisse que les fichiers embarqués ne portent', () => {
	// Seules 400 et 500 sont servies. Au-delà, le navigateur synthétise un faux
	// gras — sur une chasse fixe, il déforme la couleur du bloc.
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font-weight: ([^;]+);/g)) {
			assert.ok(['400', '500'].includes(m[1].trim()),
				`${name} demande font-weight ${m[1].trim()} : non embarqué`);
		}
	}
});

t('les deux polices et leurs licences sont bien dans le dépôt', () => {
	for (const f of ['DepartureMono-Regular.woff2', 'IBMPlexMono-Regular.woff2',
		'IBMPlexMono-Medium.woff2', 'OFL-DepartureMono.txt', 'OFL-IBMPlexMono.txt']) {
		assert.ok(readFileSync(join(sim, 'public/fonts', f)).length > 0, `${f} manque ou est vide`);
	}
	for (const f of ['OFL-DepartureMono.txt', 'OFL-IBMPlexMono.txt']) {
		assert.match(read(join('public/fonts', f)), /SIL Open Font License, Version 1\.1/,
			`${f} n'est pas une OFL 1.1`);
	}
	// Servies depuis public/, jamais depuis un CDN : le jeu s'installe hors ligne.
	for (const m of TOKENS.matchAll(/src: url\('([^']+)'\)/g)) {
		assert.match(m[1], /^\/fonts\//, `police servie depuis ${m[1]}`);
	}
});

// -------------------------------------------------------- le pont vers le JS

t('les valeurs de repli de palette.js collent aux jetons', () => {
	const js = read('src/palette.js');
	const fallbacks = [...js.matchAll(/'(--[a-z-]+)': '(#[0-9a-f]{6})'/g)];
	assert.ok(fallbacks.length >= 6, 'la table de repli a disparu');
	for (const [, name, value] of fallbacks) {
		const m = TOKENS.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
		assert.ok(m, `${name} n'existe plus dans tokens.css`);
		assert.equal(value, m[1], `repli de ${name} désynchronisé : ${value} vs ${m[1]}`);
	}
});

t('plus aucune couleur en dur dans les couches vectorielles du scanner', () => {
	const js = read('src/scanner.js').replace(/\/\/.*$/gm, '');
	const hits = [...js.matchAll(/(?:color|fillColor): '(#[0-9a-fA-F]{3,8})'/g)].map((m) => m[1]);
	assert.deepEqual(hits, [], `scanner.js peint encore en dur : ${hits.join(', ')}`);
});

// --- le piège `pointer-events` de #ui ---------------------------------------

// `#ui` est en `pointer-events: none` et SEULS `button, input, select, label`
// reprennent la main. Tout écran plein cadre qui contient un élément
// interactif d'un autre genre — une carte Leaflet est un <div>, ses contrôles
// de zoom sont des <a> — doit donc reprendre le pointeur lui-même.
//
// Ce test existe parce que la règle a été perdue une fois : `.scanner` la
// portait, elle a disparu avec le plein cadre du scanner (#211), et FIELD s'est
// retrouvé avec une carte VISIBLE MAIS SOURDE — on la voyait sans pouvoir la
// déplacer. Aucun selftest de rendu ne peut l'attraper : le faux DOM ne calcule
// pas de style, et l'arbre était parfaitement correct.
t('pointer-events : tout écran portant une carte reprend la main sur le pointeur', () => {
	assert.match(GAME, /#ui\s*\{[^}]*pointer-events:\s*none/,
		'la prémisse du test : #ui laisse passer les clics');
	// `.terminal-field` est le plein cadre de FIELD, qui porte la carte du
	// GLOBAL SCANNER dans sa colonne de droite.
	const bloc = GAME.match(/\.terminal-field\s*\{[\s\S]*?\}/);
	assert.ok(bloc, '.terminal-field existe');
	assert.match(bloc[0], /pointer-events:\s*auto/,
		'sans quoi la carte est visible mais sourde');
});

console.log(`\n  ${n} tests OK — langage visuel (PHASE 19)`);
