// Résout les lignes de crédit fournisseur d'une scène (issue #18).
//
// Google impose d'afficher les copyrights des tuiles rendues ; on applique la
// même règle à tous les fournisseurs, Flyover compris. Module pur : importé par
// l'OSD dans le navigateur et par son selftest sous node.

// Les scènes bakées avant le champ `provider` viennent toutes de Flyover. On ne
// les re-prépare pas pour si peu : elles héritent de ce défaut à la lecture.
export const LEGACY_PROVIDER = Object.freeze({
	id: 'flyover',
	label: 'Apple Flyover',
	attribution: Object.freeze(['© Apple']),
});

export function creditLines(manifest) {
	const provider = manifest?.provider;
	const raw = provider?.attribution;
	const lines = (Array.isArray(raw) ? raw : [])
		.filter((s) => typeof s === 'string' && s.trim())
		.map((s) => s.trim());
	if (lines.length) return [...new Set(lines)];

	// Pas d'attribution utilisable dans le manifest. Un manifest version 2 (ou
	// tout provider.id absent) vient forcément de Flyover et hérite du crédit
	// Apple à bon droit ; un provider.id non-legacy sans attribution NE DOIT
	// JAMAIS retomber sur Apple — ce serait créditer le mauvais fournisseur.
	// On invente à la place un repli générique dérivé de son propre label :
	// moins précis, mais honnête (issue #18, retour de revue).
	const id = provider?.id;
	if (!id || id === LEGACY_PROVIDER.id) return LEGACY_PROVIDER.attribution;
	const label = typeof provider?.label === 'string' && provider.label.trim();
	return [`© ${label || id}`];
}

export function creditText(manifest) {
	return creditLines(manifest).join(' · ');
}
