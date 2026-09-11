// node tools/dev-flags-selftest.mjs — les drapeaux de dev qui portent une
// RÈGLE (issue #29) : `?swarm=<n>` et la liste de familles de `?family=`.
//
// Ce fichier existe pour une raison précise : ces deux règles vivaient dans
// src/main.js, où rien ne pouvait les atteindre, et elles y ont laissé passer
// deux défauts silencieux d'affilée — `?swarm=0` qui donnait un essaim de six,
// et `?swarm=<n>` que personne ne lisait. Le principe qu'elles partagent est
// le seul vrai objet du test : un drapeau de dev REFUSE ce qu'il ne peut pas
// honorer, il ne rend jamais autre chose que ce qu'on lui a demandé.
import { parseSwarmFlag, parseSceneFlag, devFamilies } from './dev-flags.mjs';
import { SWARM_SIZE_MIN, SWARM_SIZE_MAX, SWARM_FAMILY, TARGET_FAMILIES } from './target-model.mjs';
import { FAMILIES } from '../src/drone-profiles.js';
import { DOCTRINE_NAMES, doctrineFor } from '../src/swarm.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const refuses = (raw) => {
	try { parseSwarmFlag(raw); return false; } catch { return true; }
};

console.log('dev-flags : ?swarm=<n>');
{
	check('absent : aucun essaim', parseSwarmFlag(null) === null && parseSwarmFlag(undefined) === null);

	// LA propriété : le drapeau tient sa promesse, taille par taille. Un
	// rabattement silencieux rendrait 6 pour 3 et 12 pour 99 — c'est le défaut
	// qu'on a corrigé, et c'est celui-ci qui le tient.
	let exact = true;
	for (let n = SWARM_SIZE_MIN; n <= SWARM_SIZE_MAX; n++) {
		const d = parseSwarmFlag(String(n));
		if (d.size !== n) exact = false;
	}
	check(`?swarm=<n> rend exactement n sur ${SWARM_SIZE_MIN}..${SWARM_SIZE_MAX}`, exact);

	// Hors plage : refus, jamais un rabattement. Le jeu lui-même ne peut tirer
	// qu'entre 6 et 12 ; un chemin de dev qui rabattrait montrerait un essaim
	// que le jeu ne produit pas.
	check('?swarm=0 refuse (le défaut d\'origine : il donnait 6)', refuses('0'));
	check(`?swarm=${SWARM_SIZE_MIN - 1} refuse au lieu de rabattre`, refuses(String(SWARM_SIZE_MIN - 1)));
	check(`?swarm=${SWARM_SIZE_MAX + 1} refuse au lieu de rabattre`, refuses(String(SWARM_SIZE_MAX + 1)));
	check('?swarm=3 refuse au lieu de rendre 6', refuses('3'));
	check('?swarm=99 refuse au lieu de rendre 12', refuses('99'));
	check('?swarm= (vide) refuse — Number(\'\') vaut 0', refuses(''));
	check('?swarm=abc refuse', refuses('abc'));
	check('?swarm=8.5 refuse : ce n\'est pas un entier', refuses('8.5'));
	check('?swarm=-6 refuse', refuses('-6'));
	check('le message nomme la plage', (() => {
		try { parseSwarmFlag('99'); return false; } catch (e) {
			return e.message.includes(String(SWARM_SIZE_MIN)) && e.message.includes(String(SWARM_SIZE_MAX));
		}
	})());

	// La forme du descripteur : c'est celle que resolveTarget() persiste, sinon
	// SwarmDrones.setSwarm() aurait deux chemins au lieu d'un.
	const d = parseSwarmFlag('9');
	check('descripteur : { size, doctrineSeed } et rien d\'autre',
		Object.keys(d).sort().join(',') === 'doctrineSeed,size' && typeof d.doctrineSeed === 'string' && d.doctrineSeed.length > 0);
	check('deux tailles donnent deux doctrines tirées séparément',
		parseSwarmFlag('7').doctrineSeed !== parseSwarmFlag('8').doctrineSeed);
	check('déterministe : deux appels, même graine',
		parseSwarmFlag('7').doctrineSeed === parseSwarmFlag('7').doctrineSeed);
}

