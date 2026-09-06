#!/usr/bin/env node
// Coupe une version (issue #257).
//
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--date=YYYY-MM-DD]
//
// Effets, dans cet ordre : bump de sim/package.json (+ le lockfile), datation de
// la section « Non publié » du CHANGELOG, commit `chore(release): vX.Y.Z`, tag
// annoté. Le push reste manuel — pousser le tag déclenche .github/workflows/release.yml,
// donc on ne le fait jamais dans le dos de qui lance la commande.
//
// Toute la logique de décision est dans release-model.mjs ; ici, les effets de bord.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, releaseChangelog, tagOf } from './release-model.mjs';

const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SIM, '..');
const PKG = path.join(SIM, 'package.json');
const LOCK = path.join(SIM, 'package-lock.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function git(...args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function die(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

// Le champ version est réécrit à la ligne près : le reste du package.json garde
// sa mise en forme, et un `npm install` ne vient pas tout remuer après coup.
function writePackageVersion(file, version) {
	const raw = fs.readFileSync(file, 'utf8');
	if (!/^\s*"version":\s*"[^"]*"/m.test(raw)) {
		die(`${path.relative(ROOT, file)} n'a pas de champ "version"`);
	}
	fs.writeFileSync(file, raw.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`));
}

function writeLockVersion(file, version) {
	if (!fs.existsSync(file)) return false;
	const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!('version' in lock) && !lock.packages?.['']) return false;
	lock.version = version;
	if (lock.packages?.['']) lock.packages[''].version = version;
	fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
	return true;
}

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith('-'));
const dryRun = args.includes('--dry-run');
const dateArg = args.find((a) => a.startsWith('--date='))?.slice('--date='.length);

if (!kind) die('usage : npm run release -- patch|minor|major|X.Y.Z [--dry-run]');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (!pkg.version) die('sim/package.json n\'a pas de champ "version"');

let next;
try {
	next = bumpVersion(pkg.version, kind);
} catch (err) {
	die(err.message);
}
const tag = tagOf(next);

const dirty = git('status', '--porcelain');
if (dirty && !dryRun) die(`l'arbre de travail n'est pas propre :\n${dirty}`);

const tagged = execFileSync('git', ['tag', '--list', tag], { cwd: ROOT, encoding: 'utf8' }).trim();
if (tagged) die(`le tag ${tag} existe déjà`);

let changelog;
try {
	changelog = releaseChangelog(fs.readFileSync(CHANGELOG, 'utf8'), next, dateArg || today());
} catch (err) {
	die(err.message);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`release: ${pkg.version} → ${next} (tag ${tag}, branche ${branch})`);

if (dryRun) {
	console.log('release: --dry-run, rien n\'a été écrit.');
	process.exit(0);
}

fs.writeFileSync(CHANGELOG, changelog);
writePackageVersion(PKG, next);
const lockUpdated = writeLockVersion(LOCK, next);

const staged = ['CHANGELOG.md', 'sim/package.json'];
if (lockUpdated) staged.push('sim/package-lock.json');
git('add', '--', ...staged);
git('commit', '-m', `chore(release): ${tag}`);
git('tag', '-a', tag, '-m', tag);

console.log(`release: commit et tag ${tag} créés. Pour publier :`);
console.log(`  git push -u origin ${branch}`);
console.log(`  git push origin ${tag}`);
console.log('release: le push du tag déclenche la GitHub Release.');
