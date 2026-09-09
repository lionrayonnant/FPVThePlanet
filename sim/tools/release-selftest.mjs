// Selftest du versionnage (issue #257).
//
// Le dépôt n'avait ni version, ni tag, ni release : « la build d'hier » ne se
// désignait que par un SHA. release-model.mjs décide seul du prochain numéro et
// de la découpe du CHANGELOG ; ce test le tient sans jamais toucher au dépôt, et
// vérifie au passage que le CHANGELOG réel reste lisible par cet outil.
//
// Lancer : node tools/release-selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	UNRELEASED,
	bumpVersion,
	changelogLinks,
	compareVersions,
	hasEntries,
	parseChangelog,
	parseVersion,
	releaseChangelog,
	releaseNotes,
	renderChangelog,
	tagOf,
} from './release-model.mjs';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(SIM_ROOT);

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const SAMPLE = `# Changelog

Le format suit Keep a Changelog.

## [Non publié]

### Ajouté

- une chose

## [0.2.0] - 2026-08-01

### Modifié

- une autre

## [0.1.0] - 2026-07-01

- première

[Non publié]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lionrayonnant/FPVThePlanet/releases/tag/v0.1.0
`;

t('parseVersion ne lit que du X.Y.Z, avec suffixe pre-release optionnel', () => {
	assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
	assert.deepEqual(parseVersion('0.1.0-beta'), { major: 0, minor: 1, patch: 0, prerelease: 'beta' });
	assert.deepEqual(parseVersion('1.0.0-rc.1'), { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' });
	assert.equal(parseVersion('v1.2.3'), null, 'le préfixe v est un nom de tag, pas une version');
	assert.equal(parseVersion('1.2'), null);
	assert.equal(parseVersion(''), null);
	assert.equal(parseVersion(undefined), null);
});

t('compareVersions ordonne par champ, pas par chaîne', () => {
	// « 0.10.0 » < « 0.9.0 » en comparaison lexicale : la régression classique.
	assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
	assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
	assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
	assert.ok(compareVersions('0.1.0-beta', '0.1.0') < 0, 'une pre-release passe avant la version stable');
	assert.ok(compareVersions('0.1.0-beta', '0.1.0-alpha') > 0);
});

t('bumpVersion remet à zéro ce qui est à droite', () => {
	assert.equal(bumpVersion('0.4.7', 'patch'), '0.4.8');
	assert.equal(bumpVersion('0.4.7', 'minor'), '0.5.0');
	assert.equal(bumpVersion('0.4.7', 'major'), '1.0.0');
});

t('bumpVersion accepte un X.Y.Z explicite mais jamais en arrière', () => {
	assert.equal(bumpVersion('0.4.7', '1.0.0'), '1.0.0');
	assert.throws(() => bumpVersion('0.4.7', '0.4.6'), /au-dessus/);
	assert.throws(() => bumpVersion('0.4.7', '0.4.7'), /au-dessus/, 'republier le même numéro est un refus');
	assert.throws(() => bumpVersion('0.4.7', 'majeur'), /incrément inconnu/);
	assert.throws(() => bumpVersion('rien', 'patch'), /illisible/);
});

t('tagOf préfixe le tag, une seule fois', () => {
	assert.equal(tagOf('0.1.0'), 'v0.1.0');
});

t('parseChangelog sépare en-tête, sections et bloc de liens', () => {
	const doc = parseChangelog(SAMPLE);
	assert.deepEqual(doc.sections.map((s) => s.name), [UNRELEASED, '0.2.0', '0.1.0']);
	assert.equal(doc.sections[1].date, '2026-08-01');
	assert.equal(doc.sections[0].date, null);
	assert.equal(doc.links.length, 3);
	assert.match(doc.head.join('\n'), /^# Changelog/);
	assert.ok(!doc.sections.some((s) => s.body.some((l) => /^\[/.test(l))), 'les liens ne restent pas dans un corps');
});

t('renderChangelog est stable sur un fichier déjà bien formé', () => {
	assert.equal(renderChangelog(parseChangelog(SAMPLE)), SAMPLE);
});

t('hasEntries distingue une section vide d\'une section à rubriques vides', () => {
	const doc = parseChangelog(`# C\n\n## [${UNRELEASED}]\n\n### Ajouté\n\n## [0.1.0] - 2026-07-01\n\n- une chose\n`);
	assert.equal(hasEntries(doc.sections[0]), false, 'une rubrique sans puce ne compte pas');
	assert.equal(hasEntries(doc.sections[1]), true);
});

t('releaseChangelog date la section et en rouvre une vide', () => {
	const next = releaseChangelog(SAMPLE, '0.3.0', '2026-09-06');
	const doc = parseChangelog(next);
	assert.deepEqual(doc.sections.map((s) => s.name), [UNRELEASED, '0.3.0', '0.2.0', '0.1.0']);
	assert.equal(doc.sections[0].body.join('').trim(), '', 'la nouvelle section « Non publié » part vide');
	assert.equal(hasEntries(doc.sections[0]), false);
	assert.equal(doc.sections[1].date, '2026-09-06');
	assert.match(next, /## \[0\.3\.0\] - 2026-09-06/);
	assert.match(releaseNotes(next, '0.3.0'), /- une chose/, 'les entrées suivent la version qui sort');
});

t('releaseChangelog régénère les liens de comparaison', () => {
	const next = releaseChangelog(SAMPLE, '0.3.0', '2026-09-06');
	assert.match(next, /\[Non publié\]: \S+\/compare\/v0\.3\.0\.\.\.HEAD/);
	assert.match(next, /\[0\.3\.0\]: \S+\/compare\/v0\.2\.0\.\.\.v0\.3\.0/);
	assert.match(next, /\[0\.1\.0\]: \S+\/releases\/tag\/v0\.1\.0/, 'la plus ancienne pointe son tag');
	assert.equal(next.match(/^\[Non publié\]:/gm).length, 1, 'un seul lien « Non publié »');
});

t('changelogLinks tient le cas du tout premier jet', () => {
	const links = changelogLinks(parseChangelog(`# C\n\n## [${UNRELEASED}]\n\n- rien encore\n`).sections);
	assert.equal(links.length, 1);
	assert.match(links[0].url, /commits\/main$/, 'sans version publiée, pas de compare à inventer');
});

t('releaseChangelog REFUSE de publier du vide ou un doublon', () => {
	const empty = `# C\n\n## [${UNRELEASED}]\n\n## [0.1.0] - 2026-07-01\n\n- première\n`;
	assert.throws(() => releaseChangelog(empty, '0.2.0', '2026-09-06'), /est vide/);
	assert.throws(() => releaseChangelog(SAMPLE, '0.2.0', '2026-09-06'), /figure déjà/);
	assert.throws(() => releaseChangelog(SAMPLE, '0.3', '2026-09-06'), /illisible/);
	assert.throws(() => releaseChangelog(SAMPLE, '0.3.0', '06/09/2026'), /date illisible/);
	assert.throws(() => releaseChangelog('# C\n\n## [0.1.0] - 2026-07-01\n', '0.2.0', '2026-09-06'), /introuvable/);
});

t('le CHANGELOG.md du dépôt se lit avec cet outil', () => {
	const raw = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
	const doc = parseChangelog(raw);
	assert.equal(doc.sections[0]?.name, UNRELEASED, 'la section ouverte est toujours la première');
	for (const s of doc.sections.slice(1)) {
		assert.ok(parseVersion(s.name), `section non versionnée : ${s.name}`);
		assert.match(s.date || '', /^\d{4}-\d{2}-\d{2}$/, `${s.name} n'est pas datée`);
	}
});

t('sim/package.json porte une version SemVer et le script release', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'package.json'), 'utf8'));
	assert.ok(parseVersion(pkg.version), `version illisible : ${pkg.version}`);
	assert.equal(pkg.scripts.release, 'node tools/release.mjs');
	const lock = JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'package-lock.json'), 'utf8'));
	assert.equal(lock.version, pkg.version, 'le lockfile suit la version du package');
	assert.equal(lock.packages['']?.version, pkg.version);
});

