// TARGET SCAN (PHASE 08, Bible §15). Interaction courte : une liste de signaux,
// le joueur en choisit un. On n'affiche QUE ce qui est réellement connu avant
// le vol — jamais la famille, la caméra, les rates, la batterie.
//
// Un seul écran depuis l'issue #49 : la fiche pré-hack a disparu et ce qu'elle
// portait d'utile tient sur la ligne (tools/target-model.mjs:scanLines). Quatre
// de ses sept champs étaient les mêmes constantes pour toutes les cibles et
// n'ont jamais départagé deux signaux ; CONDITIONS est déjà en tête d'écran.
// Activer une ligne CHOISIT donc la cible — une frappe, plus deux.
//
// Écran client pur : rendu avec le look terminal (screen/button de terminal.js),
// aucune dépendance Three/Rapier. La génération vient de tools/target-model.mjs,
// bundlée par Vite. La grammaire ↑/↓ + Entrée vit dans menu-nav.js (issue
// #123) : chaque signal est un vrai bouton, le curseur est le focus natif —
// cliquable, tabulable, et pilotable à la manette.
import { screen, button, keyHints } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { generateTargetScan, scanLines } from '../tools/target-model.mjs';
import { conditionsBlock } from './weather.js';
import { uiAudio } from './ui-audio.js';

// Plus de RTC sur TARGET SCAN depuis #243.
// Le crew ne commente plus l'écran qu'on regarde — il parle sur la racine, et
// en toast pendant le hack et l'acquisition. TARGET_SCAN, TARGET_SELECTED et
// WEATHER restent dans le flux mêlé de la racine.

// `weather` : le snapshot du monde pour cette zone (issue #76), résolu avant le
// scan par main.js. `null` si la zone n'a pas de coordonnées — on n'invente
// alors pas de météo, le bloc CONDITIONS est simplement absent.
// `swarmChance` (issue #29): the caller computes it from the operator state
// (the early guarantee) and it must be the SAME value it sends to the server,
// so the screen hands it back with the choice rather than keeping it.
export function runTargetScan(root, { seed, count, weather = null, swarmChance }) {
	const scan = generateTargetScan({ seed, count, swarmChance });
	const condBlock = conditionsBlock(weather);
	return new Promise((resolve) => {
		// `terminal-scan` names the screen for the tour (#86), which finds where
		// the operator is standing by looking for it. The look is unchanged: the
		// class carries no style.
		const s = screen(root, 'terminal-scan');
		// createElement plutôt qu'innerHTML, comme screen() lui-même : c'est ce
		// qui rend l'écran montable sur le faux DOM, donc testable sans
		// navigateur (tools/target-scan-render-selftest.mjs, issue #73).
		const head = document.createElement('pre');
		head.textContent = `TARGET SCAN\n\n${condBlock ? `${condBlock.join('\n')}\n\n` : ''}SIGNALS DETECTED`;
		s.box.appendChild(head);

		const wrap = document.createElement('div');
		wrap.className = 'terminal-list';
		// Les lignes sont calculées d'un bloc : l'alignement des colonnes est une
		// propriété de l'ensemble, et la ligne d'un cluster est bien plus longue
		// que les autres. L'écran affiche, il ne formate pas.
		scanLines(scan.candidates).forEach((line, i) => {
			wrap.appendChild(button(line, () => choose(i), 'terminal-row'));
		});
		s.box.appendChild(wrap);
		// D15 : Échap ressort, et il le dit. La liste n'a pas de bouton BACK —
		// choisir un signal est le seul geste qu'elle propose — donc la touche
		// est la SEULE sortie visible de l'écran.
		s.box.appendChild(keyHints([['ESC', 'BACK']]));

		// La garde de l'issue #73, sous sa forme restante. Le défaut d'origine
		// était que la même frappe atteignait à la fois le bouton focalisé et un
		// second chemin d'activation : `sheet()` était appelée deux fois et deux
		// fiches s'empilaient. Sans fiche il n'y a plus rien à empiler, mais les
		// deux chemins existent toujours — sans ce drapeau on démonterait
		// l'écran deux fois, le second démontage travaillant sur un arbre déjà
		// retiré, et on jouerait le son du choix en double.
		let done = false;

		// Échap / bouton B ressort vers le choix de zone. L'écran ne sait pas ce
		// que ça coûte — à cet instant main.js a déjà lancé le préchargement de
		// la carte — donc il se contente de le signaler et laisse l'appelant
		// décider : les écrans restent des clients purs.
		const cancel = () => {
			if (done) return;
			done = true;
			listNav.detach();
			s.remove();
			resolve({ cancelled: true });
		};

		const listNav = menuNav(s.el, { back: cancel });

		const choose = (index) => {
			if (done) return;
			done = true;
			listNav.detach();
			uiAudio.play('TARGET_FOUND');
			s.remove();
			resolve({ seed: scan.seed, count: scan.count, index, swarmChance: scan.swarmChance, swarmAt: scan.swarmAt });
		};
	});
}
