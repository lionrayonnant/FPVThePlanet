# Fournisseur Google Earth (Stage 3, issue #18) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher Google Earth (protocole interne « rocktree ») comme second fournisseur de photogrammétrie, du téléchargement au vol vérifié dans le navigateur, avec attribution par tuile.

**Architecture:** Un client Node natif du protocole rocktree, partagé entre les deux seams existants : `tools/lib/rocktree/` (lecture protobuf, dépaquetage des maillages, maths d'octree), consommé par `tools/lib/providers/google-earth.mjs` (d'où viennent les octets) et `tools/lib/decoders/rocktree.mjs` (comment les lire). Le pipeline aval (prep.mjs : ENU, chunks, texture arrays, collision) ne change pas. Le HAR `docs/earth.google.com_Archive [26-08-31 07-54-55].har` fournit les fixtures hors-ligne.

**Tech Stack:** Node ≥ 20 pur (aucune dépendance nouvelle — le lecteur protobuf est écrit à la main, ~80 lignes pour 3 types wire). `sharp` déjà présent lit les JPEG en Buffer.

**Spec:** `docs/superpowers/specs/2026-08-29-second-fournisseur-3d-design.md` — lire en particulier l'**Amendement 2026-08-31** (le Stage 3 passe par le protocole Earth interne, pas la Map Tiles API).

## Global Constraints

- Tout se lance depuis `sim/` ; les selftests sont des scripts Node sans framework (`node tools/<x>-selftest.mjs`), motif `t('nom', fn)` + `assert/strict`.
- Aucune dépendance npm nouvelle. Aucun code copié d'`earth-reverse-engineering` (pas de licence) : c'est une documentation de protocole, on réécrit.
- Les fixtures committées viennent du HAR ou des deux réponses live déjà capturées ; **le HAR de 114 Mo ne rentre jamais dans git** (Task 1 le gitignore).
- Contrat décodeur (tools/lib/decoders/index.mjs) : lignes de log AU MOT PRÈS `"<N> materials, <N> without a texture"` (nombres nus) et `"<N> vertices, <N> uvs, <N> triangles"` (nombres via `toLocaleString()`) — `parsePrepLine()` en dépend pour l'UI PHASE 05.
- UV en convention moteur (origine haut-gauche) ; chaque décodeur décide seul de son inversion V. Erreurs levées, jamais `process.exit`. `onLog` reçoit des lignes non horodatées.
- Coordonnées décodées en ECEF mètres (Float64), prep.mjs fait le rebase ENU.
- Messages, commentaires et commits en français, dans le ton du dépôt (commentaires qui expliquent le pourquoi).
- Convention de nommage des endpoints (mesurée sur le HAR + 2 requêtes live, epoch racine 1014) :
  - `https://kh.google.com/rt/earth/PlanetoidMetadata`
  - `…/BulkMetadata/pb=!1m2!1s{octant}!2u{epoch}` (octant vide pour la racine)
  - `…/NodeData/pb=!1m2!1s{octant}!2u{epoch}!2e1[!3u{epochImagerie}]!4b0` (`!2e1` = textures JPEG)
  - `…/Copyrights/pb=!1u{epoch}`

---

### Task 1: Fixtures rocktree extraites du HAR

Rendre le développement du décodeur entièrement hors-ligne : figer dans `tools/testdata/rocktree/` un petit sous-ensemble du HAR + les deux réponses live.

**Files:**
- Create: `tools/gen-rocktree-fixture.mjs`
- Create: `tools/testdata/rocktree/` (généré puis committé : `planetoid.pb`, `copyrights.pb`, `bulk-*.pb`, `node-*.pb`, `index.json`)
- Modify: `.gitignore` (racine du dépôt) — ajouter `docs/*.har`
- Modify: `sim/.gitignore` — ajouter `.cache/`

**Interfaces:**
- Produces: `tools/testdata/rocktree/index.json` de forme
  `{ epoch: 1014, planetoid: 'planetoid.pb', copyrights: 'copyrights.pb', bulks: [{ path, epoch, file }], nodes: [{ path, epoch, imageryEpoch, url, file }] }`
  — toutes les tasks suivantes testent contre ces fichiers.

- [ ] **Step 1 : écrire le générateur**

`tools/gen-rocktree-fixture.mjs` (même esprit que `gen-poly-fixture.mjs` : procès-verbal committé, à ne pas régénérer pour faire taire un test) :

```js
// Fige un petit échantillon du protocole rocktree depuis une capture HAR de
// earth.google.com. Lancer :
//   node tools/gen-rocktree-fixture.mjs "<chemin du .har>"
// Le HAR (114 Mo) ne rentre pas dans git ; ces quelques .pb, si. La fixture
// n'est pas « la vérité » — c'est le procès-verbal d'octets réellement servis
// par kh.google.com le 2026-08-31 (epoch racine 1014).
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'testdata/rocktree');
const har = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const entries = har.log.entries.filter((e) => e.response.status === 200 && e.response.content?.text);

const byKind = (k) => entries.filter((e) => e.request.url.includes(`/rt/earth/${k}/`));
const save = (name, b64) => fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
const parseUrl = (url) => {
	const m = url.match(/!1s(\d*)!2u(\d+)(?:!2e\d+)?(?:!3u(\d+))?/);
	return { path: m[1], epoch: Number(m[2]), imageryEpoch: m[3] ? Number(m[3]) : null };
};

fs.mkdirSync(OUT, { recursive: true });

// La chaîne de BulkMetadata de la racine vers un octant profond : on prend le
// NodeData le plus PETIT (déterministe et léger) dont tous les bulks parents
// (chemins tronqués aux multiples de 4) sont dans la capture, plus deux autres
// nœuds du même quartier pour la variété (matrices différentes).
const bulks = new Map(byKind('BulkMetadata').map((e) => {
	const { path: p, epoch } = parseUrl(e.request.url);
	return [p, { path: p, epoch, b64: e.response.content.text }];
}));
const nodes = byKind('NodeData')
	.map((e) => ({ ...parseUrl(e.request.url), url: e.request.url, b64: e.response.content.text }))
	.filter((n) => {
		for (let i = 0; i <= n.path.length - (n.path.length % 4 || 4); i += 4) {
			if (!bulks.has(n.path.slice(0, i))) return false;
		}
		return true;
	})
	.sort((a, b) => a.b64.length - b.b64.length);
if (nodes.length < 3) throw new Error(`seulement ${nodes.length} NodeData avec chaîne de bulks complète`);
const picked = [nodes[0], nodes[Math.floor(nodes.length / 2)], nodes[nodes.length - 1]];

const index = { epoch: 1014, planetoid: 'planetoid.pb', copyrights: 'copyrights.pb', bulks: [], nodes: [] };
const wanted = new Set(picked.flatMap((n) => {
	const chain = [];
	for (let i = 0; i <= n.path.length - (n.path.length % 4 || 4); i += 4) chain.push(n.path.slice(0, i));
	return chain;
}));
for (const p of [...wanted].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
	const b = bulks.get(p);
	const file = `bulk-${p || 'root'}.pb`;
	save(file, b.b64);
	index.bulks.push({ path: p, epoch: b.epoch, file });
}
picked.forEach((n, i) => {
	const file = `node-${i}-${n.path}.pb`;
	save(file, n.b64);
	index.nodes.push({ path: n.path, epoch: n.epoch, imageryEpoch: n.imageryEpoch, url: n.url, file });
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, '\t') + '\n');
console.log(`${index.bulks.length} bulks, ${index.nodes.length} nodes ->`, OUT);
```

- [ ] **Step 2 : récupérer planetoid.pb et copyrights.pb (2 requêtes, déjà validées à la main)**

```bash
curl -s "https://kh.google.com/rt/earth/PlanetoidMetadata" -o tools/testdata/rocktree/planetoid.pb
curl -s "https://kh.google.com/rt/earth/Copyrights/pb=!1u1014" -o tools/testdata/rocktree/copyrights.pb
```

Attendu : `planetoid.pb` fait 13 octets ; `copyrights.pb` ~20 Ko.

- [ ] **Step 3 : lancer le générateur sur le HAR**

```bash
node tools/gen-rocktree-fixture.mjs "../docs/earth.google.com_Archive [26-08-31 07-54-55].har"
du -sh tools/testdata/rocktree
```

Attendu : la ligne `N bulks, 3 nodes`, un dossier < 1 Mo. Si > 2 Mo, reprendre le choix des nœuds (ils doivent rester les petits).

- [ ] **Step 4 : gitignorer le HAR et le futur cache**

Dans `.gitignore` racine, ajouter la ligne `docs/*.har`. Dans `sim/.gitignore`, ajouter `.cache/`. Vérifier :

```bash
git check-ignore -v "../docs/earth.google.com_Archive [26-08-31 07-54-55].har" && git status --short
```

Attendu : le HAR est ignoré ; `git status` montre les fixtures et les deux .gitignore, PAS le HAR.

- [ ] **Step 5 : commit**

```bash
git add ../.gitignore .gitignore tools/gen-rocktree-fixture.mjs tools/testdata/rocktree
git commit -m "Issue #18 : fixtures rocktree figées depuis le HAR earth.google.com (epoch 1014)"
```