t('chaque script de package.json pointe sur un fichier qui existe', () => {
	// Un renommage qui oublie un maillon de `selftest:operator` ne se voit qu'en
	// CI, plusieurs minutes plus tard, en MODULE_NOT_FOUND au milieu du log —
	// c'est arrivé à `ritual-selftest.mjs`, devenu `intro-primitives-*`. Ce test
	// ouvre la chaîne : il les nomme tous d'un coup, en une seconde.
	const pkg = JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'package.json'), 'utf8'));
	const missing = [];
	for (const [name, body] of Object.entries(pkg.scripts)) {
		for (const ref of body.match(/(?<![\w/.-])(?:tools|src|server)\/[\w./-]+\.mjs/g) || []) {
			if (!fs.existsSync(path.join(SIM_ROOT, ref))) missing.push(`${name} -> ${ref}`);
		}
	}
	assert.deepEqual(missing, [], `scripts pointant dans le vide :\n${missing.join('\n')}`);
});

t('release.mjs ne pousse rien tout seul', () => {
	// La règle : pousser le tag déclenche la GitHub Release. Ça se décide à la main.
	const src = fs.readFileSync(path.join(SIM_ROOT, 'tools/release.mjs'), 'utf8');
	assert.doesNotMatch(src, /git\('push'/, 'aucun push automatique');
	assert.match(src, /git\('tag', '-a'/, 'le tag est annoté');
});

console.log(`\n${n} tests release OK`);
