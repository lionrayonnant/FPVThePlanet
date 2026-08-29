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
	const raw = manifest?.provider?.attribution;
	const lines = (Array.isArray(raw) ? raw : [])
		.filter((s) => typeof s === 'string' && s.trim())
		.map((s) => s.trim());
	const source = lines.length ? lines : LEGACY_PROVIDER.attribution;
	return [...new Set(source)];
}

export function creditText(manifest) {
	return creditLines(manifest).join(' · ');
}
