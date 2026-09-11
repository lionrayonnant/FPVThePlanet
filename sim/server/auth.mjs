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
// (docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md, D2).
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
	if (!key) return { status: 401, error: 'clé d\'opérateur requise' };
	const owner = operatorIdForKey(dir, key);
	if (!owner || (id && owner !== id)) return { status: 403, error: 'clé d\'opérateur invalide' };
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

// --- l'inscription en libre service, et ses deux plafonds -------------------
//
// Sur le VPS, le cas nominal est un inconnu qui arrive sur le domaine et repart
// avec un profil, sans que le propriétaire du serveur ne fasse rien. C'est
// voulu — et c'est ce qui rend ces deux plafonds nécessaires. Les deux ne
// s'appliquent QU'EN `shared` : en `local` il n'y a qu'une personne, derrière un
// socket local, et rien ne change.

// L'adresse du demandeur. En `shared` le serveur est derrière Caddy et n'écoute
// que sur 127.0.0.1 : `remoteAddress` y vaut toujours la boucle locale, et
// `x-forwarded-for` est la seule source utilisable — posé par un proxy de
// confiance. En `local` cet en-tête serait falsifiable par le client : on ne le
// lit pas du tout.
export function clientIp(req, mode) {
	if (mode === 'shared') {
		const xff = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
		if (xff) return xff;
	}
	return req?.socket?.remoteAddress ?? 'inconnu';
}

// Cinq inscriptions par heure et par adresse. Une vraie personne s'inscrit une
// fois ; cinq laisse la place à un NAT partagé, à une famille et à un bootstrap
// repris après une erreur de nom, tout en ramenant une inondation scriptée à
// quelque chose que le plafond d'octets par opérateur (plus bas) borne à son
// tour. En mémoire, sans dépendance ni état sur disque : le serveur est
// mono-processus — `jobs`/`current` dans api.mjs font déjà cette hypothèse — et
// un redémarrage qui remet le compteur à zéro n'est pas un trou, juste un
// redémarrage.
export const SIGNUP_MAX = 5;
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const signups = new Map();

export function _resetSignups() { signups.clear(); }

export function checkSignup({ mode, req, now = Date.now() }) {
	if (mode !== 'shared') return null;
	const ip = clientIp(req, mode);
	const seen = (signups.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
	if (seen.length >= SIGNUP_MAX) {
		signups.set(ip, seen);
		const minutes = Math.max(1, Math.ceil((SIGNUP_WINDOW_MS - (now - seen[0])) / 60000));
		return { status: 429, error: `trop d'inscriptions depuis cette adresse — réessayez dans ${minutes} min` };
	}
	seen.push(now);
	signups.set(ip, seen);
	// Les adresses qui n'ont plus rien dans la fenêtre ne restent pas en mémoire.
	if (signups.size > 10000) {
		for (const [k, v] of signups) if (!v.some((t) => now - t < SIGNUP_WINDOW_MS)) signups.delete(k);
	}
	return null;
}

// Le plafond d'octets par opérateur, MESURÉ sur les fichiers réels de
// l'utilisateur le 2026-09-07 :
//
//   303 sessions, 14 captures → 7 638 405 o, dont 6 897 334 o de captures
//    15 sessions,  0 capture  →    43 651 o
//
// Soit ~2,4 Ko par session et ~493 Ko par capture : c'est la capture qui pèse,
// tout le reste est du bruit. 16 Mo laisse un facteur 2 au-dessus du plus gros
// profil réel (7,6 Mo) — de l'ordre de 30 captures de plus, ou des milliers de
// sessions sans capture — et borne ce qu'un inconnu peut écrire sur le disque du
// VPS. Le VOL n'est jamais bloqué par ce plafond : seul l'ajout de captures
// l'est, parce que c'est la seule écriture dont la taille dépende du client.
export const OPERATOR_BYTES_MAX = 16 * 1024 * 1024;

// Flight tracks (issue #24, D5) live BESIDE the operator file, in
// <dir>/tracks/<id>/, so that growing them does not make every operator write
// quadratic. They still count against the same ceiling: 200 tracks × ~15 kB is
// ~3 MB a client can write, and a quota that ignored them would be a lie.
function tracksBytes(dir, id) {
	let total = 0;
	const d = path.join(dir, 'tracks', id);
	let names;
	try { names = fs.readdirSync(d); } catch { return 0; }
	for (const f of names) {
		try { total += fs.statSync(path.join(d, f)).size; } catch { /* raced a prune */ }
	}
	return total;
}

// Rend `null` si l'opérateur a encore de la place, sinon { status, error }.
export function checkOperatorQuota({ mode, dir, id }) {
	if (mode !== 'shared') return null;
	let size = 0;
	try { size = fs.statSync(path.join(dir, `${id}.json`)).size; } catch { return null; }
	size += tracksBytes(dir, id);
	if (size < OPERATOR_BYTES_MAX) return null;
	return {
		status: 413,
		error: `quota atteint pour cet opérateur (${Math.round(size / 1e6)} Mo) — supprimez des sessions pour libérer de la place`,
	};
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
