// Logique pure de l'Operator Terminal (PHASE 02). Aucune E/S, aucun DOM :
// importable par le terminal côté navigateur et par le selftest.

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
// connu ; `null` quand /__map-api/scenes est injoignable (le footer affiche
// alors « ? LOCAL AREAS » et la liste montre un état d'erreur).
export function terminalModel({ operator, scenes }) {
	const name = String(operator?.name ?? '').toUpperCase() || 'UNKNOWN';
	const sessions = Array.isArray(operator?.sessions) ? operator.sessions : [];
	const targets = Array.isArray(operator?.targetLog) ? operator.targetLog : [];
	const known = Array.isArray(scenes);

	const areas = known
		? scenes.map((s) => ({ slug: s.slug, name: s.name, size: formatBytes(s.bytes) }))
		: [];

	const areaCount = known ? String(areas.length) : '?';
	const footer = [
		'LOCAL INSTALLATION',
		`OPERATOR ${name}`,
		`${areaCount} LOCAL AREAS`,
		`${sessions.length} SESSIONS`,
		`${targets.length} TARGETS LOGGED`,
	].join(' · ');

	return {
		operatorName: name,
		areas,
		areasKnown: known,
		footer,
		lastSession: sessions.length ? sessions[sessions.length - 1] : null,
	};
}