---

### Task 2: Lecteur protobuf + parseurs de messages rocktree

**Files:**
- Create: `tools/lib/rocktree/pb.mjs`
- Create: `tools/lib/rocktree/proto.mjs`
- Create: `tools/rocktree-selftest.mjs` (démarré ici, enrichi par les tasks 3-4)

**Interfaces:**
- Produces (`pb.mjs`): `readFields(buf) -> [{ num, wire, value }]` où `value` est
  Number (varint ≤ 2^53), Buffer (len-delimited), Number (fixed32/64 lus en LE via DataView à la demande) ;
  `varints(buf) -> number[]` (dépaquetage packed) ; `doubles(buf) -> Float64Array` ; `floats(buf) -> Float32Array`.
- Produces (`proto.mjs`): parseurs ciblés, chacun `(buf) -> objet` :
  - `parsePlanetoid(buf) -> { rootEpoch }` (champ 1 NodeMetadata → champ 5 bulk_metadata_epoch, repli champ 2 epoch)
  - `parseBulk(buf) -> { nodes: Map<relPath, { relPath, flags, epoch, bulkEpoch, imageryEpoch, metersPerTexel }>, headNodeCenter: Float64Array(3), metersPerTexel: Float32Array, defaultImageryEpoch }`
    — `relPath`/`flags` décodés depuis `path_and_flags` (varint champ 1) : `level = 1 + (v & 3)`, puis `level` digits de 3 bits (`'0' + (v >> 2+3*i & 7)`), flags = le reste. Flags (proto NodeMetadata.Flags) : LEAF=4, NODATA=8, USE_IMAGERY_EPOCH=16.
  - `parseNode(buf) -> { matrix: Float64Array(16), copyrightIds: number[], meshes: [{ vertices: Buffer, indices: Buffer, texCoords: Buffer|null, uvOffsetAndScale: Float32Array(4)|null, layerAndOctantCounts: Buffer, texture: { data: Buffer, format: number, width: number, height: number }|null, meshId }] }`
  - `parseCopyrights(buf) -> Map<id, text>` (champ 1 répété → { 1: id, 2: text })
- Numéros de champs (proto2 `geo_globetrotter_proto_rocktree`, vérifiés sur les fixtures) :
  PlanetoidMetadata{1: NodeMetadata} ; NodeMetadata{1 path_and_flags, 2 epoch, 3 obb(bytes 15), 4 meters_per_texel(float), 5 bulk_metadata_epoch, 7 imagery_epoch} ;
  BulkMetadata{1 node_metadata rép., 2 NodeKey{1 path, 2 epoch}, 3 head_node_center packed double, 4 meters_per_texel packed float, 5 default_imagery_epoch} ;
  NodeData{1 matrix_globe_from_mesh packed double ×16, 2 Mesh rép., 3 copyright_ids varint rép. (packed OU non — gérer les deux), 5 kml_bounding_box} ;
  Mesh{1 vertices, 3 indices, 6 Texture rép., 7 texture_coordinates, 8 layer_and_octant_counts, 10 uv_offset_and_scale packed float ×4, 12 mesh_id} ;
  Texture{1 data rép. (prendre la première), 2 format (JPG=1), 3 width déf. 256, 4 height déf. 256}.

- [ ] **Step 1 : écrire les tests qui échouent** — dans `tools/rocktree-selftest.mjs` :

```js
// Selftest du client rocktree (issue #18, Stage 3). Aucune E/S réseau : tout
// tourne sur tools/testdata/rocktree/, figé depuis une capture réelle.
// Lancer : node tools/rocktree-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFields, varints, doubles, floats } from './lib/rocktree/pb.mjs';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from './lib/rocktree/proto.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');
const FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('pb : varint, len-delimited et packed doubles sur un message fabriqué', () => {
	// field 1 varint 300 ; field 2 bytes "ab" ; field 3 packed double [1.5]
	const buf = Buffer.from([0x08, 0xac, 0x02, 0x12, 0x02, 0x61, 0x62, 0x1a, 0x08, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
	const f = readFields(buf);
	assert.equal(f[0].value, 300);
	assert.equal(f[1].value.toString(), 'ab');
	assert.equal(doubles(f[2].value)[0], 1.5);
});

t('planetoid : epoch racine 1014 (constaté live le 2026-08-31)', () => {
	assert.equal(parsePlanetoid(read(FIX.planetoid)).rootEpoch, FIX.epoch);
});

t('copyrights : des centaines d\'entrées, du texte utf-8 exploitable', () => {
	const map = parseCopyrights(read(FIX.copyrights));
	assert.ok(map.size > 100, `${map.size} entrées`);
	assert.ok([...map.values()].some((s) => /©|NASA|Maxar|Airbus/.test(s)));
});

t('bulk racine : les chemins relatifs font 1 à 4 digits octaux, la racine a des enfants', () => {
	const bulk = parseBulk(read(FIX.bulks[0].file));
	assert.ok(bulk.nodes.size > 0);
	for (const [p, m] of bulk.nodes) {
		assert.match(p, /^[0-7]{1,4}$/);
		assert.equal(typeof m.flags, 'number');
	}
});

t('bulk : la chaîne de la fixture se suit (chaque nœud du chemin existe dans son bulk)', () => {
	for (const node of FIX.nodes) {
		for (const b of FIX.bulks) {
			if (!node.path.startsWith(b.path) || node.path === b.path) continue;
			const rel = node.path.slice(b.path.length, b.path.length + 4);
			if (rel.length === 0) continue;
			const bulk = parseBulk(read(b.file));
			// Chaque préfixe du chemin relatif doit exister : c'est la propriété
			// qu'exploite la traversée (un enfant sans parent est un bug de parse).
			for (let i = 1; i <= rel.length; i++) {
				assert.ok(bulk.nodes.has(rel.slice(0, i)), `${b.path}+${rel.slice(0, i)} absent`);
			}
		}
	}
});

t('node : matrice 16 doubles dont le translationnel est à ~rayon terrestre', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		assert.equal(node.matrix.length, 16);
		const r = Math.hypot(node.matrix[12], node.matrix[13], node.matrix[14]);
		assert.ok(r > 6.3e6 && r < 6.45e6, `|t| = ${r}`);
		assert.ok(node.meshes.length > 0);
		for (const m of node.meshes) {
			assert.equal(m.vertices.length % 3, 0, 'vertices = 3 plans d\'octets');
			assert.ok(m.texture, 'texture présente');
			assert.equal(m.texture.format, 1, 'format JPG (la fixture a été capturée en !2e1)');
			// Un JPEG commence par FFD8.
			assert.equal(m.texture.data.readUInt16BE(0), 0xffd8);
		}
		assert.ok(node.copyrightIds.length > 0, 'copyright_ids présents');
	}
});

console.log(`rocktree-selftest : ${n} tests ok`);
```

- [ ] **Step 2 : vérifier l'échec**

```bash
node tools/rocktree-selftest.mjs
```

Attendu : ERR_MODULE_NOT_FOUND sur `./lib/rocktree/pb.mjs`.

- [ ] **Step 3 : implémenter `pb.mjs`**

```js
// Lecteur protobuf minimal (wire format uniquement — pas de schéma). Trois
// types suffisent à tout rocktree : varint (0), 64-bit (1), len-delimited (2),
// 32-bit (5). Écrit à la main pour ne tirer aucune dépendance : le .proto de
// référence est connu, le schéma est porté par proto.mjs.
export function readVarint(buf, pos) {
	let v = 0, shift = 0, b;
	do {
		b = buf[pos.i++];
		// Au-delà de 2^53 un varint ne tient plus dans un Number ; rocktree n'en
		// émet pas (epochs, ids, compteurs). On lève plutôt que de corrompre.
		if (shift >= 53) throw new Error('varint > 2^53');
		v += (b & 0x7f) * 2 ** shift;
		shift += 7;
	} while (b & 0x80);
	return v;
}

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

export function varints(buf) {
	const out = [], pos = { i: 0 };
	while (pos.i < buf.length) out.push(readVarint(buf, pos));
	return out;
}

export function doubles(buf) {
	return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function floats(buf) {
	return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
```

ATTENTION `doubles`/`floats` : le `slice` copie pour garantir l'alignement (un subarray de Buffer n'est pas forcément aligné sur 8).

- [ ] **Step 4 : implémenter `proto.mjs`**

Squelette (le motif se répète — un `pick(fields, num)` / `all(fields, num)` local) :

