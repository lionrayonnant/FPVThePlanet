// Logique pure de l'Operator Terminal (PHASE 02). Aucune E/S, aucun DOM :
// importable par le terminal côté navigateur et par le selftest.

import { countersOf, currentBuild } from './buildnotes-model.mjs';

// Taille lisible d'un répertoire de scène. Décimal (1 Go = 1e9) pour rester
// cohérent avec bootstrap.js (storageString) et l'affichage système.
export function formatBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
	if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
	return `${Math.round(n)} B`;
}

// `scenes` : tableau de { slug, name, bytes } quand le cache terrain est
// connu ; `null` quand /__map-api/scenes est injoignable (la liste montre alors
// un état d'erreur).
// `shared` : whether the server runs in `shared` mode (V1). The footer says
// WHERE the game runs, which is the server's mode — not whether acquisition is
// open. Every distributed desktop build ships with acquisition closed, and a
// footer keyed on it called the desktop client a SHARED SERVER (D1).
export function terminalModel({ operator, scenes, shared = false }) {
	const name = String(operator?.name ?? '').toUpperCase() || 'UNKNOWN';
	const sessions = Array.isArray(operator?.sessions) ? operator.sessions : [];
	const known = Array.isArray(scenes);

	const areas = known
		? scenes.map((s) => ({ slug: s.slug, name: s.name, size: formatBytes(s.bytes) }))
		: [];

	// Numéro de build affiché au pied (PHASE 21, BUILD NOTES) : dérivé des
	// compteurs opérateur, jamais d'un état séparé.
	const build = currentBuild(countersOf(operator));
	// D1 : deux mots, et rien d'autre. Le nom de l'opérateur et ses compteurs
	// sont rendus par ARCHIVE › OPERATOR, qui est leur place — les répéter sous
	// chaque écran faisait de FIELD un tableau de bord (Bible §30).
	const footer = [
		shared ? 'SHARED SERVER' : 'LOCAL INSTALLATION',
		`BUILD ${build}`,
	].join(' · ');

	return {
		operatorName: name,
		areas,
		areasKnown: known,
		footer,
		build,
		lastSession: sessions.length ? sessions[sessions.length - 1] : null,
	};
}
