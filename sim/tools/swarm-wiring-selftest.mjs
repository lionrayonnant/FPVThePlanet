// node tools/swarm-wiring-selftest.mjs — le CÂBLAGE de l'essaim dans
// src/main.js (issue #29).
//
// Ce fichier lit du texte, pas un comportement, et c'est assumé. Trois règles
// de la spec ne vivent que dans main.js — une fonction de 3 300 lignes qui
// touche Rapier, WebGL, le réseau et le DOM, qu'aucun harnais Node ne peut
// instancier :
//
//   1. `new SwarmDrones(...)` est sous `if (!MODE.bench)`. Jamais au banc :
//      NO TARGET, et le banc est étanche.
//   2. `respawn()` et `__sim.teleport` appellent `swarm.reset()`. L'essaim
//      suit le SILLAGE : un saut sans reset le ferait passer droit à travers
//      tout ce qui sépare les deux points.
//   3. Dans `frame()`, `swarm.update()` est après le bloc caméra et avant
//      `lens.render`, avec la convention `frozen ? 0 : dt`.
//
// Un garde de source imparfait vaut mieux qu'un trou muet : la tranche 2 a
// laissé passer trois défauts silencieux faute d'un seul test. Ce qu'il attrape
// est une suppression ou un déplacement ; ce qu'il ne peut pas attraper, c'est
// un appel présent mais inerte. Le motif est celui de
// tools/loader-guard-selftest.mjs, qui verrouille lui aussi un chemin que rien
// d'autre n'atteint.
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// Le corps d'un bloc, du `{` qui suit `header` à son `}` apparié. Naïf sur les
// accolades en chaîne ou en commentaire, ce qui suffit ici : on ne cherche que
// la présence d'appels dans une fonction, pas à parser du JavaScript.
function bodyAfter(header) {
	const i = src.indexOf(header);
	if (i < 0) return null;
	const open = src.indexOf('{', i);
	let depth = 0;
	for (let k = open; k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(open, k);
	}
	return null;
}

// Le bloc qui ENTOURE l'occurrence `at` : on remonte jusqu'au `{` encore
// ouvert, et on rend les caractères qui le précèdent — c'est là qu'on lit la
// condition du `if`.
function guardOf(at) {
	let depth = 0;
	for (let k = at; k >= 0; k--) {
		if (src[k] === '}') depth++;
		else if (src[k] === '{') {
			if (depth === 0) return src.slice(Math.max(0, k - 120), k);
			depth--;
		}
	}
	return '';
}

console.log('swarm-wiring : jamais au banc');
{
	const at = [];
	for (let i = src.indexOf('new SwarmDrones('); i >= 0; i = src.indexOf('new SwarmDrones(', i + 1)) at.push(i);
	check('l\'essaim est bien construit à deux endroits (finishBoot et bootLive)', at.length === 2, `${at.length}`);
	check('chaque construction est sous `if (!MODE.bench)`',
		at.length > 0 && at.every((i) => /if\s*\(!MODE\.bench\)/.test(guardOf(i))),
		at.map((i) => (/if\s*\(!MODE\.bench\)/.test(guardOf(i)) ? 'ok' : 'NU')).join(' '));
	// Le corollaire visible : `debug()` ne doit rien rendre quand il n'y a pas
	// d'essaim, et pas planter en lisant `.debug()` sur null.
	check('debug().swarm est gardé sur l\'existence du modèle',
		/swarm:\s*swarm\?\.model\s*\?\s*swarm\.debug\(\)\s*:\s*undefined/.test(src));
}

console.log('\nswarm-wiring : le sillage se vide à chaque saut');
{
	const respawn = bodyAfter('function respawn()');
	const teleport = bodyAfter('\t\tteleport(x, y, z)');
	check('respawn() est trouvable', respawn !== null);
	check('__sim.teleport est trouvable', teleport !== null);
	check('respawn() remet l\'essaim sur le joueur', /swarm\?\.reset\(/.test(respawn ?? ''));
	check('__sim.teleport remet l\'essaim sur le joueur', /swarm\?\.reset\(/.test(teleport ?? ''));
	// Sur le joueur, et pas sur rien : reset(null) poserait les unités à
	// l'origine ENU, à des centaines de mètres sous la scène.
	check('les deux passent la position du joueur',
		/swarm\?\.reset\(physics\.position\)/.test(respawn ?? '') && /swarm\?\.reset\(physics\.position\)/.test(teleport ?? ''));
	// Le troisième saut : le début de vol, à côté de la pose de l'essaim.
	check('la pose de l\'essaim est suivie d\'un reset',
		/swarm\?\.setSwarm\([^\n]*\);\s*\n\s*swarm\?\.reset\(physics\.position\);/.test(src));
}

console.log('\nswarm-wiring : la place dans frame()');
{
	const frame = bodyAfter('function frame()');
	check('frame() est trouvable', frame !== null);
	const update = (frame ?? '').indexOf('swarm.update(');
	const ambient = (frame ?? '').indexOf('ambient.update(');
	const render = (frame ?? '').indexOf('lens.render(');
	check('swarm.update() est bien dans frame()', update > 0);
	check('après le bloc caméra — mesuré par les ambiants, qui en dépendent aussi',
		ambient > 0 && update > ambient, `ambient@${ambient} update@${update}`);
	check('et avant lens.render : la sortie traverse la lentille',
		render > 0 && update < render, `update@${update} render@${render}`);
	// La convention du dépôt : gelé, le modèle ne fait pas un pas, mais
	// update() tourne quand même.
	const call = (frame ?? '').slice(update, update + 400);
	check('convention `frozen ? 0 : dt`', /dt:\s*frozen\s*\?\s*0\s*:\s*dt/.test(call));
	// L'essaim ne touche à RIEN : aucun corps Rapier, aucune collision, aucune
	// cible, aucune usure. La garantie tient à ce que main.js ne lui passe que
	// des lectures — si quelqu'un lui donne `physics.body`, c'est ici qu'on le
	// voit.
	check('on ne lui passe que des lectures (pas de physics.body)', !/physics\.body/.test(call), call.match(/physics\.\w+/g)?.join(' '));
}

console.log(failures ? `\n${failures} échec(s).` : '\n3 blocs, tout passe.');
process.exit(failures ? 1 : 0);
