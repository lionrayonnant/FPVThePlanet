// Versionnage du dépôt (issue #257).
//
// Le modèle pur : pas de disque, pas de git, pas de réseau. Tout ce qui décide
// — le prochain numéro, la découpe du CHANGELOG, les liens de comparaison — vit
// ici pour que release-selftest.mjs le vérifie sans toucher au dépôt, et que
// tools/release.mjs se réduise aux effets de bord.
//
// À ne pas confondre avec tools/buildnotes-model.mjs : les numéros de build de
// l'écran BUILD NOTES sont du lore diégétique, ils ne suivent pas cette version.

export const UNRELEASED = 'Non publié';
export const REPO_URL = 'https://github.com/lionrayonnant/FPVTP';

const SECTION = /^## \[([^\]]+)\](?:\s+[-—]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text) {
	const m = SEMVER.exec(String(text ?? '').trim());
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v) {
	return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a, b) {
	const x = typeof a === 'string' ? parseVersion(a) : a;
	const y = typeof b === 'string' ? parseVersion(b) : b;
	if (!x || !y) throw new Error('comparaison de versions illisibles');
	return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
}

export function tagOf(version) {
	return `v${version}`;
}

// kind : 'major' | 'minor' | 'patch', ou un X.Y.Z explicite (qui doit être
// strictement supérieur à la version courante — on ne redescend jamais).
export function bumpVersion(current, kind) {
	const cur = parseVersion(current);
	if (!cur) throw new Error(`version courante illisible : ${current}`);
	const explicit = parseVersion(kind);
	if (explicit) {
		if (compareVersions(explicit, cur) <= 0) {
			throw new Error(`${formatVersion(explicit)} n'est pas au-dessus de ${current}`);
		}
		return formatVersion(explicit);
	}
	switch (kind) {
		case 'major': return formatVersion({ major: cur.major + 1, minor: 0, patch: 0 });
		case 'minor': return formatVersion({ major: cur.major, minor: cur.minor + 1, patch: 0 });
		case 'patch': return formatVersion({ major: cur.major, minor: cur.minor, patch: cur.patch + 1 });
		default: throw new Error(`incrément inconnu : ${kind} (major | minor | patch | X.Y.Z)`);
	}
}

// Découpe le CHANGELOG en en-tête + sections + bloc de liens final. Les
// définitions de liens ne sont reconnues qu'en fin de fichier : c'est le seul
// endroit où on les écrit, et le seul que la release réécrit.
export function parseChangelog(text) {
	const lines = String(text).replace(/\r\n/g, '\n').split('\n');
	const head = [];
	const sections = [];
	const links = [];
	let cur = null;
	let inLinks = false;
	for (const line of lines) {
		const s = SECTION.exec(line);
		if (s) {
			inLinks = false;
			cur = { name: s[1], date: s[2] || null, body: [] };
			sections.push(cur);
			continue;
		}
		const l = LINK.exec(line);
		if (l) {
			inLinks = true;
			links.push({ name: l[1], url: l[2] });
			continue;
		}
		if (inLinks && line.trim() === '') continue;
		inLinks = false;
		(cur ? cur.body : head).push(line);
	}
	return { head, sections, links };
}

function trimBlock(lines) {
	const out = lines.slice();
	while (out.length && out[0].trim() === '') out.shift();
	while (out.length && out[out.length - 1].trim() === '') out.pop();
	return out;
}

export function hasEntries(section) {
	return !!section && trimBlock(section.body).some((l) => /^\s*[-*]\s+\S/.test(l));
}

// Les liens de comparaison, régénérés à chaque release : « Non publié » pointe
// sur le delta depuis la dernière version, chaque version sur le delta depuis la
// précédente, la première sur son tag.
export function changelogLinks(sections, repo = REPO_URL) {
	const released = sections
		.filter((s) => parseVersion(s.name))
		.sort((a, b) => compareVersions(b.name, a.name));
	const links = [];
	if (sections.some((s) => s.name === UNRELEASED)) {
		links.push({
			name: UNRELEASED,
			url: released.length
				? `${repo}/compare/${tagOf(released[0].name)}...HEAD`
				: `${repo}/commits/main`,
		});
	}
	released.forEach((s, i) => {
		const older = released[i + 1];
		links.push({
			name: s.name,
			url: older
				? `${repo}/compare/${tagOf(older.name)}...${tagOf(s.name)}`
				: `${repo}/releases/tag/${tagOf(s.name)}`,
		});
	});
	return links;
}

export function renderChangelog({ head, sections }, repo = REPO_URL) {
	const parts = [trimBlock(head).join('\n')];
	for (const s of sections) {
		const title = s.date ? `## [${s.name}] - ${s.date}` : `## [${s.name}]`;
		const body = trimBlock(s.body);
		parts.push(body.length ? `${title}\n\n${body.join('\n')}` : title);
	}
	const links = changelogLinks(sections, repo).map((l) => `[${l.name}]: ${l.url}`);
	if (links.length) parts.push(links.join('\n'));
	return `${parts.join('\n\n')}\n`;
}

// Date la section « Non publié » au nom de la version qui sort, et rouvre une
// section « Non publié » vide au-dessus.
export function releaseChangelog(text, version, date, repo = REPO_URL) {
	if (!parseVersion(version)) throw new Error(`version illisible : ${version}`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`date illisible : ${date}`);
	const doc = parseChangelog(text);
	const unreleased = doc.sections.find((s) => s.name === UNRELEASED);
	if (!unreleased) throw new Error(`CHANGELOG.md : section « ${UNRELEASED} » introuvable`);
	if (!hasEntries(unreleased)) {
		throw new Error(`CHANGELOG.md : « ${UNRELEASED} » est vide, rien à publier`);
	}
	if (doc.sections.some((s) => s.name === version)) {
		throw new Error(`CHANGELOG.md : la version ${version} y figure déjà`);
	}
	const released = { name: version, date, body: unreleased.body };
	const sections = doc.sections.map((s) => (s === unreleased ? released : s));
	sections.unshift({ name: UNRELEASED, date: null, body: [] });
	return renderChangelog({ head: doc.head, sections }, repo);
}

// Les notes d'une version, telles quelles : ce que le workflow release.yml
// pousse dans le corps de la GitHub Release.
export function releaseNotes(text, version) {
	const doc = parseChangelog(text);
	const section = doc.sections.find((s) => s.name === version);
	if (!section) throw new Error(`CHANGELOG.md : aucune section pour ${version}`);
	return trimBlock(section.body).join('\n');
}