```js
import { readFields, varints, doubles, floats } from './pb.mjs';

const all = (fields, num) => fields.filter((f) => f.num === num).map((f) => f.value);
const one = (fields, num) => fields.find((f) => f.num === num)?.value;

// path_and_flags (NodeMetadata champ 1) : 2 bits de longueur, puis `level`
// digits de 3 bits (poids faible = premier digit), puis les flags.
export function unpackPathAndFlags(v) {
	const level = 1 + (v & 3);
	v = Math.floor(v / 4);
	let relPath = '';
	for (let i = 0; i < level; i++) { relPath += String(v & 7); v = Math.floor(v / 8); }
	return { relPath, flags: v };
}

export function parsePlanetoid(buf) {
	const meta = readFields(one(readFields(buf), 1));
	return { rootEpoch: Number(one(meta, 5) ?? one(meta, 2)) };
}

export function parseBulk(buf) {
	const f = readFields(buf);
	const nodes = new Map();
	for (const raw of all(f, 1)) {
		const m = readFields(raw);
		const { relPath, flags } = unpackPathAndFlags(one(m, 1));
		nodes.set(relPath, {
			relPath, flags,
			epoch: one(m, 2) ?? null,           // absent -> epoch du bulk courant
			bulkEpoch: one(m, 5) ?? null,       // epoch du bulk ENFANT à ce chemin
			imageryEpoch: one(m, 7) ?? null,
			metersPerTexel: one(m, 4) ?? null,
		});
	}
	return {
		nodes,
		headNodeCenter: doubles(one(f, 3) ?? Buffer.alloc(0)),
		metersPerTexel: floats(one(f, 4) ?? Buffer.alloc(0)),
		defaultImageryEpoch: one(f, 5) ?? null,
	};
}

export function parseNode(buf) {
	const f = readFields(buf);
	// copyright_ids : le champ 3 arrive packed (wire 2) ou éclaté (wire 0)
	// selon la taille — les deux existent dans la capture.
	const copyrightIds = f.filter((x) => x.num === 3)
		.flatMap((x) => (x.wire === 2 ? varints(x.value) : [x.value]));
	return {
		matrix: doubles(one(f, 1)),
		copyrightIds,
		meshes: all(f, 2).map(parseMesh),
	};
}

function parseMesh(buf) {
	const f = readFields(buf);
	const texRaw = one(f, 6);
	let texture = null;
	if (texRaw) {
		const t = readFields(texRaw);
		texture = { data: one(t, 1), format: one(t, 2) ?? 1, width: one(t, 3) ?? 256, height: one(t, 4) ?? 256 };
	}
	return {
		vertices: one(f, 1),
		indices: one(f, 3),
		texCoords: one(f, 7) ?? null,
		uvOffsetAndScale: one(f, 10) ? floats(one(f, 10)) : null,
		layerAndOctantCounts: one(f, 8),
		texture,
		meshId: one(f, 12) ?? 0,
	};
}

export function parseCopyrights(buf) {
	const map = new Map();
	for (const raw of all(readFields(buf), 1)) {
		const c = readFields(raw);
		map.set(one(c, 1), one(c, 2).toString('utf8'));
	}
	return map;
}
```

NOTE Mesh champ 10 : dans la capture il est parfois émis packed (wire 2, 16 octets) — `floats()` gère. Si un jour il arrive éclaté en wire 5, `one()` rendrait un Number : lever alors une erreur claire plutôt que deviner.

- [ ] **Step 5 : vérifier que les tests passent**

```bash
node tools/rocktree-selftest.mjs
```

Attendu : `rocktree-selftest : 6 tests ok`. Si le test « chemin relatif » échoue, suspecter l'ordre des digits dans `unpackPathAndFlags` (poids faible en premier).

- [ ] **Step 6 : commit**

```bash
git add tools/lib/rocktree/pb.mjs tools/lib/rocktree/proto.mjs tools/rocktree-selftest.mjs
git commit -m "Issue #18 : lecteur protobuf et parseurs rocktree, testés sur les fixtures HAR"
```

---

### Task 3: Dépaquetage des maillages

**Files:**
- Create: `tools/lib/rocktree/unpack.mjs`
- Modify: `tools/rocktree-selftest.mjs` (tests en plus)

**Interfaces:**
- Consumes: `parseNode()` de la Task 2.
- Produces:
  - `unpackVertices(buf) -> { xyz: Uint8Array (3 par sommet), count }` — delta-décodage par plan (X puis Y puis Z), modulo 256.
  - `unpackTexCoords(buf, count) -> { uv: Uint16Array (2 par sommet), uMod, vMod }` — 4 octets d'en-tête (uMod-1, vMod-1 en LE), puis 4 plans d'octets (lo(u), lo(v), hi(u), hi(v)), delta modulo uMod/vMod.
  - `unpackIndices(buf) -> Uint32Array` — triangle strip : varint de longueur, puis pour chaque entrée `strip[i] = zeros - val` où `zeros` compte les `val === 0` rencontrés.
  - `unpackLayerBoundsAndOctants(buf, strip, count) -> { layerBounds: Int32Array(10), octantOf: Uint8Array(count) }` — varint de longueur `len`, puis `len` varints ; tous les 8, borne de couche ; chaque varint v marque `v` indices successifs du strip avec l'octant `i & 7`.
- Sémantique aval (utilisée par la Task 5) : ne garder du strip que `i < layerBounds[3]` (couches 0-3 : OVERGROUND + terrain), sauter les triangles dégénérés (a==b||b==c||a==c), alterner l'enroulement (`i & 1` → a,c,b).

- [ ] **Step 1 : ajouter les tests qui échouent** — dans `tools/rocktree-selftest.mjs` :

```js
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './lib/rocktree/unpack.mjs';

t('unpack : sur chaque mesh des fixtures, les invariants géométriques tiennent', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			assert.equal(xyz.length, count * 3);
			const strip = unpackIndices(mesh.indices);
			for (const idx of strip) assert.ok(idx >= 0 && idx < count, `indice ${idx} / ${count} sommets`);
			const { layerBounds } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);
			assert.ok(layerBounds[3] <= strip.length);
			if (mesh.texCoords) {
				const { uv } = unpackTexCoords(mesh.texCoords, count);
				assert.equal(uv.length, count * 2);
			}
		}
	}
});

t('unpack : les sommets transformés par la matrice tombent à ~rayon terrestre', () => {
	// Le VRAI test du décodage : delta-unpacking faux = sommets aberrants,
	// et la norme ECEF le crie tout de suite (6 357–6 400 km + bâti).
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		const ma = node.matrix;
		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			for (let i = 0; i < count; i += 97) { // échantillon
				const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
				const ex = x * ma[0] + y * ma[4] + z * ma[8] + ma[12];
				const ey = x * ma[1] + y * ma[5] + z * ma[9] + ma[13];
				const ez = x * ma[2] + y * ma[6] + z * ma[10] + ma[14];
				const r = Math.hypot(ex, ey, ez);
				assert.ok(r > 6.35e6 && r < 6.4e6, `|v| = ${r}`);
			}
		}
	}
});

t('unpack : les UV finaux tombent dans [0,1] (uv_offset_and_scale du proto)', () => {
	for (const nf of FIX.nodes) {
		const node = parseNode(read(nf.file));
		for (const mesh of node.meshes) {
			if (!mesh.texCoords || !mesh.uvOffsetAndScale) continue;
			const { xyz, count } = unpackVertices(mesh.vertices);
			const { uv } = unpackTexCoords(mesh.texCoords, count);
			const [ou, ov, su, sv] = mesh.uvOffsetAndScale;
			let inRange = 0;
			for (let i = 0; i < count; i++) {
				const u = (uv[i * 2] + ou) * su, v = (uv[i * 2 + 1] + ov) * sv;
				if (u >= -0.01 && u <= 1.01 && v >= -0.01 && v <= 1.01) inRange++;
			}
			assert.ok(inRange / count > 0.99, `${inRange}/${count} UV dans [0,1]`);
		}
	}
});
```

- [ ] **Step 2 : vérifier l'échec** — `node tools/rocktree-selftest.mjs` → ERR_MODULE_NOT_FOUND sur unpack.mjs.

- [ ] **Step 3 : implémenter `unpack.mjs`**

