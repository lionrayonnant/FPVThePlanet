# Rocktree en direct : fetch + décodage dans le navigateur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch et décoder un nœud rocktree unique (`fetchNode()`) dans le navigateur, en direct, sans passer par le pipeline de préparation (`tools/prep.mjs`).

**Architecture:** Les parsers protobuf/binaires bas niveau de `tools/lib/rocktree/` perdent leur dépendance à `Buffer` Node (six appels, trois fichiers) pour devenir utilisables tels quels dans un Worker navigateur. `nodeUrl()` est extraite dans son propre module pur. Un nouveau Worker (`src/rocktree-worker.js`, miroir de `src/worker.js`) fait le `fetch()` réel et décode le JPEG du nœud via `createImageBitmap()`. Un nouveau loader (`src/rocktree-loader.js`, miroir de `loadChunks()`) orchestre ce Worker et expose `fetchNode()`.

**Tech Stack:** JavaScript (ES modules), Web Workers, `fetch()`, `DataView`/`TextDecoder`, Three.js (consommateur en aval, hors périmètre ici), Node (`node:assert/strict` pour les selftests).

**Spec:** `docs/superpowers/specs/2026-08-31-rocktree-live-fetch-design.md`

## Global Constraints

- Aucune régression sur le chemin Node existant : `node tools/rocktree-selftest.mjs` et `node tools/provider-selftest.mjs` doivent rester verts après CHAQUE tâche qui touche `tools/lib/rocktree/` ou `tools/lib/providers/google-earth.mjs`.
- `sharp` (Node-only) ne doit apparaître dans AUCUN fichier touché par ce plan en dehors de `tools/lib/decoders/rocktree.mjs` (le chemin de préparation, inchangé) — la réparation de texels noirs (#158) reste hors périmètre.
- Pas de dépendance npm ajoutée. `DataView`/`TextDecoder`/`Uint8Array` sont natifs, Node comme navigateur.
- Un `AbortSignal` ne traverse jamais `postMessage()` — voir Tâche 6.
- Style du dépôt : commentaires en français expliquant le POURQUOI, jamais le QUOI ; noms de variables/fonctions en anglais comme le reste du code déjà en place dans ces fichiers (ex. `nodeUrl`, `fetchNode`) sauf commentaires.

---

## Task 1 : extraire `nodeUrl()`/`PREFIX` dans `tools/lib/rocktree/url.mjs`

**Files:**
- Create: `tools/lib/rocktree/url.mjs`
- Modify: `tools/lib/providers/google-earth.mjs:9-13` (imports), `tools/lib/providers/google-earth.mjs:27` (suppression de `PREFIX`), `tools/lib/providers/google-earth.mjs:165-172` (suppression de `nodeUrl`)
- Test: `tools/rocktree-selftest.mjs` (ajout d'un bloc de tests, fin de fichier avant `console.log`)

**Interfaces:**
- Produces: `PREFIX` (string), `nodeUrl({ path, epoch, imageryEpoch, flags }) -> string` — utilisées par la Tâche 6 (`src/rocktree-worker.js`) et par `google-earth.mjs` existant.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter dans `tools/rocktree-selftest.mjs`, juste avant la ligne `console.log(\`rocktree-selftest : ${n} tests ok\`);` (donc avant le `})();` final) :

```js
await t('url : NodeData sans imageryEpoch (flag 16 absent)', () => {
	const u = nodeUrl({ path: '306', epoch: 1014, imageryEpoch: null, flags: 0 });
	assert.equal(u, 'https://kh.google.com/rt/earth/NodeData/pb=!1m2!1s306!2u1014!2e1!4b0');
});

await t('url : NodeData avec imageryEpoch (flag 16 posé et epoch connu)', () => {
	const u = nodeUrl({ path: '306', epoch: 1014, imageryEpoch: 42, flags: 16 });
	assert.equal(u, 'https://kh.google.com/rt/earth/NodeData/pb=!1m2!1s306!2u1014!2e1!3u42!4b0');
});

await t('url : flag 16 posé mais imageryEpoch null -> pas de !3unull (404 garanti sinon)', () => {
	const u = nodeUrl({ path: '306', epoch: 1014, imageryEpoch: null, flags: 16 });
	assert.equal(u, 'https://kh.google.com/rt/earth/NodeData/pb=!1m2!1s306!2u1014!2e1!4b0');
});
```

Et ajouter l'import correspondant en haut du fichier, à côté des autres imports de `./lib/rocktree/` :

```js
import { PREFIX, nodeUrl } from './lib/rocktree/url.mjs';
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-selftest.mjs`
Expected: FAIL — `Cannot find module './lib/rocktree/url.mjs'` (le fichier n'existe pas encore).

- [ ] **Step 3: Créer `tools/lib/rocktree/url.mjs`**

```js
// URL du protocole rocktree (issue #18). Extrait de
// tools/lib/providers/google-earth.mjs (#168) : nodeUrl() ne dépend de rien
// de Node, contrairement au reste de ce fichier-là (fileURLToPath pour le
// cache de préparation) — la garder à côté de lui aurait entraîné cet import
// Node dans tout code qui voudrait construire une URL NodeData depuis un
// navigateur (src/rocktree-worker.js, #168).
export const PREFIX = 'https://kh.google.com/rt/earth/';

// imageryEpoch peut rester null même avec le flag posé (ni meta.imageryEpoch
// ni bulk.defaultImageryEpoch renseignés dans certaines captures, cf.
// traverse() dans google-earth.mjs) : sans cette garde on émettait `!3unull`,
// un 404 garanti compté comme nœud manquant.
export function nodeUrl({ path, epoch, imageryEpoch, flags }) {
	let u = `${PREFIX}NodeData/pb=!1m2!1s${path}!2u${epoch}!2e1`;
	if ((flags & 16) && imageryEpoch != null) u += `!3u${imageryEpoch}`;
	return u + '!4b0';
}
```

- [ ] **Step 4: Faire pointer `google-earth.mjs` vers le nouveau module**

Dans `tools/lib/providers/google-earth.mjs`, remplacer le bloc d'imports (lignes 9-13) :

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from '../rocktree/proto.mjs';
import { descendBox, boxIntersects } from '../rocktree/octant.mjs';
import { polyHash, polygonBounds } from '../tiles.mjs';
```

par :

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from '../rocktree/proto.mjs';
import { descendBox, boxIntersects } from '../rocktree/octant.mjs';
import { polyHash, polygonBounds } from '../tiles.mjs';
import { PREFIX, nodeUrl } from '../rocktree/url.mjs';
```

Puis supprimer la ligne (ancienne ligne 27) :

```js
const PREFIX = 'https://kh.google.com/rt/earth/';
```

Puis supprimer le bloc complet (ancien lignes 165-172) :

```js
function nodeUrl({ path: p, epoch, imageryEpoch, flags }) {
	let u = `${PREFIX}NodeData/pb=!1m2!1s${p}!2u${epoch}!2e1`;
	// imageryEpoch peut rester null même avec le flag posé (ni meta.imageryEpoch
	// ni bulk.defaultImageryEpoch renseignés dans la capture, cf. traverse()) :
	// sans cette garde on émettait `!3unull`, un 404 garanti compté comme nœud
	// manquant.
	if ((flags & 16) && imageryEpoch != null) u += `!3u${imageryEpoch}`;
	return u + '!4b0';
}
```

(`nodeUrl` reste appelée exactement pareil ailleurs dans le fichier, ex. `nodeUrl(n)` — l'import la rend disponible sous le même nom.)

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS, y compris les 3 nouveaux tests `url : ...`.

Run: `node tools/provider-selftest.mjs`
Expected: PASS (aucune régression sur le fournisseur Google Earth complet).

- [ ] **Step 6: Commit**

```bash
git add tools/lib/rocktree/url.mjs tools/lib/providers/google-earth.mjs tools/rocktree-selftest.mjs
git commit -m "refactor(rocktree): extrait nodeUrl()/PREFIX dans url.mjs, pur (#168)"
```

---

## Task 2 : porter `pb.mjs` sans `Buffer`

**Files:**
- Modify: `tools/lib/rocktree/pb.mjs:26,28` (fonction `readFields`)
- Test: `tools/rocktree-selftest.mjs`

**Interfaces:**
- Consumes: rien de nouveau — `readFields(buf)` continue d'accepter tout ce qui a `.length`, `.buffer`, `.byteOffset`, `.byteLength` et l'indexation `buf[i]` (Buffer ET Uint8Array les ont tous).
- Produces: `readFields(buf) -> Array<{num, wire, value}>` — signature inchangée, comportement identique sur une entrée `Uint8Array` OU `Buffer`.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter dans `tools/rocktree-selftest.mjs`, dans le même bloc de fin de fichier :

```js
await t('pb : readFields marche sur un Uint8Array pur, pas seulement un Buffer', () => {
	// field 1 (num=1, wire=1, 64-bit) : clé = 1*8+1 = 9, puis 8 octets little-endian de 1.5
	const bytes = new Uint8Array([9, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
	const f = readFields(bytes);
	assert.equal(f.length, 1);
	assert.equal(f[0].num, 1);
	assert.equal(f[0].wire, 1);
	const dv = new DataView(f[0].value.buffer, f[0].value.byteOffset, 8);
	assert.equal(dv.getFloat64(0, true), 1.5);
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-selftest.mjs`
Expected: FAIL — `bytes.readDoubleLE is not a function` (`Uint8Array` n'a pas cette méthode, contrairement à `Buffer`).

- [ ] **Step 3: Réécrire `readFields` sans `Buffer`**

Dans `tools/lib/rocktree/pb.mjs`, remplacer :

```js
export function readFields(buf) {
	const out = [];
	const pos = { i: 0 };
	while (pos.i < buf.length) {
		const key = readVarint(buf, pos);
		const num = Math.floor(key / 8), wire = key & 7;
		let value;
		if (wire === 0) value = readVarint(buf, pos);
		else if (wire === 1) { value = buf.readDoubleLE(pos.i); pos.i += 8; }
		else if (wire === 2) { const len = readVarint(buf, pos); value = buf.subarray(pos.i, pos.i + len); pos.i += len; }
		else if (wire === 5) { value = buf.readFloatLE(pos.i); pos.i += 4; }
		else throw new Error(`wire type ${wire} inattendu (champ ${num})`);
		out.push({ num, wire, value });
	}
	return out;
}
```

par :

```js
export function readFields(buf) {
	const out = [];
	const pos = { i: 0 };
	// Une seule DataView pour tout le buffer plutôt qu'une par champ lu :
	// readFields tourne sur des milliers de champs par nœud, une DataView par
	// appel serait une allocation par champ pour rien.
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	while (pos.i < buf.length) {
		const key = readVarint(buf, pos);
		const num = Math.floor(key / 8), wire = key & 7;
		let value;
		if (wire === 0) value = readVarint(buf, pos);
		else if (wire === 1) { value = dv.getFloat64(pos.i, true); pos.i += 8; }
		else if (wire === 2) { const len = readVarint(buf, pos); value = buf.subarray(pos.i, pos.i + len); pos.i += len; }
		else if (wire === 5) { value = dv.getFloat32(pos.i, true); pos.i += 4; }
		else throw new Error(`wire type ${wire} inattendu (champ ${num})`);
		out.push({ num, wire, value });
	}
	return out;
}
```

(`buf.subarray(...)` reste inchangé : `Uint8Array.prototype.subarray` est déjà portable.)

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS, y compris le nouveau test et les tests `pb :` existants (qui passent des `Buffer.from([...])` — un `Buffer` reste un `Uint8Array` valide en entrée, donc `dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)` fonctionne identiquement).

- [ ] **Step 5: Commit**

```bash
git add tools/lib/rocktree/pb.mjs tools/rocktree-selftest.mjs
git commit -m "refactor(rocktree): pb.mjs sans Buffer, DataView pour les champs 64/32 bits (#168)"
```

---

## Task 3 : porter `proto.mjs` sans `Buffer`

**Files:**
- Modify: `tools/lib/rocktree/proto.mjs:43-44` (`parseBulk`), `tools/lib/rocktree/proto.mjs:85` (`parseCopyrights`)
- Test: `tools/rocktree-selftest.mjs`

**Interfaces:**
- Consumes: `doubles`/`floats` de `pb.mjs` (déjà portables, inchangées).
- Produces: `parseBulk(buf)`, `parseCopyrights(buf)` — signatures et formes de sortie inchangées.

- [ ] **Step 1: Écrire le test qui échoue**

Le test existant `'copyrights : des centaines d'entrées, du texte utf-8 exploitable'` (déjà dans le fichier) passe déjà en Node — `.toString('utf8')` marche sur un `Buffer`. Le risque n'est visible qu'avec une entrée `Uint8Array` pure. Ajouter :

```js
await t('copyrights : parseCopyrights marche sur un Uint8Array pur (pas seulement Buffer)', () => {
	// field 1 (message Copyright), lui-même : field 1 = id (varint 5), field 2 = texte utf-8 "©" (2 octets: 0xC2 0xA9)
	// Copyright { id=5, text="©" } encodé à la main :
	//   sous-message field2=2 (texte) : clé=2*8+2=18, len=2, 0xC2 0xA9
	//   field1=1 (id) : clé=1*8+0=8, varint 5
	const copyrightMsg = new Uint8Array([8, 5, 18, 2, 0xc2, 0xa9]);
	// message racine : field 1 = ce sous-message, répété (wire 2)
	const key = 1 * 8 + 2;
	const outer = new Uint8Array([key, copyrightMsg.length, ...copyrightMsg]);
	const map = parseCopyrights(outer);
	assert.equal(map.get(5), '©');
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-selftest.mjs`
Expected: FAIL — `one(c, 2).toString is not a function` ou message équivalent (`Uint8Array.prototype.toString` existe mais ignore l'argument `'utf8'` et rend `"194,169"`, pas `"©"` — l'assertion `map.get(5) === '©'` échoue).

- [ ] **Step 3: Réécrire `parseBulk` et `parseCopyrights` sans `Buffer`**

Dans `tools/lib/rocktree/proto.mjs`, remplacer :

```js
	return {
		nodes,
		headNodeCenter: doubles(one(f, 3) ?? Buffer.alloc(0)),
		metersPerTexel: floats(one(f, 4) ?? Buffer.alloc(0)),
		defaultImageryEpoch: one(f, 5) ?? null,
	};
```

par :

```js
	return {
		nodes,
		headNodeCenter: doubles(one(f, 3) ?? new Uint8Array(0)),
		metersPerTexel: floats(one(f, 4) ?? new Uint8Array(0)),
		defaultImageryEpoch: one(f, 5) ?? null,
	};
```

Et remplacer :

```js
export function parseCopyrights(buf) {
	const map = new Map();
	for (const raw of all(readFields(buf), 1)) {
		const c = readFields(raw);
		map.set(one(c, 1), one(c, 2).toString('utf8'));
	}
	return map;
}
```

par :

```js
const utf8 = new TextDecoder('utf-8');

export function parseCopyrights(buf) {
	const map = new Map();
	for (const raw of all(readFields(buf), 1)) {
		const c = readFields(raw);
		map.set(one(c, 1), utf8.decode(one(c, 2)));
	}
	return map;
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS — y compris le nouveau test ET le test existant `'copyrights : des centaines d'entrées, du texte utf-8 exploitable'` (qui doit continuer de passer sur les vraies fixtures, décodées en `Buffer` par `fs.readFileSync`).

- [ ] **Step 5: Commit**

```bash
git add tools/lib/rocktree/proto.mjs tools/rocktree-selftest.mjs
git commit -m "refactor(rocktree): proto.mjs sans Buffer, TextDecoder pour les copyrights (#168)"
```

---

## Task 4 : porter `unpack.mjs` sans `Buffer`

**Files:**
- Modify: `tools/lib/rocktree/unpack.mjs:22` (`unpackTexCoords`)
- Test: `tools/rocktree-selftest.mjs`

**Interfaces:**
- Produces: `unpackTexCoords(buf, count) -> { uv, uMod, vMod }` — signature et sortie inchangées.

- [ ] **Step 1: Écrire le test qui échoue**

```js
await t('unpack : unpackTexCoords marche sur un Uint8Array pur (pas seulement Buffer)', () => {
	// en-tête : uMod-1=9 (uMod=10), vMod-1=19 (vMod=20), en uint16 LE
	const header = new Uint8Array([9, 0, 19, 0]);
	// 1 sommet, 4 plans d'un octet (lo(u), lo(v), hi(u), hi(v)) tous à 0
	const body = new Uint8Array([0, 0, 0, 0]);
	const buf = new Uint8Array([...header, ...body]);
	const { uv, uMod, vMod } = unpackTexCoords(buf, 1);
	assert.equal(uMod, 10);
	assert.equal(vMod, 20);
	assert.deepEqual([...uv], [0, 0]);
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-selftest.mjs`
Expected: FAIL — `buf.readUInt16LE is not a function`.

- [ ] **Step 3: Réécrire `unpackTexCoords` sans `Buffer`**

Dans `tools/lib/rocktree/unpack.mjs`, remplacer :

```js
export function unpackTexCoords(buf, count) {
	const uMod = 1 + buf.readUInt16LE(0), vMod = 1 + buf.readUInt16LE(2);
	const data = buf.subarray(4);
```

par :

```js
export function unpackTexCoords(buf, count) {
	const dv = new DataView(buf.buffer, buf.byteOffset, 4);
	const uMod = 1 + dv.getUint16(0, true), vMod = 1 + dv.getUint16(2, true);
	const data = buf.subarray(4);
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/lib/rocktree/unpack.mjs tools/rocktree-selftest.mjs
git commit -m "refactor(rocktree): unpack.mjs sans Buffer, DataView pour l'en-tête texcoords (#168)"
```

---

## Task 5 : porter `_net.http` de `google-earth.mjs` sans `Buffer`

**Cette tâche n'est PAS sur le chemin critique de `fetchNode()`.**
`src/rocktree-worker.js` (Tâche 6) fait son propre `fetch()` et ne passe
JAMAIS par `google-earth.mjs::_net.http` — il ne peut d'ailleurs pas
l'importer : ce fichier tire `node:url` (`fileURLToPath`, pour le cache de
préparation), qui n'existe pas dans un Worker navigateur. `fetchNode()`
marche sans cette tâche. Elle reste utile pour une seule raison : garder tout
`tools/lib/rocktree/` et son fournisseur Google Earth cohérents (zéro
`Buffer` dans le chemin de décodage), pas pour débloquer le navigateur.
Faisable avant ou après la Tâche 6/7 sans différence — placée ici par ordre
de proximité avec les Tâches 2-4.

**Files:**
- Modify: `tools/lib/providers/google-earth.mjs:5-13,34` (commentaire d'en-tête + `_net.http`)

**Interfaces:**
- Produces: `_net.http(url, { signal }) -> Promise<Uint8Array>` (au lieu de `Promise<Buffer>`). Tous les appelants (`parsePlanetoid`, `parseBulk`, `parseNode` côté prep, `parseCopyrights`, `fs.writeFileSync`) acceptent déjà un `Uint8Array` — vérifié Tâches 2-4 pour les parsers, `fs.writeFileSync` accepte nativement tout `ArrayBufferView`.

- [ ] **Step 1: Écrire un test qui échoue vraiment**

Un `Buffer` Node EST un `Uint8Array` : rien côté Node ne distingue les deux à l'usage, donc aucun test Node ne peut faire échouer `Buffer.from(...)` puis passer après l'avoir remplacé par `new Uint8Array(...)` — les deux se comportent identiquement ici. Le seul test honnête est structurel : que le code source ne contienne plus `Buffer` du tout dans ce fichier, pour de vrai, pas une assertion sur un objet fabriqué à part. Ajouter dans `tools/rocktree-selftest.mjs` :

```js
await t('google-earth.mjs : plus aucune référence à Buffer dans le source (portabilité navigateur, #168)', () => {
	const src = fs.readFileSync(
		path.join(DIR, '..', '..', 'lib/providers/google-earth.mjs'),
		'utf8',
	);
	// Buffer\. et non \bBuffer\b : le mot « Buffer » reste légitime en PROSE
	// (ce test-ci, le commentaire d'en-tête) — c'est un appel à l'API Node
	// (Buffer.from, Buffer.alloc, ...) qui casserait un Worker navigateur.
	assert.doesNotMatch(src, /Buffer\./,
		'google-earth.mjs appelle encore l\'API Buffer — src/rocktree-worker.js ne peut pas l\'importer tel quel');
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-selftest.mjs`
Expected: FAIL — `google-earth.mjs référence encore Buffer` (ligne 5 du commentaire d'en-tête ET ligne 34, `Buffer.from`).

- [ ] **Step 3: Réécrire `_net.http`**

Dans `tools/lib/providers/google-earth.mjs`, remplacer le commentaire d'en-tête :

```js
// Réseau injectable : `_net.http(url, { signal }) -> Promise<Buffer>` est le
// seul point de contact avec kh.google.com. Les tests le remplacent (mock des
// fixtures) plutôt que de passer par un framework d'injection — c'est le motif
// le plus simple qui permette de rejouer une capture hors-ligne.
```

par :

```js
// Réseau injectable : `_net.http(url, { signal }) -> Promise<Uint8Array>` est
// le seul point de contact avec kh.google.com. Les tests le remplacent (mock
// des fixtures) plutôt que de passer par un framework d'injection — c'est le
// motif le plus simple qui permette de rejouer une capture hors-ligne.
// Uint8Array et non Buffer (#168) : ce module doit rester importable par un
// Worker navigateur, qui n'a pas Buffer.
```

Puis remplacer :

```js
	async http(url, { signal } = {}) {
		const res = await globalThis.fetch(url, { signal });
		if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
		return Buffer.from(await res.arrayBuffer());
	},
```

par :

```js
	async http(url, { signal } = {}) {
		const res = await globalThis.fetch(url, { signal });
		if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
		return new Uint8Array(await res.arrayBuffer());
	},
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS.

Run: `node tools/provider-selftest.mjs`
Expected: PASS — c'est le test qui exerce réellement `fetch()`/`traverse()`/`plan()` avec `_net.http` mockée ; s'il reste vert, rien en aval ne dépendait de méthodes `Buffer`-spécifiques sur son retour.

Run: `node tools/decoder-selftest.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/lib/providers/google-earth.mjs tools/rocktree-selftest.mjs
git commit -m "refactor(rocktree): _net.http rend un Uint8Array, plus un Buffer (#168)"
```

---

## Task 6 : `src/rocktree-worker.js`

**Files:**
- Create: `src/rocktree-worker.js`

**Interfaces:**
- Consumes: `nodeUrl` de `tools/lib/rocktree/url.mjs`, `parseNode` de `tools/lib/rocktree/proto.mjs` (les deux déjà portables après Tâches 1-3).
- Produces: protocole de message Worker :
  - Entrée (`postMessage` vers le worker) : `{ path, epoch, imageryEpoch, flags }` — PAS de `signal` (voir Global Constraints).
  - Sortie succès : `{ ok: true, matrix, copyrightIds, meshes }` où chaque mesh de `meshes` porte en plus `bitmap` (un `ImageBitmap`, transférable) si `texture` était présent, sinon `bitmap: null`.
  - Sortie échec : `{ ok: false, error: string }`.

Ce module n'a pas de test Node (il utilise `self`, `fetch`, `createImageBitmap` — des API navigateur) : sa vérification est la Tâche 8, en direct dans le navigateur, comme le veut la spec.

- [ ] **Step 1: Écrire `src/rocktree-worker.js`**

```js
// Fetch + décodage d'UN nœud rocktree, en direct, pendant le vol (#168).
// Miroir de src/worker.js (qui décode les chunks pré-cuits) : même motif de
// message { ok, ... }, mais ici rien n'est pré-cuit — le fetch() part
// pendant que le drone vole.
//
// Pas de `sharp` : le JPEG brut extrait du protobuf va directement à
// createImageBitmap(), le décodeur JPEG natif du navigateur — le même chemin
// que worker.js emprunte déjà pour les planches JPEG des chunks pré-cuits. La
// réparation des texels noirs (#158, qui utilise sharp côté Node) reste une
// passe de qualité pour le bake ; elle n'est pas requise pour qu'un nœud
// s'affiche et n'est pas dans ce périmètre.
//
// Pas de `signal` dans le message reçu : un AbortSignal n'est pas clonable
// par postMessage(). L'annulation est le problème de rocktree-loader.js, sur
// le fil principal (worker.terminate()), pas de celui-ci.
import { nodeUrl } from '../tools/lib/rocktree/url.mjs';
import { parseNode } from '../tools/lib/rocktree/proto.mjs';

self.onmessage = async (e) => {
	const { path, epoch, imageryEpoch, flags } = e.data;
	try {
		const url = nodeUrl({ path, epoch, imageryEpoch, flags });
		const res = await fetch(url);
		if (!res.ok) { const err = new Error(`${res.status} ${url}`); err.status = res.status; throw err; }
		const buf = new Uint8Array(await res.arrayBuffer());
		const node = parseNode(buf);

		const bitmaps = [];
		const meshes = await Promise.all(node.meshes.map(async (m) => {
			if (!m.texture) return { ...m, bitmap: null };
			const bitmap = await createImageBitmap(new Blob([m.texture.data]));
			bitmaps.push(bitmap);
			return { ...m, bitmap };
		}));

		self.postMessage(
			{ ok: true, matrix: node.matrix, copyrightIds: node.copyrightIds, meshes },
			bitmaps,
		);
	} catch (err) {
		self.postMessage({ ok: false, error: String((err && err.message) || err) });
	}
};
```

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check src/rocktree-worker.js`
Expected: pas de sortie (syntaxe valide). `node --check` ne peut pas exécuter ce fichier (il utilise `self`/`fetch`/`createImageBitmap`, absents de Node) — il vérifie seulement que le JavaScript est bien formé. L'exécution réelle est la Tâche 8.

- [ ] **Step 3: Commit**

```bash
git add src/rocktree-worker.js
git commit -m "feat(rocktree): Worker de fetch + décodage d'un nœud en direct (#168)"
```

---

## Task 7 : `src/rocktree-loader.js`

**Files:**
- Create: `src/rocktree-loader.js`

**Interfaces:**
- Consumes: `src/rocktree-worker.js` (Tâche 6), via `new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' })` — même motif que `loadChunks()` dans `loader.js:85`.
- Produces:

```js
fetchNode({ path, epoch, imageryEpoch, flags }, { signal } = {}) -> Promise<{ matrix, copyrightIds, meshes }>
```

Rejette si `signal` est déjà déclenché à l'appel, ou se déclenche avant la réponse du worker, ou si le worker répond `{ ok: false }`.

- [ ] **Step 1: Écrire `src/rocktree-loader.js`**

```js
// Orchestre src/rocktree-worker.js (#168) : miroir de loadChunks() dans
// loader.js, mais pour UN nœud rocktree fetché en direct plutôt qu'un lot de
// chunks pré-cuits. Ce module ne sait RIEN de la position du drone ni d'une
// fenêtre de streaming — c'est le problème de la tranche suivante, qui
// appellera fetchNode() en boucle.
export function fetchNode({ path, epoch, imageryEpoch, flags }, { signal } = {}) {
	if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));

	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' });

		// L'AbortSignal ne traverse pas postMessage() (non clonable) : le worker
		// ne le reçoit jamais, l'annulation reste ici, sur le fil principal —
		// même motif que dropPreloadsExcept() dans main.js pour les chunks
		// pré-cuits (worker.terminate()).
		const onAbort = () => {
			worker.terminate();
			reject(new DOMException('aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort);

		const cleanup = () => {
			signal?.removeEventListener('abort', onAbort);
			worker.terminate();
		};

		worker.onerror = (e) => { cleanup(); reject(new Error(`fetchNode ${path}: ${e.message}`)); };
		worker.onmessage = (e) => {
			cleanup();
			const msg = e.data;
			if (!msg.ok) { reject(new Error(`fetchNode ${path}: ${msg.error}`)); return; }
			resolve({ matrix: msg.matrix, copyrightIds: msg.copyrightIds, meshes: msg.meshes });
		};
		worker.postMessage({ path, epoch, imageryEpoch, flags });
	});
}
```

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check src/rocktree-loader.js`
Expected: pas de sortie. Même remarque que Tâche 6 Step 2 : `Worker`/`DOMException` sont des API navigateur, ce check ne vérifie que la syntaxe.

- [ ] **Step 3: Commit**

```bash
git add src/rocktree-loader.js
git commit -m "feat(rocktree): fetchNode(), orchestre le Worker de fetch en direct (#168)"
```

---

## Task 8 : vérification en direct dans le navigateur

**Files:** aucun fichier modifié — vérification uniquement.

Le Worker + `fetch()` réel ne peuvent pas être vérifiés par un test Node (pas de `self`, pas de vrai réseau navigateur, pas de `createImageBitmap`). La spec le dit explicitement : « Pas de mock à ce niveau — c'est justement le réseau réel qui est la question. » Cette tâche rejoue, pour `fetchNode()` complet, le même genre de vérification live qu'a déjà subi le fetch nu pendant le brainstorm (CORS confirmé le 2026-08-31 contre `kh.google.com`).

- [ ] **Step 1: Démarrer un serveur de dev dédié à ce worktree**

Run (depuis `sim/`, dans CE worktree) :

```bash
ln -sf /home/user/Documents/dev/FPVMaps/sim/node_modules node_modules
ln -sf /home/user/Documents/dev/FPVMaps/sim/public/scenes public/scenes
npx vite --port 5175 &
```

Attendre que `curl -sI http://localhost:5175/` rende `HTTP/1.1 200 OK` avant de continuer.

- [ ] **Step 2: Écrire une page de test minimale**

Create: `public/rocktree-live-test.html`

```html
<!doctype html>
<script type="module">
	import { fetchNode } from '/src/rocktree-loader.js';
	// Chemin racine réel de la capture Paris (tools/testdata/rocktree/index.json,
	// epoch 1014) : un nœud qui a existé sur kh.google.com au moment de cette
	// capture. epoch peut avoir changé depuis — voir Step 4 si 404.
	window.testFetchNode = () => fetchNode({ path: '3060', epoch: 1014, imageryEpoch: null, flags: 0 });
</script>
```

- [ ] **Step 3: Appeler `fetchNode()` en vrai, depuis un navigateur, et lire le résultat**

Avec un outil de contrôle navigateur (ex. chrome-devtools MCP, `evaluate_script`, comme pendant le brainstorm) :

```js
async () => {
	const result = await window.testFetchNode();
	return {
		hasMatrix: Array.isArray([...result.matrix]) && result.matrix.length > 0,
		meshCount: result.meshes.length,
		firstMeshHasBitmap: result.meshes[0]?.bitmap instanceof ImageBitmap,
		firstMeshVertexBytes: result.meshes[0]?.vertices?.length ?? 0,
	};
}
```

Expected: pas d'exception ; `meshCount > 0` ; `firstMeshHasBitmap === true` si le nœud a une texture.

- [ ] **Step 4: Si 404 (epoch périmé), reconfirmer la chaîne avec un chemin et un epoch frais**

Un 404 ici ne veut PAS dire que `fetchNode()` est cassée — les epochs se
périment (déjà observé pendant le brainstorm : `PlanetoidMetadata` a changé
d'epoch entre deux sessions le même jour). Redemander un chemin et un epoch
réellement valides MAINTENANT, en repartant de la racine — remplacer le corps
de `window.testFetchNode` dans `public/rocktree-live-test.html` par :

```html
<!doctype html>
<script type="module">
	import { fetchNode } from '/src/rocktree-loader.js';
	import { parsePlanetoid, parseBulk } from '/tools/lib/rocktree/proto.mjs';
	import { PREFIX } from '/tools/lib/rocktree/url.mjs';

	window.testFetchNodeFresh = async () => {
		const root = await fetch(PREFIX + 'PlanetoidMetadata').then((r) => r.arrayBuffer());
		const { rootEpoch } = parsePlanetoid(new Uint8Array(root));

		const bulkBuf = await fetch(`${PREFIX}BulkMetadata/pb=!1m2!1s!2u${rootEpoch}`)
			.then((r) => r.arrayBuffer());
		const bulk = parseBulk(new Uint8Array(bulkBuf));

		// Le premier enfant du bulk racine : un chemin d'un digit, réellement
		// présent MAINTENANT (pas figé dans une fixture).
		const [relPath, meta] = [...bulk.nodes.entries()][0];
		return fetchNode({
			path: relPath,
			// meta.epoch absent -> epoch du bulk courant, ici rootEpoch (parseBulk
			// n'a pas de champ `epoch` top-level — voir proto.mjs). bulk.epoch
			// est undefined et aurait provoqué un 404 garanti.
			epoch: meta.epoch ?? rootEpoch,
			// Même repli que traverse.mjs:269 et google-earth.mjs : sans lui,
			// un flag imagerie posé mais sans imageryEpoch propre part avec
			// `undefined` dans l'URL.
			imageryEpoch: (meta.flags & 16) ? (meta.imageryEpoch ?? bulk.defaultImageryEpoch) : null,
			flags: meta.flags,
		});
	};
</script>
```

Rejouer la vérification de Step 3 en appelant `window.testFetchNodeFresh()`
au lieu de `window.testFetchNode()`. Cette fois un 404 EST un vrai échec — la
racine de l'octree ne se périme pas comme un chemin profond spécifique.

- [ ] **Step 5: Nettoyer**

```bash
rm public/rocktree-live-test.html
pkill -f "vite --port 5175"
```

- [ ] **Step 6: Consigner le résultat dans HANDOFF.md**

Ajouter une ligne dans `sim/HANDOFF.md` (section état vérifié) : `fetchNode()` (#168) vérifiée en direct le <date>, contre `kh.google.com`, chemin `<path>` epoch `<epoch>` — `<meshCount>` mesh(es), texture décodée sans `sharp`.

- [ ] **Step 7: Commit**

```bash
git add sim/HANDOFF.md
git commit -m "docs(rocktree): fetchNode() vérifiée en direct contre kh.google.com (#168)"
```
