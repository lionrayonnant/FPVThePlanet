// Fige un petit échantillon du protocole rocktree depuis une capture HAR de
// earth.google.com. Lancer :
//   node tools/gen-rocktree-fixture.mjs "<chemin du .har>"
// Le HAR (114 Mo) ne rentre pas dans git ; ces quelques .pb, si. La fixture
// n'est pas « la vérité » — c'est le procès-verbal d'octets réellement servis
// par kh.google.com le 2026-08-31 (epoch racine 1014).
//
// Bulks absents du HAR (cache navigateur) ont été refetchés en live :
//   - Bulk racine ('') : https://kh.google.com/rt/earth/BulkMetadata/pb=!1m2!1s!2u1014
//   - Bulks intermédiaires manquants : même URL avec prefix dans !1s
//
// NodeData : le HAR les contient en !2e6 (CRN_DXT1), mais le fournisseur exige
// toujours !2e1 (JPEG). Les fixtures sont donc re-capturées en !2e1 : les URLs
// sont réécrites au moment de générer l'index. Régénérer n'introduit pas
// d'incohérence : les nœuds restent en JPEG.
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

// Charger tous les bulks du HAR
const bulks = new Map(byKind('BulkMetadata').map((e) => {
	const { path: p, epoch } = parseUrl(e.request.url);
	return [p, { path: p, epoch, b64: e.response.content.text }];
}));

// Charger bulks téléchargés en live (absence du cache navigateur du HAR)
// Ces fichiers doivent exister : bulk-root.pb et bulk-3060.pb
const loadLiveBulk = (prefix, filename) => {
	const filepath = path.join(OUT, filename);
	if (fs.existsSync(filepath)) {
		const b64 = Buffer.from(fs.readFileSync(filepath)).toString('base64');
		bulks.set(prefix, { path: prefix, epoch: 1014, b64 });
	}
};
loadLiveBulk('', 'bulk-root.pb');
loadLiveBulk('3060', 'bulk-3060.pb');

// Filtrer nœuds : Paris profond (30, len >= 14)
// Vérifier que tous les bulks parents existent (du HAR ou live)
const nodes = byKind('NodeData')
	.map((e) => ({ ...parseUrl(e.request.url), url: e.request.url, b64: e.response.content.text }))
	.filter((n) => n.path.startsWith('30') && n.path.length >= 14)
	.filter((n) => {
		for (let i = 0; i <= n.path.length - (n.path.length % 4 || 4); i += 4) {
			if (!bulks.has(n.path.slice(0, i))) return false;
		}
		return true;
	})
	.sort((a, b) => a.b64.length - b.b64.length);
if (nodes.length < 3) throw new Error(`seulement ${nodes.length} NodeData profonds de Paris avec chaîne de bulks complète`);
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
	// Réécrire l'URL HAR (!2e6 = CRN_DXT1) en !2e1 (JPEG), format que le fournisseur exige.
	const url = n.url.replace(/!2e\d+/, '!2e1');
	index.nodes.push({ path: n.path, epoch: n.epoch, imageryEpoch: n.imageryEpoch, url, file });
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, '\t') + '\n');
console.log(`${index.bulks.length} bulks, ${index.nodes.length} nodes ->`, OUT);