```js
// Dépaquetage des maillages rocktree. Réécrit d'après la documentation de
// protocole d'earth-reverse-engineering (le dépôt n'a pas de licence : on ne
// copie pas, on réimplémente le format décrit).
import { readVarint } from './pb.mjs';

// 3 plans d'octets (tous les X, tous les Y, tous les Z), delta-encodés mod 256.
export function unpackVertices(buf) {
	const count = Math.floor(buf.length / 3);
	const xyz = new Uint8Array(count * 3);
	let x = 0, y = 0, z = 0;
	for (let i = 0; i < count; i++) {
		xyz[i * 3] = (x = (x + buf[i]) & 0xff);
		xyz[i * 3 + 1] = (y = (y + buf[count + i]) & 0xff);
		xyz[i * 3 + 2] = (z = (z + buf[count * 2 + i]) & 0xff);
	}
	return { xyz, count };
}

// En-tête 4 octets : (uMod-1, vMod-1) en uint16 LE. Puis 4 plans d'octets :
// lo(u), lo(v), hi(u), hi(v) — delta-encodés modulo uMod/vMod.
export function unpackTexCoords(buf, count) {
	const uMod = 1 + buf.readUInt16LE(0), vMod = 1 + buf.readUInt16LE(2);
	const data = buf.subarray(4);
	if (data.length !== count * 4) throw new Error(`texcoords : ${data.length} octets pour ${count} sommets`);
	const uv = new Uint16Array(count * 2);
	let u = 0, v = 0;
	for (let i = 0; i < count; i++) {
		uv[i * 2] = (u = (u + data[i] + (data[count * 2 + i] << 8)) % uMod);
		uv[i * 2 + 1] = (v = (v + data[count + i] + (data[count * 3 + i] << 8)) % vMod);
	}
	return { uv, uMod, vMod };
}

// Triangle strip compressé : chaque valeur est un recul par rapport au nombre
// de zéros déjà vus. Rendu en indices absolus, l'appelant déroule le strip.
export function unpackIndices(buf) {
	const pos = { i: 0 };
	const len = readVarint(buf, pos);
	const strip = new Uint32Array(len);
	let zeros = 0;
	for (let i = 0; i < len; i++) {
		const val = readVarint(buf, pos);
		strip[i] = zeros - val;
		if (val === 0) zeros++;
	}
	return strip;
}

// layer_and_octant_counts : `len` varints ; tous les 8 une borne de couche
// (indices dans le strip), et chaque varint v peint l'octant (i & 7) sur les
// v indices suivants du strip. layerBounds[3] = fin des couches terrain.
export function unpackLayerBoundsAndOctants(buf, strip, vertCount) {
	const pos = { i: 0 };
	const len = readVarint(buf, pos);
	const layerBounds = new Int32Array(10);
	const octantOf = new Uint8Array(vertCount);
	let k = 0, m = 0, idx = 0;
	for (let i = 0; i < len; i++) {
		if (i % 8 === 0 && m < 10) layerBounds[m++] = k;
		const v = readVarint(buf, pos);
		for (let j = 0; j < v; j++) octantOf[strip[idx++]] = i & 7;
		k += v;
	}
	while (m < 10) layerBounds[m++] = k;
	return { layerBounds, octantOf };
}
```

- [ ] **Step 4 : vérifier que les tests passent** — `node tools/rocktree-selftest.mjs`. Le test « rayon terrestre » est le juge de paix : s'il échoue avec des rayons énormes, l'ordre des plans (X,Y,Z vs entrelacé) est faux ; s'il échoue de peu, le `& 0xff` manque.

- [ ] **Step 5 : commit**

```bash
git add tools/lib/rocktree/unpack.mjs tools/rocktree-selftest.mjs
git commit -m "Issue #18 : dépaquetage des maillages rocktree, invariants ECEF/UV mesurés sur fixtures"
```

---

### Task 4: Maths d'octree — lat/lon ↔ octants, traversée sur emprise

**Files:**
- Create: `tools/lib/rocktree/octant.mjs`
- Modify: `tools/rocktree-selftest.mjs`

**Interfaces:**
- Consumes: rien (pur).
- Produces:
  - `rootOctant(lat, lon) -> { path, box: { n, s, w, e } }` — les 8 racines à 2 digits : lat<0 : '02','03','12','13' ; lat≥0 : '20','21','30','31' (par quadrants de 90° de longitude).
  - `childBoxes(box) -> [{ key, box }]` — les enfants 0..7 : bit 0 = moitié est (sauf aux pôles, fusionné à 0), bit 1 = moitié nord, bit 2 (+4) = variante verticale, MÊME box lat/lon que key & 3. Aux bords polaires (n=90 ou s=-90), pas de découpe est/ouest.
  - `octantsCovering(zone, level) -> générateur de { path, box }` — descend depuis les racines et rend les octants de niveau `level` (longueur de chemin) dont la box intersecte la zone `{ south, west, north, east }`. Les DEUX variantes verticales (key et key+4) sont rendues : le bâti vit dans l'une ou l'autre.
  - `boxIntersects(box, zone) -> boolean`.
- La zone d'un `poly` est sa bbox (le polygone exact reste un raffinement possible, hors scope).

- [ ] **Step 1 : tests qui échouent** — cas raisonnés à la main, même esprit que map-poly-selftest :

```js
import { rootOctant, childBoxes, octantsCovering } from './lib/rocktree/octant.mjs';

t('octant : Paris (48.86, 2.35) est dans la racine 30 (0..90°E, hémisphère nord)', () => {
	assert.equal(rootOctant(48.86, 2.35).path, '30');
	assert.equal(rootOctant(-33.9, 151.2).path, '13'); // Sydney
	assert.equal(rootOctant(40.7, -74.0).path, '21');  // New York
});

t('octant : les chemins de la fixture HAR (Paris) redescendent bien depuis 30', () => {
	for (const nf of FIX.nodes) assert.ok(nf.path.startsWith('30'), nf.path);
});

t('octant : childBoxes découpe en 4 boxes lat/lon × 2 variantes verticales', () => {
	const kids = childBoxes({ n: 90, s: 0, w: 0, e: 90 });
	assert.equal(kids.length, 8);
	const k3 = kids.find((k) => k.key === 3);
	assert.deepEqual(k3.box, { n: 90, s: 45, w: 45, e: 90 });
	// La variante +4 partage la box de sa jumelle.
	assert.deepEqual(kids.find((k) => k.key === 7).box, k3.box);
});

t('octant : octantsCovering rend, au niveau des fixtures, un surensemble de leurs chemins', () => {
	// La zone couverte par la capture contient les nœuds de la fixture : la
	// traversée géométrique doit proposer leurs chemins (le serveur décide
	// ensuite de leur existence — ici on ne teste que la géométrie).
	for (const nf of FIX.nodes) {
		const L = nf.path.length;
		// Une micro-zone autour de Paris 7e (la capture) :
		const zone = { south: 48.85, west: 2.29, north: 48.87, east: 2.32 };
		const found = new Set([...octantsCovering(zone, L)].map((o) => o.path));
		assert.ok(found.has(nf.path), `${nf.path} absent des ${found.size} octants proposés au niveau ${L}`);
	}
});
```

NOTE : si le dernier test échoue parce que la capture couvre une autre zone que 48.85-48.87/2.29-2.32, lire la vraie zone depuis `kml_bounding_box` (champ 5 de NodeData, 6 doubles lat/lon/alt) du plus petit nœud et ajuster la zone du test — la corriger dans le test, pas dans la géométrie.

- [ ] **Step 2 : vérifier l'échec** — ERR_MODULE_NOT_FOUND.

- [ ] **Step 3 : implémenter `octant.mjs`**

```js
// Adressage d'octree rocktree : la Terre en 8 racines de 2 digits, puis chaque
// digit ajoute une subdivision (2 bits lat/lon + 1 bit vertical). Réécrit
// d'après la documentation de protocole d'earth-reverse-engineering.

export function rootOctant(lat, lon) {
	const row = lat < 0 ? 0 : 2;
	if (lon < -90) return { path: `${row}0`.split('').reverse().join(''), box: null }; // voir table
	// (implémentation par table explicite, plus lisible que l'arithmétique :)
}
```

Implémentation par table explicite :

```js
const ROOTS = [
	['02', { n: 0, s: -90, w: -180, e: -90 }], ['03', { n: 0, s: -90, w: -90, e: 0 }],
	['12', { n: 0, s: -90, w: 0, e: 90 }],     ['13', { n: 0, s: -90, w: 90, e: 180 }],
	['20', { n: 90, s: 0, w: -180, e: -90 }],  ['21', { n: 90, s: 0, w: -90, e: 0 }],
	['30', { n: 90, s: 0, w: 0, e: 90 }],      ['31', { n: 90, s: 0, w: 90, e: 180 }],
];

export function rootOctant(lat, lon) {
	const [path, box] = ROOTS.find(([, b]) => lat >= b.s && (lat < b.n || b.n === 90) && lon >= b.w && (lon < b.e || b.e === 180));
	return { path, box };
}

export function childBoxes(box) {
	const midLat = (box.n + box.s) / 2, midLon = (box.w + box.e) / 2;
	const out = [];
	for (let key = 0; key < 8; key++) {
		const north = !!(key & 2), east = !!(key & 1);
		const b = {
			n: north ? box.n : midLat, s: north ? midLat : box.s,
			w: box.w, e: box.e,
		};
		// Aux calottes polaires la découpe est/ouest n'existe pas : la moitié
		// est (bit 0) est vide, tout vit côté 0.
		const polar = b.n === 90 || b.s === -90;
		if (!polar) { if (east) b.w = midLon; else b.e = midLon; }
		else if (east) continue;
		out.push({ key, box: b });
	}
	return out;
}

export function boxIntersects(box, zone) {
	return box.s < zone.north && box.n > zone.south && box.w < zone.east && box.e > zone.west;
}

export function* octantsCovering(zone, level) {
	function* walk(path, box) {
		if (path.length === level) { yield { path, box }; return; }
		for (const { key, box: b } of childBoxes(box)) {
			if (boxIntersects(b, zone)) yield* walk(path + key, b);
		}
	}
	for (const [path, box] of ROOTS) {
		if (boxIntersects(box, zone)) yield* walk(path, box);
	}
}
```

(supprimer le premier squelette de `rootOctant`, garder la version table).

- [ ] **Step 4 : vérifier que les tests passent** — `node tools/rocktree-selftest.mjs`.

- [ ] **Step 5 : commit**