console.log('\ndev-flags : ?swarm=<n>:<doctrine>');
{
	// Rétrocompatibilité : la forme sans doctrine n'a pas bougé.
	check('?swarm=8 (sans doctrine) rend toujours { size: 8, doctrineSeed: "dev::swarm::8" }',
		JSON.stringify(parseSwarmFlag('8')) === JSON.stringify({ size: 8, doctrineSeed: 'dev::swarm::8' }));

	// LA propriété qui motive ce drapeau : sur 6..12, le tirage sur la seule
	// taille donne cloud six fois sur sept et jamais wedge/screen (vérifié sur
	// 5000 graines). `:<doctrine>` doit rendre chacune des quatre atteignable,
	// sur une taille où le tirage nu échoue déjà (n=8 donne cloud).
	for (const name of DOCTRINE_NAMES) {
		const d = parseSwarmFlag(`8:${name}`);
		check(`?swarm=8:${name} rend size=8 et la doctrine ${name}`,
			d.size === 8 && doctrineFor(d.doctrineSeed) === name);
	}

	// Doctrine inconnue : refus nommant les valeurs valides, jamais un
	// rabattement sur le tirage nu — même règle que la taille hors plage.
	check('?swarm=8:bogus refuse', refuses('8:bogus'));
	check('le message nomme les doctrines valides', (() => {
		try { parseSwarmFlag('8:bogus'); return false; } catch (e) {
			return DOCTRINE_NAMES.every((name) => e.message.includes(name));
		}
	})());

	// Toujours soumis à la règle de taille : une doctrine valide ne sauve pas
	// une taille hors plage.
	check('?swarm=99:wedge refuse (taille hors plage malgré une doctrine valide)', refuses('99:wedge'));

	// Déterministe, comme la forme sans doctrine.
	check('?swarm=8:wedge déterministe : deux appels, même graine',
		parseSwarmFlag('8:wedge').doctrineSeed === parseSwarmFlag('8:wedge').doctrineSeed);
}

console.log('\ndev-flags : ?family=<f>');
{
	const dev = devFamilies(FAMILIES);
	check('le nœud d\'essaim est atteignable en dev', dev.includes(SWARM_FAMILY));
	check('toutes les familles ordinaires le restent', FAMILIES.every((f) => dev.includes(f)));
	check('rien d\'autre n\'a été ajouté', dev.length === FAMILIES.length + 1);
	// LA garantie qui compte : la rareté en jeu normal. Le nœud ne doit entrer
	// ni dans les familles jouables ordinaires ni dans le tirage du TARGET
	// SCAN — la liste de dev est la SEULE porte.
	check('le nœud reste hors de FAMILIES', !FAMILIES.includes(SWARM_FAMILY));
	check('le nœud reste hors de TARGET_FAMILIES', !TARGET_FAMILIES.includes(SWARM_FAMILY));
	check('devFamilies() ne mute pas FAMILIES', !FAMILIES.includes(SWARM_FAMILY));
}

console.log('\ndev-flags : ?scene=<slug>');
{
	const refusesScene = (raw) => {
		try { parseSceneFlag(raw); return false; } catch { return true; }
	};
	check('absent : pas de carte', parseSceneFlag(null) === null && parseSceneFlag(undefined) === null && parseSceneFlag('') === null);
	check('un slug passe tel quel', parseSceneFlag('paris-tour-eiffel') === 'paris-tour-eiffel' && parseSceneFlag('a1') === 'a1');
	// LA propriété : rien qui ne soit pas un slug ne sort d'ici. Le message
	// « carte inconnue » de main.js reprend la valeur, et l'écran de chargement
	// l'affichait via innerHTML — un lien forgé exécutait du balisage dans
	// l'origine du jeu.
	check('du balisage est refusé', refusesScene('<img src=x onerror=alert(1)>'));
	check('les guillemets et espaces sont refusés', refusesScene('a"b') && refusesScene('a b'));
	check('les majuscules, points et slashs sont refusés', refusesScene('Paris') && refusesScene('../x') && refusesScene('a.b'));
	check('le message de refus ne reprend pas la valeur', (() => {
		try { parseSceneFlag('<b>'); return false; } catch (e) { return !e.message.includes('<b>'); }
	})());
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
