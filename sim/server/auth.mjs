// Authentification par clé d'opérateur — le mode `shared` (VPS), issue #60.
//
// DEUX mécanismes vivent ici, et ils ne se touchent pas :
//
//   1. la clé d'opérateur — QUI parle au serveur. Secret de 128 bits rendu une
//      seule fois à la création, stocké haché, envoyé en `Authorization:
//      Bearer`. En mode `local` elle n'est jamais regardée : la frontière de
//      sécurité y reste le socket local, la même qu'avec le serveur de dev.
//   2. FPVTP_ACQUIRE — QUI a le droit de faire naître une scène sur disque.
//      Indépendant du premier, et fermé par défaut.
//
// Les confondre serait l'erreur de conception que la spec nomme explicitement
// (docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md, D2).
//
// Aucune dépendance : node:crypto et node:fs.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Base32 de Crockford : ni I, ni L, ni O, ni U. Une clé se relit à voix haute
// et se retape sans confondre 0/O ni 1/I/L — c'est la seule voie de
// récupération d'un opérateur, elle passera par un carnet.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 16;
const GROUP = 4;

export function generateKey() {
	const bits = [...randomBytes(KEY_BYTES)].map((b) => b.toString(2).padStart(8, '0')).join('');
	let out = '';
	// 128 bits ne se divisent pas par 5 : le dernier symbole porte 3 bits de
	// bourrage. On ne tronque pas — les 128 bits sont tous là.
	for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
	return out.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-');
}

// Tolérante à la frappe : casse, tirets, espaces, et les confusions que
// l'alphabet a justement retirées (O→0, I/L→1).
export function normalizeKey(raw) {
	return String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function hashKey(raw) {
	return createHash('sha256').update(normalizeKey(raw)).digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function bearerOf(req) {
	const h = req?.headers?.authorization ?? '';
	const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
	return m ? m[1].trim() : null;
}

// --- l'index des clés -------------------------------------------------------
//
// `/__map-api/*` n'a pas d'id d'opérateur dans son chemin : la clé est ce qui
// dit qui parle, il faut donc pouvoir remonter d'une empreinte à un opérateur.
// Relire les 142 fichiers de l'utilisateur (~170 Ko pièce) à chaque requête
// coûterait des dizaines de mégaoctets d'E/S ; on garde l'index en mémoire et
// on le refait quand le répertoire bouge. La mtime du RÉPERTOIRE suffit comme
// signal parce que _writeOperator() (api.mjs) et issueKey() ci-dessous écrivent
// tous deux par rename() — ce qui touche l'entrée de répertoire, y compris pour
// un fichier qui existait déjà.
let index = null;
let indexStamp = null;
let indexDir = null;

export function invalidateKeyIndex() { index = null; }

// Le hash est un champ de PREMIER niveau écrit par JSON.stringify(…, '\t') : une
// ligne à une seule tabulation. On le lit dans le texte brut plutôt que de
// parser des mégaoctets de sessions — et l'ancrage sur l'indentation met hors
// d'atteinte une chaîne homonyme qu'un opérateur aurait tapée dans une note (un
// guillemet y serait échappé, et l'indentation y est plus profonde). Le repli
// par JSON.parse ne coûte que sur un fichier qui contient VRAIMENT le mot :
// aucun fichier d'avant #60 n'en a.
const KEY_HASH_LINE = /^\t"keyHash": "([0-9a-f]{64})",?$/m;

function keyHashOf(text) {
	const m = KEY_HASH_LINE.exec(text);
	if (m) return m[1];
	if (!text.includes('keyHash')) return null;
	try {
		const h = JSON.parse(text).keyHash;
		return HASH_RE.test(String(h ?? '')) ? h : null;
	} catch { return null; }
}

function buildIndex(dir) {
	const map = new Map();
	let names = [];
	try { names = fs.readdirSync(dir); } catch { return map; }
	for (const f of names) {
		if (!f.endsWith('.json')) continue;
		let text;
		try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
		const h = keyHashOf(text);
		if (h) map.set(h, f.slice(0, -5));
	}
	return map;
}

function keyIndex(dir) {
	let stamp = null;
	try { stamp = fs.statSync(dir).mtimeMs; } catch { stamp = null; }
	if (!index || indexDir !== dir || indexStamp !== stamp) {
		index = buildIndex(dir);
		indexStamp = stamp;
		indexDir = dir;
	}
	return index;
}

export function operatorIdForKey(dir, key) {
	if (!key) return null;
	return keyIndex(dir).get(hashKey(key)) ?? null;
}

// --- la garde ---------------------------------------------------------------
//
// Rend `null` quand la requête passe, sinon { status, error }. `id` est
// l'opérateur que le chemin nomme (/__operator/:id/*) ; pour /__map-api/*, qui
// n'en nomme aucun, c'est la clé seule qui identifie. Un fichier d'avant #60 n'a
// pas de clé : aucune clé ne mène à lui, donc 403 — jusqu'à la commande `key`.
export function checkKey({ mode, dir, req, id = null }) {
	if (mode !== 'shared') return null;
	const key = bearerOf(req);
	if (!key) return { status: 401, error: 'operator key required' };
	const owner = operatorIdForKey(dir, key);
	if (!owner || (id && owner !== id)) return { status: 403, error: 'bad operator key' };
	return null;
}

// --- FPVTP_ACQUIRE ----------------------------------------------------------
//
// Le fournisseur de terrain (kh.google.com) est un point d'accès interne non
// documenté, sans clé, sans compte, sans conditions acceptées d'aucune sorte :
// l'acquisition reste dans le dépôt, intacte, mais n'est active dans AUCUNE
// build distribuée. Interrupteur par défaut FERMÉ, et fermé en `shared` quoi
// qu'il arrive — deux gardes indépendantes, parce qu'une scène ne doit jamais
// naître sur un serveur qui reçoit des inconnus.
//
// Convention : FPVTP_ACQUIRE=1 ou FPVTP_ACQUIRE=true (insensible à la casse).
// Tout le reste, absence comprise, ferme.
const TRUTHY = new Set(['1', 'true']);

export function acquireEnabled(mode) {
	if (mode === 'shared') return false;
	return TRUTHY.has(String(process.env.FPVTP_ACQUIRE ?? '').trim().toLowerCase());
}

// --- la commande `key` ------------------------------------------------------
//
// Seule voie de récupération : pas de mot de passe, pas de compte email, une
// clé perdue est un opérateur perdu. Aussi la migration des fichiers d'avant
// #60, qui n'ont pas de clé : ils restent parfaitement utilisables en `local`
// et le redeviennent en `shared` dès qu'on leur en donne une.
export function issueKey(dir, id) {
	const file = path.join(dir, `${id}.json`);
	if (!fs.existsSync(file)) throw new Error(`aucun opérateur "${id}" dans ${dir}`);
	const state = JSON.parse(fs.readFileSync(file, 'utf8'));
	const key = generateKey();
	state.keyHash = hashKey(key);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	invalidateKeyIndex();
	return key;
}

// Le hash ne sort jamais du serveur : la clé est un secret du client, le
// serveur n'en garde que de quoi la reconnaître.
export function publicOperator(state) {
	if (!state || typeof state !== 'object') return state;
	const { keyHash: _drop, ...rest } = state;
	return rest;
}