```bash
git add tools/lib/rocktree/octant.mjs tools/rocktree-selftest.mjs
git commit -m "Issue #18 : adressage d'octree lat/lon->octants, validé contre les chemins du HAR"
```

---

### Task 5: Décodeur `rocktree` (seam 2)

**Files:**
- Create: `tools/lib/decoders/rocktree.mjs`
- Modify: `tools/lib/decoders/index.mjs` (inscription)
- Modify: `tools/rocktree-selftest.mjs` (test d'intégration décodeur sur un tileDir de fixtures)
- Modify: `tools/decoder-selftest.mjs` (rien à changer si les tests génériques passent — vérifier)

**Interfaces:**
- Consumes: Tasks 2-3 ; le contrat décodeur documenté dans `tools/lib/decoders/index.mjs`.
- Produces: un tileDir google-earth a la forme :
  - `rocktree-tile.json` : `{ provider: 'google-earth', epoch, level, fetchedAt, copyrights: { "<id>": "<texte>" }, nodes: [{ path, file, exclude: [octants] }] }`
  - `nodes/<path>.pb` : NodeData bruts.
  - `sniff(tileDir)` = présence de `rocktree-tile.json`.
- `decode()` rend le DecodeResult du contrat : `materials` (un par mesh de nœud, `{ name: '<path>_<meshId>', texture: Buffer }`), `vx/vy/vz` Growable(Float64Array) ECEF, `tu/tv` Growable(Float32Array) convention moteur, `triByMat` paires (vIdx, uvIdx) avec uvIdx = vIdx, `vertCount`, `attribution` (textes des copyright_ids rencontrés, dédupliqués, préfixés « Image © … » tels que servis + '© Google' en tête).

- [ ] **Step 1 : test qui échoue** — dans `tools/rocktree-selftest.mjs` :

```js
import * as rocktree from './lib/decoders/rocktree.mjs';
import { pick } from './lib/decoders/index.mjs';
import os from 'node:os';

t('décodeur : un tileDir de fixtures se décode et respecte le contrat', async () => {
	// Fabrique un tileDir depuis les fixtures (c'est le format que produira
	// le fournisseur en Task 6 — ce test EST le contrat entre les deux).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocktree-dec-'));
	try {
		fs.mkdirSync(path.join(dir, 'nodes'));
		const copyrights = {};
		for (const nf of FIX.nodes) {
			fs.copyFileSync(path.join(DIR, nf.file), path.join(dir, 'nodes', `${nf.path}.pb`));
		}
		// Résout les copyright_ids réels des fixtures contre copyrights.pb.
		const crMap = parseCopyrights(read(FIX.copyrights));
		for (const nf of FIX.nodes) {
			for (const id of parseNode(read(nf.file)).copyrightIds) {
				if (crMap.has(id)) copyrights[id] = crMap.get(id);
			}
		}
		fs.writeFileSync(path.join(dir, 'rocktree-tile.json'), JSON.stringify({
			provider: 'google-earth', epoch: FIX.epoch, level: 16,
			fetchedAt: '2026-08-31T00:00:00.000Z', copyrights,
			nodes: FIX.nodes.map((nf) => ({ path: nf.path, file: `nodes/${nf.path}.pb`, exclude: [] })),
		}, null, '\t'));

		assert.equal(pick(dir).id, 'rocktree', 'sniff par reniflage');
		const lines = [];
		const d = await rocktree.decode(dir, { onLog: (l) => lines.push(l) });

		assert.ok(d.vertCount > 0);
		assert.equal(d.tu.length, d.vertCount, 'un UV par sommet');
		for (const m of d.materials) assert.ok(Buffer.isBuffer(m.texture), 'textures en Buffer');
		// ECEF plausible sur un échantillon.
		const r = Math.hypot(d.vx.array[0], d.vy.array[0], d.vz.array[0]);
		assert.ok(r > 6.35e6 && r < 6.4e6, `|v0| = ${r}`);
		// UV moteur dans [0,1].
		for (let i = 0; i < d.vertCount; i += 101) {
			assert.ok(d.tu.array[i] >= -0.01 && d.tu.array[i] <= 1.01);
			assert.ok(d.tv.array[i] >= -0.01 && d.tv.array[i] <= 1.01);
		}
		// Les indices de triangles pointent dans les sommets.
		for (const g of d.triByMat) {
			for (let i = 0; i < g.length; i += 2) assert.ok(g.array[i] < d.vertCount);
		}
		// L'attribution vient des tuiles (niveau 3 du design).
		assert.ok(d.attribution.length > 0);
		assert.ok(d.attribution.some((s) => /Google/.test(s)));
		// Les deux lignes au mot près du contrat parsePrepLine.
		assert.ok(lines.some((l) => /^\s*\d+ materials, \d+ without a texture$/.test(l)), lines.join('|'));
		assert.ok(lines.some((l) => /^\s*[\d\s, .]+ vertices, [\d\s, .]+ uvs, [\d\s, .]+ triangles$/.test(l)));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2 : vérifier l'échec** — import inexistant.

- [ ] **Step 3 : implémenter `decoders/rocktree.mjs`**

Points imposés (le reste suit obj.mjs comme modèle) :

```js
// Décodeur rocktree — le format du fournisseur google-earth (issue #18).
// Chaque nœud d'octree porte sa matrice mesh->globe : les sommets uint8
// locaux deviennent des ECEF Float64 ici même, prep.mjs rebasera en ENU.
import fs from 'node:fs';
import path from 'node:path';
import { Growable } from '../growable.mjs';
import { parseNode } from '../rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from '../rocktree/unpack.mjs';

export const id = 'rocktree';

export function sniff(tileDir) {
	return fs.existsSync(path.join(tileDir, 'rocktree-tile.json'));
}

export async function decode(tileDir, { onLog } = {}) {
	const log = (line) => onLog?.(line);
	const tile = JSON.parse(fs.readFileSync(path.join(tileDir, 'rocktree-tile.json'), 'utf8'));
	if (!tile.nodes?.length) throw new Error(`${tileDir} : rocktree-tile.json ne liste aucun nœud.`);

	const materials = [];
	const vx = new Growable(Float64Array, 1 << 20), vy = new Growable(Float64Array, 1 << 20), vz = new Growable(Float64Array, 1 << 20);
	const tu = new Growable(Float32Array, 1 << 20), tv = new Growable(Float32Array, 1 << 20);
	const triByMat = [];
	const seenCopyrights = new Set();
	let faceCount = 0, noTexture = 0;

	for (const entry of tile.nodes) {
		const node = parseNode(fs.readFileSync(path.join(tileDir, entry.file)));
		for (const cid of node.copyrightIds) {
			const text = tile.copyrights?.[cid];
			if (text) seenCopyrights.add(text);
		}
		const ma = node.matrix;
		const exclude = new Set(entry.exclude ?? []);

		for (const mesh of node.meshes) {
			const { xyz, count } = unpackVertices(mesh.vertices);
			const strip = unpackIndices(mesh.indices);
			const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);

			// UV : delta-décodés puis normalisés par uv_offset_and_scale quand le
			// proto le fournit, sinon par le repli (0.5, 1/mod) du protocole.
			let uvNorm = null;
			if (mesh.texCoords) {
				const { uv, uMod, vMod } = unpackTexCoords(mesh.texCoords, count);
				const [ou, ov, su, sv] = mesh.uvOffsetAndScale ?? [0.5, 0.5, 1 / uMod, 1 / vMod];
				uvNorm = { uv, ou, ov, su, sv };
			}

			const base = vx.length;
			for (let i = 0; i < count; i++) {
				const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
				vx.push(x * ma[0] + y * ma[4] + z * ma[8] + ma[12]);
				vy.push(x * ma[1] + y * ma[5] + z * ma[9] + ma[13]);
				vz.push(x * ma[2] + y * ma[6] + z * ma[10] + ma[14]);
				if (uvNorm) {
					const u = (uvNorm.uv[i * 2] + uvNorm.ou) * uvNorm.su;
					const v = (uvNorm.uv[i * 2 + 1] + uvNorm.ov) * uvNorm.sv;
					// Convention moteur : origine haut-gauche. Le protocole a
					// l'origine en bas-gauche (constaté sur les exports OBJ de
					// référence) : on inverse V ici, comme obj.mjs pour l'OBJ.
					// C'EST LA DÉCISION À VÉRIFIER EN NAVIGATEUR (Task 9) — le
					// piège « textures grises » du projet.
					tu.push(u); tv.push(1 - v);
				} else { tu.push(0); tv.push(0); }
			}

			const mat = new Growable(Uint32Array, 1 << 10);
			materials.push({
				name: `${entry.path}_${mesh.meshId}`,
				texture: mesh.texture ? mesh.texture.data : (noTexture++, null),
			});
			triByMat.push(mat);

			const end = Math.min(layerBounds[3], strip.length);
			for (let i = 0; i + 2 < end; i++) {
				let a = strip[i], b = strip[i + 1], c = strip[i + 2];
				if (a === b || a === c || b === c) continue;
				if (i & 1) { const t = b; b = c; c = t; }
				// Un nœud parent n'émet pas les octants déjà servis par un enfant
				// sélectionné : sans ça, deux géométries se superposent en z-fight.
				if (exclude.size && exclude.has(octantOf[strip[i]])) continue;
				mat.push(base + a, base + a, base + b, base + b, base + c, base + c);
				faceCount++;
			}
		}
	}

	log(`  ${materials.length} materials, ${noTexture} without a texture`);
	const vertCount = vx.length;
	log(`  ${vertCount.toLocaleString()} vertices, ${tu.length.toLocaleString()} uvs, ${faceCount.toLocaleString()} triangles`);
	if (vertCount === 0 || faceCount === 0) {
		throw new Error(`${tileDir} ne contient aucune géométrie — rien à convertir.`);
	}

	return {
		materials, vx, vy, vz, tu, tv, triByMat, vertCount, faceCount,
		attribution: ['© Google', ...[...seenCopyrights].sort()],
	};
}
```

Et dans `decoders/index.mjs` :

```js
import * as obj from './obj.mjs';
import * as rocktree from './rocktree.mjs';

