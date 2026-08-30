// BUILD NOTES (PHASE 21, D8). Une échelle écrite à la main : le volume est trop
// faible et trop curatorial pour la génération en lot.
//
// Règle d'écriture, et raison d'être du selftest : une note parle de l'OUTIL,
// AU PASSÉ. Jamais de l'opérateur, jamais d'une suite. C'est ce qui laisse le
// lore décoratif alors même que l'échelle se déverrouille au fil des sessions.

export const NOTES = [
	{ build: '0.1.0', unlock: { terrains: 0, sessions: 0, targets: 0 }, lines: [
		'first public build',
		'terrain import works. mostly',
	] },
	{ build: '0.1.4', unlock: { terrains: 1, sessions: 0, targets: 0 }, lines: [
		'fixed: tile 842 decoded twice',
		'mikhail was right',
	] },
	{ build: '0.2.0', unlock: { terrains: 1, sessions: 1, targets: 0 }, lines: [
		'session log added',
		'no crash recovery, sessions kept anyway',
	] },
	{ build: '0.2.1', unlock: { terrains: 1, sessions: 3, targets: 0 }, lines: [
		'fixed: session timestamp off by one hour on the export box',
		'root: leave the clock alone',
	] },
	{ build: '0.3.0', unlock: { terrains: 2, sessions: 3, targets: 1 }, lines: [
		'target scan integrated',
		'scan radius tuned against three terrains, not one',
	] },
	{ build: '0.3.2', unlock: { terrains: 2, sessions: 5, targets: 2 }, lines: [
		'fixed: target log duplicated entries on resume',
		'jensen found it, cron never complained',
	] },
	{ build: '0.4.0', unlock: { terrains: 3, sessions: 6, targets: 3 }, lines: [
		'control vector capture rewritten',
		'old capture dropped the last input on slow machines',
	] },
	{ build: '0.5.0', unlock: { terrains: 3, sessions: 9, targets: 5 }, lines: [
		'weather bulletin wired to world state',
		'forecast text pulled from the same feed as the terrain query',
	] },
	{ build: '0.5.3', unlock: { terrains: 4, sessions: 12, targets: 6 }, lines: [
		'fixed: forecast request retried forever on a dead feed',
		'now gives up after three tries and says so',
	] },
	{ build: '0.6.0', unlock: { terrains: 4, sessions: 15, targets: 8 }, lines: [
		'operator switching added',
		'mikhail: about time',
	] },
	{ build: '0.7.0', unlock: { terrains: 5, sessions: 20, targets: 10 }, lines: [
		'terrain cache pruning added',
		'oldest unopened terrain drops first past the storage cap',
	] },
	{ build: '0.9.0', unlock: { terrains: 6, sessions: 25, targets: 13 }, lines: [
		'fixed: cache pruning counted a terrain twice under its old and new slug',
		'root signed off after a week of watching it run clean',
	] },
];

export function countersOf(operator) {
	return {
		terrains: operator?.terrainCache?.length ?? 0,
		sessions: operator?.sessions?.length ?? 0,
		targets: (operator?.sessions ?? []).filter((s) => s?.target).length,
	};
}

const reached = (c, u) => c.terrains >= u.terrains && c.sessions >= u.sessions && c.targets >= u.targets;

// Un préfixe, jamais un filtre : les seuils étant croissants (le selftest le
// fige), la première note hors de portée arrête l'échelle. Sans ça, un trou
// dans la liste donnerait un numéro de build incohérent avec ce qui est lisible.
export function unlockedNotes(counters) {
	const out = [];
	for (const note of NOTES) {
		if (!reached(counters, note.unlock)) break;
		out.push(note);
	}
	return out.length ? out : [NOTES[0]];
}

export function currentBuild(counters) {
	return unlockedNotes(counters).at(-1).build;
}
