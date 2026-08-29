// Langage ASCII signature (PHASE 20, Bible §40). Trois usages :
//   information  → asciiTag('ok'|'alert'|'status', text) : [+] / [!] / [*]
//   technique    → asciiChain(['RX','FC','MOTOR']) : RX ───┤ FC ├── MOTOR
//   demo scene   → bigText(str) : gros ASCII art, UNIQUEMENT pendant les
//                  événements (consommé par les primitives de rituel).
// Module pur, Node-safe, aucun DOM. Jamais importé par le moteur physique.

export const ASCII_TAGS = { ok: '[+]', alert: '[!]', status: '[*]' };

export function asciiTag(kind, text) {
	const tag = ASCII_TAGS[kind];
	if (!tag) throw new Error(`tag ASCII inconnu : ${kind}`);
	return `${tag} ${text}`;
}

// Chaîne technique : extrémités nues, nœuds intermédiaires en boîte ┤ X ├.
export function asciiChain(nodes) {
	if (!Array.isArray(nodes) || nodes.length === 0) return '';
	if (nodes.length === 1) return nodes[0];
	if (nodes.length === 2) return `${nodes[0]} ── ${nodes[1]}`;
	const mid = nodes.slice(1, -1).map((s) => `┤ ${s} ├`).join('───');
	return `${nodes[0]} ───${mid}── ${nodes[nodes.length - 1]}`;
}

// Police banner 3×5. Volontairement fruste : c'est du gros ASCII d'événement,
// pas une police de lecture. A-Z + espace + ! + - suffisent (vocabulaire des
// hacks + FPVTP!). Toute autre entrée retombe sur l'espace.
export const BIG_FONT = {
	A: [' # ', '# #', '###', '# #', '# #'],
	B: ['## ', '# #', '## ', '# #', '## '],
	C: [' ##', '#  ', '#  ', '#  ', ' ##'],
	D: ['## ', '# #', '# #', '# #', '## '],
	E: ['###', '#  ', '## ', '#  ', '###'],
	F: ['###', '#  ', '## ', '#  ', '#  '],
	G: [' ##', '#  ', '# #', '# #', ' ##'],
	H: ['# #', '# #', '###', '# #', '# #'],
	I: ['###', ' # ', ' # ', ' # ', '###'],
	J: ['  #', '  #', '  #', '# #', ' # '],
	K: ['# #', '# #', '## ', '# #', '# #'],
	L: ['#  ', '#  ', '#  ', '#  ', '###'],
	M: ['# #', '###', '###', '# #', '# #'],
	N: ['# #', '###', '###', '###', '# #'],
	O: [' # ', '# #', '# #', '# #', ' # '],
	P: ['## ', '# #', '## ', '#  ', '#  '],
	Q: [' # ', '# #', '# #', ' # ', '  #'],
	R: ['## ', '# #', '## ', '# #', '# #'],
	S: [' ##', '#  ', ' # ', '  #', '## '],
	T: ['###', ' # ', ' # ', ' # ', ' # '],
	U: ['# #', '# #', '# #', '# #', '###'],
	V: ['# #', '# #', '# #', '# #', ' # '],
	W: ['# #', '# #', '###', '###', '# #'],
	X: ['# #', '# #', ' # ', '# #', '# #'],
	Y: ['# #', '# #', ' # ', ' # ', ' # '],
	Z: ['###', '  #', ' # ', '#  ', '###'],
	' ': ['   ', '   ', '   ', '   ', '   '],
	'!': [' # ', ' # ', ' # ', '   ', ' # '],
	'-': ['   ', '   ', '###', '   ', '   '],
};

export function bigText(str) {
	const rows = ['', '', '', '', ''];
	for (const ch of String(str).toUpperCase()) {
		const glyph = BIG_FONT[ch] ?? BIG_FONT[' '];
		for (let i = 0; i < 5; i++) rows[i] += (rows[i] ? ' ' : '') + glyph[i];
	}
	return rows;
}
