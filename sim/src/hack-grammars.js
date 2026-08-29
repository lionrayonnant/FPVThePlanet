// Motifs visuels par famille de hacking (PHASE 09, Bible §17). Chaque motif
// identifie sa famille SANS que le joueur ait à lire son nom (critère
// d'acceptation). Purement décoratif : la seule donnée qui entre est un `seed`
// cosmétique et un temps `t` en secondes.
//
// Contrat d'un motif : draw(el: HTMLPreElement, { t: number, seed: number }).
// Écrit dans el.textContent. Pas d'état module — tout dérive de (t, seed).

const W = 44; // largeur du champ ASCII
const H = 12; // hauteur

const frame = (rows) => rows.map((r) => r.padEnd(W).slice(0, W)).join('\n');

export function drawNeutral(el, { t }) {
	const rows = [];
	for (let y = 0; y < H; y++) {
		let row = '';
		for (let x = 0; x < W; x++) {
			row += ((x + y + Math.floor(t * 8)) % 7 === 0) ? '·' : ' ';
		}
		rows.push(row);
	}
	el.textContent = frame(rows);
}

// Rempli en Task 5. Toute clé absente retombe sur drawNeutral (voir hack.js).
export const GRAMMARS = {};