export const DECODERS = [obj, rocktree];
```

- [ ] **Step 4 : vérifier** — `node tools/rocktree-selftest.mjs` puis `node tools/decoder-selftest.mjs` (les tests génériques du registre doivent voir les deux décodeurs et passer tels quels).

- [ ] **Step 5 : commit**

```bash
git add tools/lib/decoders/rocktree.mjs tools/lib/decoders/index.mjs tools/rocktree-selftest.mjs
git commit -m "Issue #18 : décodeur rocktree inscrit — fixtures HAR décodées jusqu'au contrat prep.mjs"
```

---

### Task 6: Fournisseur `google-earth` (seam 1)

**Files:**
- Create: `tools/lib/providers/google-earth.mjs`
- Modify: `tools/lib/providers/index.mjs`
- Modify: `tools/rocktree-selftest.mjs` (traversée avec http injecté servi par les fixtures)
- Modify: `tools/provider-selftest.mjs` — vérifier que ses tests de contrat passent avec deux fournisseurs (ils itèrent sur `list()`).

**Interfaces:**
- Consumes: Tasks 2-4 ; le contrat fournisseur (id/label/attribution, `tileDirName`/`tileDirPath` async, `tileIsUsable`, `plan`, `probe`, `fetch`) tel que flyover.mjs l'implémente ; `Cancelled` de run.mjs n'est PAS utilisé (pas de sous-process) — l'annulation passe par `signal` sur fetch natif.
- Produces:
  - `id = 'google-earth'`, `label = 'Google Earth'`, `attribution = ['© Google']`.
  - Cache : `sim/.cache/google-earth/<tileDirName>` avec le même `tileDirName()` que flyover (réutiliser la même logique nom-par-zone : copier la fonction, le hash poly inclus — elle est indépendante du fournisseur de fait, mais chaque fournisseur reste libre de sa disposition, cf. HANDOFF).
  - `fetch(opts)` produit le tileDir de la Task 5 (`rocktree-tile.json` + `nodes/*.pb`) et rend `{ tileDir, attribution, fetchedAt, stats: { exported } }` — `attribution` = ['© Google'] (le décodeur affinera au niveau 3).
  - Le réseau passe par un `http(url, { signal }) -> Promise<Buffer>` interne remplaçable : `export const _net = { http }` et les tests le monkey-patchent (motif le plus simple sans framework d'injection ; documenter dans le module).
  - `zoomToLevel(zoom)` : table `{ 20: 20, 19: 19, 18: 18, ... }` PROVISOIRE identité bornée [13, 21] — la Task 8 la remplace par la table mesurée. Export nommé pour que la Task 8 la teste.

- [ ] **Step 1 : tests qui échouent** — dans `tools/rocktree-selftest.mjs` :

```js
import * as ge from './lib/providers/google-earth.mjs';

t('fournisseur : traversée sur fixtures — plan/probe/fetch sans réseau', async () => {
	// Sert les fixtures à la place de kh.google.com. Toute URL hors fixture
	// répond 404 (nœud absent) : la traversée doit s'en accommoder.
	const served = new Map();
	served.set('PlanetoidMetadata', read(FIX.planetoid));
	served.set(`Copyrights/pb=!1u${FIX.epoch}`, read(FIX.copyrights));
	for (const b of FIX.bulks) served.set(`BulkMetadata/pb=!1m2!1s${b.path}!2u${b.epoch}`, read(b.file));
	for (const nf of FIX.nodes) served.set(nf.url.replace('https://kh.google.com/rt/earth/', ''), read(nf.file));

	const realHttp = ge._net.http;
	ge._net.http = async (url) => {
		const key = url.replace('https://kh.google.com/rt/earth/', '');
		if (!served.has(key)) { const e = new Error(`404 ${key}`); e.status = 404; throw e; }
		return served.get(key);
	};
	try {
		const deepest = FIX.nodes.reduce((a, b) => (a.path.length >= b.path.length ? a : b));
		// La zone du nœud le plus profond, lue dans sa kml_bounding_box.
		const kml = doubles(readFields(read(deepest.file)).find((f) => f.num === 5).value);
		const zone = { bbox: { south: kml[1], west: kml[3], north: kml[0], east: kml[2] } };
		// NOTE : vérifier l'ordre réel des 6 doubles (n, s, e, w, altMax, altMin
		// attendu) en les imprimant une fois ; corriger le test si besoin.

		const plan = await ge.plan({ ...zone, zoom: 20 });
		assert.ok(plan.columns >= 1, `plan.columns = ${plan.columns}`);

		const probe = await ge.probe({ ...zone, zoom: 20 });
		assert.equal(probe.status, 'ok', probe.message);

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-fetch-'));
		ge._cacheRootForTests(tmp);
		try {
			const res = await ge.fetch({ ...zone, zoom: 20 });
			assert.ok(fs.existsSync(path.join(res.tileDir, 'rocktree-tile.json')));
			const tile = JSON.parse(fs.readFileSync(path.join(res.tileDir, 'rocktree-tile.json'), 'utf8'));
			assert.ok(tile.nodes.length >= 1);
			assert.ok(Object.keys(tile.copyrights).length >= 1, 'copyrights résolus');
			assert.ok(ge.tileIsUsable(res.tileDir));
			// Et le tileDir produit se décode : la boucle est bouclée hors-ligne.
			const d = await rocktree.decode(res.tileDir, {});
			assert.ok(d.vertCount > 0);
		} finally {
			ge._cacheRootForTests(null);
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	} finally {
		ge._net.http = realHttp;
	}
});
```

(`_cacheRootForTests(dir)` : override du répertoire de cache, null = retour au défaut. Ajouter aussi les imports manquants en tête du selftest : `os`, `readFields`, `doubles`.)

- [ ] **Step 2 : vérifier l'échec.**

- [ ] **Step 3 : implémenter `providers/google-earth.mjs`**

Structure imposée (~250 lignes) :

```js
// Fournisseur Google Earth : le protocole interne « rocktree » de
// earth.google.com — voir l'amendement 2026-08-31 du design #18. Pas de clé,
// pas d'API souscrite : même posture que Flyover, endpoints kh.google.com.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanetoid, parseBulk, parseCopyrights } from '../rocktree/proto.mjs';
import { octantsCovering } from '../rocktree/octant.mjs';
import { polyHash } from '../tiles.mjs';

const SIM_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
let CACHE_ROOT = path.join(SIM_ROOT, '.cache/google-earth');
export function _cacheRootForTests(dir) { CACHE_ROOT = dir ?? path.join(SIM_ROOT, '.cache/google-earth'); }

export const id = 'google-earth';
export const label = 'Google Earth';
export const attribution = ['© Google'];

const PREFIX = 'https://kh.google.com/rt/earth/';

// Réseau remplaçable par les tests (fixtures à la place de kh.google.com).
export const _net = {
	async http(url, { signal } = {}) {
		const res = await globalThis.fetch(url, { signal });
		if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
		return Buffer.from(await res.arrayBuffer());
	},
};

// PROVISOIRE (Task 8 la mesure) : zoom GUI 13-20 -> niveau d'octree.
export function zoomToLevel(zoom) { return Math.max(13, Math.min(21, zoom)); }
```

Puis :
- `tileDirName(opts)` : mêmes règles que flyover.mjs (poly-hash / bbox 6 décimales / centre-rayon) — copier la logique avec son commentaire adapté ; `tileDirPath = path.join(CACHE_ROOT, name)`.
- `tileIsUsable(dir)` : `rocktree-tile.json` présent, parseable, ≥ 1 nœud listé, et chaque `file` listé existe non vide.
- `zoneOf(opts)` : poly → bbox du ring ; bbox → bbox ; sinon carré de `radius` autour de (lat, lon) (mètres → degrés via cos(lat)).
- `traverse(zone, level, { signal, onLog })` : cœur du fournisseur.
  ```
  planetoid <- http(PREFIX + 'PlanetoidMetadata')            // rootEpoch
  bulks : Map<path, parseBulk>, téléchargés à la demande :
    getBulk(bulkPath) : epoch = racine si bulkPath '' ; sinon lu dans le bulk
    parent à l'entrée bulkPath[-4:] (champ bulkEpoch, repli epoch du parent).
  pour chaque { path } de octantsCovering(zone, level) :
    descendre les bulks tous les 4 digits ; à chaque étage vérifier que le
    préfixe relatif existe dans le bulk et n'est pas NODATA (flags & 8) ;
    LEAF (flags & 4) avant le niveau demandé => le nœud le plus profond
    existant est retenu à la place (fill-in, exclude vide).
  rend { nodes: [{ path, epoch, imageryEpoch, flags }], visitedBulks }
  — epoch du nœud = meta.epoch ?? epoch du bulk qui le liste ;
  — imageryEpoch = meta.imageryEpoch ?? bulk.defaultImageryEpoch,
    l'URL ne porte !3u que si (flags & 16).
  Dédupliquer les chemins retenus (deux octants géométriques peuvent se
  replier sur le même ancêtre) et calculer, pour chaque nœud retenu dont un
  ENFANT direct est aussi retenu, exclude = [digits de ces enfants & 7].
  ```
- `plan(opts, { signal })` : traverse au niveau `zoomToLevel(opts.zoom)`, SANS NodeData. Rend `{ columns: nodes.length, trigger: 'Google Earth', pruned: 0, coverage: zone }` — les champs que la GUI lit (`plan.columns`, `plan.trigger`, `plan.pruned`).
- `probe(opts, { signal })` : traverse une micro-zone (~3×3 octants au centre, même esprit que flyover). `status: 'ok'` si ≥ 1 nœud, message `« Couvert : N octant(s) au niveau L. »` ; sinon `'none'` avec `« Google Earth n'a pas de photogrammétrie à ce niveau ici. »`. Pas d'état `'undecodable'` (le protocole n'a qu'un format).
- `fetch(opts, { onLog, signal })` : cache-hit → mtime de `rocktree-tile.json` comme `fetchedAt` (même règle que flyover, même commentaire) ; sinon : purge, `phase: 'download'`, traverse, télécharge chaque NodeData (`!2e1`, séquentiel avec une petite fenêtre de 4 en vol via `Promise.all` par lots — pas de dépendance), `progress` par tuile téléchargée (`hits`), résout `Copyrights/pb=!1u{rootEpoch}` et n'inscrit dans `copyrights` que les ids réellement vus dans les NodeData (les parser via `parseNode` au fil de l'eau pour collecter les ids). Écrit `rocktree-tile.json` en dernier (il EST le marqueur d'usabilité : un fetch interrompu n'empoisonne pas le cache). Erreur si 0 nœud : message « aucune tuile 3D … Google Earth ne couvre pas cet endroit à ce niveau ; essaie un zoom plus bas. ».

Et l'inscription dans `providers/index.mjs` :

```js
import * as flyover from './flyover.mjs';
import * as googleEarth from './google-earth.mjs';

// L'ordre de priorité de l'issue #18 est : Google > Flyover > reality meshes
// ouverts. Les deux premiers sont inscrits ; Google est le défaut (design #18,
// « devient le fournisseur par défaut une fois le Stage 3 livré »).
export const DEFAULT_PROVIDER_ID = 'google-earth';

export const PROVIDERS = { [flyover.id]: flyover, [googleEarth.id]: googleEarth };
```

ATTENTION : changer `DEFAULT_PROVIDER_ID` fait basculer le CLI et la GUI sur Google par défaut. `provider-selftest.mjs` a un test « DEFAULT_PROVIDER_ID est inscrit » — vérifier qu'il teste la cohérence, pas la valeur 'flyover' ; s'il fige la valeur, le mettre à jour en citant le design.

- [ ] **Step 4 : vérifier** — `node tools/rocktree-selftest.mjs && node tools/provider-selftest.mjs`. Le test provider-selftest « contrat de surface » itère sur `list()` : les deux fournisseurs doivent exposer la même surface.

- [ ] **Step 5 : commit**

```bash
git add tools/lib/providers/google-earth.mjs tools/lib/providers/index.mjs tools/rocktree-selftest.mjs tools/provider-selftest.mjs
git commit -m "Issue #18 : fournisseur google-earth inscrit et par défaut — traversée d'octree testée sur fixtures"
```

---

### Task 7: Dispatch réel par fournisseur (le shim de compatibilité meurt)

Le point que le HANDOFF demandait de ne pas découvrir tard : `plan`/`probe`/`tileDirPath` sont câblés Flyover dans `add-map-core.mjs:24-30`, et la GUI importe ces symboles. Avec deux fournisseurs inscrits, `/plan` et `/probe` interrogeraient Flyover pour une carte Google et `DELETE ?raw=1` orphelinerait le cache Google.

**Files:**
- Modify: `tools/lib/add-map-core.mjs` (le shim devient dispatché : chaque fonction prend `opts.provider`)
- Modify: `tools/map-api-plugin.mjs` (endpoints `/plan`, `/probe`, `/describe`, DELETE `?raw=1`, nouveau GET `/providers` ; passer `b.provider` partout ; le DELETE lit `entry.provider` de scenes.json)
- Modify: `tools/add-map.mjs` (drapeau `--provider <id>`)
- Modify: `tools/map-gui/main.js` (sélecteur de fournisseur + mode Auto)
- Modify: `tools/map-gui/style.css` (si le sélecteur en a besoin — suivre l'existant)
- Modify: `tools/rocktree-selftest.mjs` ou `tools/provider-selftest.mjs` : test du dispatch.

**Interfaces:**
- Produces (`add-map-core.mjs`) — la surface historique change de signature, tous les appelants sont dans ce commit :
  ```js
  export const providerOf = (id) => providers.get(id ?? providers.DEFAULT_PROVIDER_ID);
  export const tileDirPath = (o) => providerOf(o.provider).tileDirPath(o);
  export const tileIsUsable = (d, providerId) => providerOf(providerId).tileIsUsable(d);
  export const planScan = (o, x) => providerOf(o.provider).plan(o, x);
  export const probeCoverage = (o, x) => providerOf(o.provider).probe(o, x);
  export const listProviders = () => providers.list().map((p) => ({ id: p.id, label: p.label }));
  // FLYOVER_ROOT et tileDirName disparaissent de la surface : vérifier au grep
  // qui les importe encore (gen-poly-fixture importe FLYOVER_ROOT -> l'importer
  // de providers/flyover.mjs directement).
  ```
- GUI : `GET /providers -> { providers: [{id, label}], default: DEFAULT_PROVIDER_ID }` ; `/plan`, `/probe`, `/add` acceptent `b.provider` (validé par `providers.get`, 400 sinon) ; « Auto » côté GUI = `probe(google-earth)` puis si `status !== 'ok'` `probe(flyover)`, et le fournisseur retenu part dans `/add` — l'ordre du design (« sonde Google d'abord et retombe sur Flyover »).
- DELETE `?raw=1` : le chemin de cache se calcule avec `entry.provider` (scenes.json le porte depuis le Stage 1) — plus jamais un chemin Flyover pour des octets Google.

- [ ] **Step 1 : test qui échoue (dispatch)** — dans `tools/provider-selftest.mjs` :

```js
import { planScan, tileDirPath } from './lib/add-map-core.mjs';
import * as ge from './lib/providers/google-earth.mjs';

t('dispatch : opts.provider choisit le fournisseur, plus de câblage Flyover', async () => {
	// tileDirPath d'une même zone diffère par fournisseur : la preuve que le
	// shim est mort. (flyover -> downloaded_files/obj, google-earth -> .cache)
	const opts = { lat: 48.86, lon: 2.35, zoom: 20, radius: 25, altitude: 20 };
	const pFly = await tileDirPath({ ...opts, provider: 'flyover' });
	const pGe = await tileDirPath({ ...opts, provider: 'google-earth' });
	assert.notEqual(pFly, pGe);
	assert.match(pGe, /\.cache\/google-earth/);
	await assert.rejects(planScan({ ...opts, provider: 'inconnu' }), /fournisseur inconnu/);
});
```

- [ ] **Step 2 : vérifier l'échec** (la signature actuelle ignore `opts.provider` : les deux chemins sont égaux… au chemin Flyover).

- [ ] **Step 3 : implémenter** — add-map-core, puis grep de TOUS les importeurs :

```bash
grep -rn "FLYOVER_ROOT\|tileDirName\|tileDirPath\|tileIsUsable\|planScan\|probeCoverage" tools/ --include="*.mjs" | grep -v lib/providers
```

Adapter chacun (map-api-plugin, map-poly-selftest, scanner-selftest, gen-poly-fixture). Dans map-api-plugin : `/plan` et `/probe` passent `provider: b.provider` ; DELETE `?raw=1` passe `entry.provider` ; ajouter `GET /providers`. Dans map-gui/main.js : un `<select>` [Auto (défaut), …providers] alimenté par `/providers` ; en mode Auto la sonde essaie google-earth puis flyover et affiche lequel a répondu ; le fournisseur élu est envoyé à `/add` et affiché dans le verdict (« Couvert par Google Earth : … »).

- [ ] **Step 4 : vérifier** — `node tools/provider-selftest.mjs && node tools/map-poly-selftest.mjs && node tools/scanner-selftest.mjs && npm run selftest:operator`.

- [ ] **Step 5 : vérification GUI dans un vrai navigateur** — `npm run dev`, ouvrir la GUI d'ajout, vérifier : le sélecteur liste Auto/Google Earth/Apple Flyover ; une sonde Auto sur Paris répond (Google d'abord) ; une sonde sur une ville Flyover-seulement retombe sur Flyover. Utiliser chrome-devtools MCP (mémoire projet : inspecter le DOM réel, pas les captures).

- [ ] **Step 6 : commit**

```bash
git add tools/lib/add-map-core.mjs tools/map-api-plugin.mjs tools/add-map.mjs tools/map-gui/ tools/provider-selftest.mjs tools/gen-poly-fixture.mjs tools/map-poly-selftest.mjs tools/scanner-selftest.mjs
git commit -m "Issue #18 : plan/probe/delete dispatchés par fournisseur — le shim Flyover câblé disparaît"
```

---

### Task 8: Calibration zoom ↔ niveau d'octree (mesurée, pas devinée)

**Files:**
- Create: `tools/rocktree-calibrate.mjs` (outil jetable mais committé, comme geofence-measure.mjs)
- Modify: `tools/lib/providers/google-earth.mjs` (`zoomToLevel` remplacée par la table mesurée + commentaire citant les mesures)
- Modify: `tools/rocktree-selftest.mjs` (le test de traversée utilise la table finale — ajuster si le niveau change)

**Interfaces:**
- Consumes: `parseBulk().metersPerTexel` (par niveau relatif dans le bulk) et les fixtures.
- Produces: `zoomToLevel(zoom)` finale — table figée avec, en commentaire, les m/texel mesurés par niveau et l'équivalence Flyover (`156543.03 * cos(lat) / 2^zoom` m/px de tuile, la référence du zoom actuel).

- [ ] **Step 1 : écrire l'outil de mesure**

`tools/rocktree-calibrate.mjs` : lit les bulks des fixtures (offline d'abord), imprime pour chaque niveau d'octant rencontré la moyenne de `meters_per_texel` (les bulks portent un tableau par niveau relatif — l'associer aux longueurs de chemins absolues) ; en face, imprime les m/texel Flyover pour zoom 13..20 à la latitude de la capture. Puis (optionnel, --live) refait la mesure sur une zone au choix via le réseau.

- [ ] **Step 2 : lancer, consigner**

```bash
node tools/rocktree-calibrate.mjs | tee /tmp/calibration.txt
```

Choisir, pour chaque zoom 13-20, le niveau dont le m/texel est le plus proche. Attendu (ordre de grandeur, à CONFIRMER par la mesure) : zoom 20 ≈ niveau 20-21, décalage à peu près constant. Si les données contredisent l'intuition, ce sont les données qui gagnent.

- [ ] **Step 3 : figer la table dans `zoomToLevel` avec les mesures en commentaire ; relancer `node tools/rocktree-selftest.mjs`.**

- [ ] **Step 4 : commit**

```bash
git add tools/rocktree-calibrate.mjs tools/lib/providers/google-earth.mjs tools/rocktree-selftest.mjs
git commit -m "Issue #18 : zoom->niveau d'octree calibré sur meters_per_texel mesurés"
```

---

### Task 9: Cuisson réelle d'une petite zone + vérification navigateur

Le critère d'acceptation du design : « une scène Google se charge, vole, entre en collision, et affiche l'attribution agrégée ».

**Files:**
- Modify: `tools/selftest.mjs` — la vérification UV lit `exp_model.mtl` en dur (gap #110) : rendre ce bloc conditionnel (si pas d'`exp_model.mtl` dans `manifest.source`, l'étape s'affiche « skipped (décodeur non-OBJ, #110) » au lieu d'échouer).
- Create (généré, non committé) : `public/scenes/<slug-test>/` via le pipeline.

**Interfaces:**
- Consumes: tout ce qui précède.

- [ ] **Step 1 : cuire une zone minuscule connue** (Paris, la zone de la capture — comparable à l'existant `seine-iena-alma`) :

```bash
node tools/add-map.mjs "GE Champ de Mars" 48.8582 2.2945 --zoom 19 --radius 120 --slug ge-champ-de-mars
```

Attendu : phase download avec compteur de hits, les deux lignes decode au mot près, rebuild, `✓ … prêt`. Noter les stats (nœuds, sommets, Mo) dans le commit. En cas d'erreur réseau 4xx sur NodeData : vérifier epoch/imagery epoch (le `!3u` ne part que si flags&16).

- [ ] **Step 2 : selftest sur la scène**

```bash
npm run selftest public/scenes/ge-champ-de-mars
```

Attendu : vert, avec l'étape UV « skipped (#110) ». Corriger selftest.mjs AVANT ce run (bloc conditionnel).

- [ ] **Step 3 : vérifier en navigateur** — `npm run dev`, `?scene=ge-champ-de-mars`, via chrome-devtools MCP :
  - la scène se charge et VOLE (collision comprise : poser le drone au sol) ;
  - les textures sont NETTES ET À L'ENDROIT — c'est le verdict sur l'inversion V du décodeur. Textures floues/grises/en damier miroir ⇒ inverser la décision `1 - v` de la Task 5, re-cuire, re-vérifier (le piège documenté du projet) ;
  - `#fo-credit` affiche « © Google · Image © 2026 … » (l'agrégat du décodeur), sur `fpvtp-osd` seulement.
- [ ] **Step 4 : nettoyage** — si la scène de test ne doit pas rester : `DELETE` via GUI ou retirer `public/scenes/ge-champ-de-mars` + l'entrée scenes.json. La garder est aussi défendable (première scène Google) — demander au propriétaire.

- [ ] **Step 5 : commit (selftest.mjs + scenes.json si la scène reste)**

```bash
git add tools/selftest.mjs
git commit -m "Issue #18 : selftest agnostique du décodeur (#110) — l'étape UV OBJ se saute proprement"
```

---

### Task 10: Documentation + PR

**Files:**
- Modify: `sim/HANDOFF.md` — l'entrée Stage 1-2 existante gagne son épilogue : Stage 3 livré, ce qui est vérifié (fixtures, selftests, cuisson réelle, navigateur), ce qui reste (reality meshes = étage 3 du design ; polygone exact dans la traversée ; #110 réglé ou toujours ouvert).
- Modify: `docs/manuel.md` — section fournisseurs : les deux inscrits, le défaut, `--provider`, le cache `.cache/google-earth/`, la régénération des fixtures (`gen-rocktree-fixture.mjs` + un HAR frais).
- Modify: `docs/superpowers/specs/…-second-fournisseur-3d-design.md` — rien (l'amendement y est déjà).

- [ ] **Step 1 : écrire les deux docs, dans le ton existant (vérifié / non vérifié explicites).**
- [ ] **Step 2 : lancer TOUT** :

```bash
npm run selftest:operator && npm run selftest && node tools/rocktree-selftest.mjs
```

- [ ] **Step 3 : commit + push + PR**

```bash
git add sim/HANDOFF.md docs/manuel.md
git commit -m "Issue #18 : HANDOFF/README — le fournisseur google-earth est livré et vérifié"
git push -u origin issue-18-google-earth
gh pr create --title "Issue #18, Stage 3 : fournisseur Google Earth (protocole rocktree)" --body "..."
```

Le corps de la PR : lien issue #18, résumé de l'amendement (rocktree, pas Map Tiles API), ce qui est vérifié et comment (fixtures HAR hors-ligne, cuisson réelle, navigateur), le changement de défaut (`DEFAULT_PROVIDER_ID`), et la mention licence (earth-reverse-engineering = doc de protocole, code réécrit). Statut projet : issue #18 reste In Progress jusqu'au merge, puis Done.

---

## Self-Review (fait à l'écriture)

- **Couverture spec** : priorité tranchée (amendement) ✓ ; seam fournisseur ✓ (T6) ; seam décodeur ✓ (T5) ; attribution 3 niveaux ✓ (T5-T6, niveau 3 réel) ; sélection auto Google→Flyover ✓ (T7 GUI) ; calibration LOD mesurée ✓ (T8) ; vérif « charge, vole, collisionne, crédite » ✓ (T9) ; schémas v3 déjà en place (Stage 1) — rien à faire ✓. Reality meshes (étage 3 du design) : hors de ce plan, dit dans T10/HANDOFF.
- **Placeholders** : les algorithmes cœur (pb, unpack, octant, décodeur) sont donnés en entier ; le fournisseur a sa structure et son pseudocode de traversée précis — c'est le seul endroit où l'implémenteur écrit du neuf non dicté, et ses tests sont donnés.
- **Cohérence de types** : DecodeResult conforme au contrat de decoders/index.mjs ; `_net.http -> Buffer` partout ; `rocktree-tile.json` identique entre T5 (test) et T6 (producteur) ; `plan()` rend `columns/trigger/pruned` que main.js lit.
