// Validation d'une entrée de dialogue (PHASE 21). Ce module transforme les
// règles d'écriture de la Bible en vérifications mécaniques. C'est ce qui
// permet de relire le corpus par échantillon : tout ce qui est vérifiable
// automatiquement l'est sur 100 % des entrées, l'humain ne juge que le ton.
import { CREW, RARITY, EVENTS, SLOTS, slotsUsed, pathsForSlots } from './catalog.mjs';

export const KNOWN_PATHS = new Set(Object.values(SLOTS).map((s) => s.path));

const MAX_LINE_CHARS = 90;   // au-delà, ce n'est plus du RTC, c'est un paragraphe
const MAX_LINES = 6;

// Bible §9-§12 : le crew ne sait pas qu'il est dans un jeu, ne s'adresse jamais
// au joueur, n'explique pas le lore et ne promet aucune suite.
export const STYLE_BANS = [
	{ re: /\bthe player\b|\bthe user\b/i, why: 'adresse au joueur' },
	{ re: /\bthe game\b|\bthis is (just )?a game\b|\bfourth wall\b/i, why: 'quatrième mur' },
	{ re: /\bLLM\b|\bprompt(ing|ed)?\b|\bneural net\b|\bmachine learning\b/i, why: 'vocabulaire IA moderne' },
	{ re: /\bto be continued\b|\bnext time\b|\bmore on (that|this) later\b/i, why: 'promesse de suite' },
	{ re: /\b(you|i)('ll| will) (see|find out|know)\b|\bexplain (it )?later\b/i, why: 'promesse de suite' },
	{ re: /\bplayer\b/i, why: 'vocabulaire de jeu vidéo' },
];

export function validateEntry(entry) {
	const p = [];
	const push = (msg) => p.push(msg);

	if (!entry?.id || typeof entry.id !== 'string') push('id manquant ou non textuel');
	if (!Array.isArray(entry?.events) || entry.events.length === 0) push('events vide');
	else for (const e of entry.events) if (!EVENTS[e]) push(`événement inconnu : ${e}`);

	if (!RARITY[entry?.rarity]) push(`rareté inconnue : ${entry?.rarity}`);

	if (!Array.isArray(entry?.characters) || entry.characters.length === 0) push('characters vide');
	else for (const c of entry.characters) if (!CREW.includes(c)) push(`locuteur hors crew : ${c}`);

	const lines = entry?.lines;
	if (!Array.isArray(lines) || lines.length === 0) push('lines vide');
	else {
		if (lines.length > MAX_LINES) push(`échange trop long : ${lines.length} répliques (max ${MAX_LINES})`);
		for (const l of lines) {
			if (!CREW.includes(l?.speaker)) push(`locuteur hors crew : ${l?.speaker}`);
			else if (!(entry.characters ?? []).includes(l.speaker)) push(`locuteur absent de characters : ${l.speaker}`);
			const text = String(l?.text ?? '');
			if (text.trim() === '') push('réplique vide');
			if (text.length > MAX_LINE_CHARS) push(`réplique trop longue : ${text.length} caractères`);
			for (const ban of STYLE_BANS) if (ban.re.test(text)) push(`${ban.why} : "${text}"`);
		}
	}

	// D3 : tout slot utilisé doit avoir son chemin dans requires. Sans cette
	// règle, une entrée peut être tirée dans un contexte où son slot ne résout
	// pas — et render() jetterait au nez du joueur.
	const requires = entry?.requires ?? [];
	if (!Array.isArray(requires)) push('requires n\'est pas un tableau');
	else {
		for (const path of requires) {
			if (!KNOWN_PATHS.has(path)) push(`chemin inconnu dans requires : ${path} (l'entrée ne serait jamais éligible)`);
		}
		const used = slotsUsed(entry);
		for (const name of used) if (!SLOTS[name]) push(`slot inconnu du catalogue : {${name}}`);
		for (const path of pathsForSlots(used)) {
			if (!requires.includes(path)) push(`slot utilisé sans son chemin dans requires : ${path}`);
		}
	}
	return p;
}

export function validateCorpus(entries) {
	const errors = [];
	const seen = new Set();
	let ok = 0;
	for (const entry of entries) {
		const problems = validateEntry(entry);
		if (seen.has(entry?.id)) problems.push(`id en double : ${entry.id}`);
		seen.add(entry?.id);
		if (problems.length === 0) ok++;
		else for (const problem of problems) errors.push({ id: entry?.id ?? '(sans id)', problem });
	}
	return { ok, errors };
}
