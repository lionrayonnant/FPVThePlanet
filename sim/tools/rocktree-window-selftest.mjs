// Selftest de la politique de fenêtre de streaming rocktree (#168), SANS
// réseau réel : traverse() et fetchNode() sont injectés (mêmes fixtures que
// tools/rocktree-selftest.mjs, capture Paris epoch 1014). traverse() rend
// { nodes, radius } — même forme que le vrai traverse() de traverse.mjs
// (radius vient de PlanetoidMetadata) — PAS un tableau nu.
import assert from 'node:assert/strict';
import { RocktreeWindow, REFRESH_THRESHOLD_M, TRUST_MARGIN_M, FALLBACK_RADIUS_M, RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS, boxIntersectsDisc } from '../src/rocktree-window.js';
import { WORST_MEASURED_SPEED_MS } from '../src/geofence.js';
import { ringsFor } from './lib/rocktree/lod.mjs';

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

const ORIGIN = { lat: 48.85, lon: 2.29 };
// Deux nœuds synthétiques : la fenêtre initiale en retient un, un déplacement
// suffisant fait apparaître l'autre et disparaître le premier.
const NODE_A = { path: '3060', epoch: 1014, imageryEpoch: null, flags: 0 };
const NODE_B = { path: '3061', epoch: 1014, imageryEpoch: null, flags: 0 };
const RADIUS = 6371010;

function fakeDeps({ traverseNodes, fetchDelayMs = 0 }) {
	const fetched = [];
	const traverse = async () => ({ nodes: traverseNodes, radius: RADIUS });
	const fetchNode = async (n) => {
		fetched.push(n.path);
		if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
		return { matrix: new Float64Array(16), copyrightIds: [], meshes: [{ vertices: new Uint8Array(0), indices: new Uint8Array(0) }] };
	};
	return { traverse, fetchNode, fetched };
}

await t('premier update() : fetch le nœud désiré, onNodeReady appelé avec matrix+radius', async () => {
	const { traverse, fetchNode, fetched } = fakeDeps({ traverseNodes: [NODE_A] });
	const ready = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: (p, matrix, meshes, radius) => ready.push({ p, radius, hasMatrix: matrix.length === 16 }), onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.deepEqual(fetched, ['3060']);
	assert.equal(ready.length, 1);
	assert.equal(ready[0].p, '3060');
	assert.equal(ready[0].radius, RADIUS);
	assert.ok(ready[0].hasMatrix);
});

await t('update() sous le seuil de distance ne refait rien', async () => {
	const { traverse, fetchNode, fetched } = fakeDeps({ traverseNodes: [NODE_A] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	await win.update(ORIGIN);   // même position, pile
	assert.equal(fetched.length, 1, `refetché sans avoir bougé : ${fetched}`);
});

await t('déplacement au-delà du seuil : diff correcte (nouveau fetché, ancien libéré)', async () => {
	let call = 0;
	const traverse = async () => ({ nodes: call++ === 0 ? [NODE_A] : [NODE_B], radius: RADIUS });
	const fetchNode = async (n) => ({ matrix: new Float64Array(16), copyrightIds: [], meshes: [] });
	const ready = [], released = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: (p) => ready.push(p), onNodeReleased: (p) => released.push(p), _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	// ~1 km plus loin en latitude — largement au-dessus de REFRESH_THRESHOLD_M
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	assert.deepEqual(ready, ['3060', '3061']);
	assert.deepEqual(released, ['3060']);
});

await t('windowCenterLocal se déplace vers le nord (z négatif, convention -Z=nord) après le second update()', async () => {
	let call = 0;
	const traverse = async () => ({ nodes: call++ === 0 ? [NODE_A] : [NODE_B], radius: RADIUS });
	const fetchNode = async () => ({ matrix: new Float64Array(16), copyrightIds: [], meshes: [] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	assert.equal(win.windowCenterLocal, null);
	await win.update(ORIGIN);
	assert.ok(Math.hypot(win.windowCenterLocal.x, win.windowCenterLocal.z) < 1, 'au premier update(), le centre EST l\'origine');
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	assert.ok(win.windowCenterLocal.z < -500, `z=${win.windowCenterLocal.z} — attendu très négatif (nord, ~1000 m)`);
});

// Ce test garde l'UNITÉ de la latence, pas juste son signe : une version
// ancienne n'assertait que « > 0 », ce qui passait aussi avec le bug qui
// multipliait des MILLISECONDES par WORST_MEASURED_SPEED_MS (m/s) et rendait
// ~4300 m pour 100 ms de latence. On injecte donc une latence connue et on
// borne le résultat des DEUX côtés. La latence injectée est choisie pour que
// la formule DÉPASSE le plancher FALLBACK_RADIUS_M (sinon le plancher la
// masque et l'unité redevient invérifiable) : il faut > ~3,6 s à 42,72 m/s.
await t('nearestTrustedRadius() vaut REFRESH_THRESHOLD_M + latence(s)×vitesse − marge quand la formule dépasse le plancher', async () => {
	const DELAY_MS = 4000;
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	const slow = fakeDeps({ traverseNodes: [NODE_A], fetchDelayMs: DELAY_MS }).fetchNode;
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: slow });
	const r0 = win.nearestTrustedRadius();   // avant toute mesure : repli − marge
	assert.ok(r0 > 0, `repli=${r0}`);
	await win.update(ORIGIN);
	// update() ne bloque pas sur le fetch (volontaire) : la mesure de latence
	// n'existe qu'une fois la promesse retombée. On attend qu'elle bouge.
	const deadline = Date.now() + DELAY_MS + 3000;
	while (win.nearestTrustedRadius() === r0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	const r = win.nearestTrustedRadius();
	const expected = REFRESH_THRESHOLD_M + (DELAY_MS / 1000) * WORST_MEASURED_SPEED_MS - TRUST_MARGIN_M;
	// ±10 m ≈ ±234 ms de jitter de setTimeout : large pour le bruit de mesure,
	// mille fois trop serré pour laisser repasser une latence en ms brutes.
	assert.ok(Math.abs(r - expected) < 10, `rayon de confiance ${r.toFixed(1)} m, attendu ~${expected.toFixed(1)} m`);
	// Borne absolue indépendante des constantes : avec le bug d'unité, 4 s
	// donneraient ~171 km. Aucun rayon de confiance plausible n'est kilométrique.
	assert.ok(r > 0 && r < 500, `rayon de confiance hors de toute plage plausible : ${r}`);
});

// Le plancher (#180) : la formule latence×vitesse garantit la collision, mais
// ce rayon est aussi toute la portée visuelle du jalon. Mesuré en vol : à
// latence réelle (~0,1-2 s) elle rendait 60-150 m, SOUS le rayon de boot —
// l'horizon reculait dès le premier recalcul (1032 meshes → ~340).
await t('le rayon ne descend jamais sous FALLBACK_RADIUS_M une fois la latence mesurée (#180)', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	const fast = fakeDeps({ traverseNodes: [NODE_A], fetchDelayMs: 100 }).fetchNode;
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fast });
	await win.update(ORIGIN);
	// Une latence de 100 ms donne 50 + 0,1×42,72 ≈ 54 m par la formule : bien
	// sous le plancher. On attend que la mesure existe, puis on vérifie que le
	// rayon rendu est celui du plancher, pas celui de la formule.
	const deadline = Date.now() + 3000;
	while (win._latencies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	assert.ok(win._latencies.length > 0, 'latence jamais mesurée — le test ne teste rien');
	assert.equal(win.nearestTrustedRadius(), FALLBACK_RADIUS_M - TRUST_MARGIN_M);
});

// Le curseur Settings (#182) pilote le plancher : setFloorRadiusM() doit
// (1) remplacer le plancher rendu par nearestTrustedRadius(), et (2) invalider
// le cache de position — sans ça, update() ignore le nouveau rayon tant que le
// drone n'a pas bougé de REFRESH_THRESHOLD_M, et le curseur semble mort.
await t('setFloorRadiusM() change le rayon rendu et force le recalcul au prochain update() sans déplacement (#182)', async () => {
	// Un nœud déjà chargé ne doit PAS être re-fetché quand le rayon change —
	// l'observable du recalcul est donc traverse(), pas fetchNode() : appelée
	// une seconde fois, avec une zone élargie au nouveau rayon.
	const zones = [];
	const traverse = async (zone) => { zones.push(zone); return { nodes: [NODE_A], radius: RADIUS }; };
	const { fetchNode, fetched } = fakeDeps({ traverseNodes: [NODE_A] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	// Une traversée par anneau de LOD (#22) : la dernière de chaque update()
	// est celle de l'anneau extérieur, au rayon de chargement.
	const ringsBefore = ringsFor(FALLBACK_RADIUS_M, 21).length;
	assert.equal(zones.length, ringsBefore);
	assert.equal(win.nearestTrustedRadius(), FALLBACK_RADIUS_M - TRUST_MARGIN_M);
	win.setFloorRadiusM(500);
	assert.equal(win.nearestTrustedRadius(), 500 - TRUST_MARGIN_M);
	// Même position : sans l'invalidation, cet update() serait un no-op et la
	// couronne 200→500 m ne serait jamais chargée.
	await win.update(ORIGIN);
	const ringsAfter = ringsFor(500, 21).length;
	assert.equal(zones.length, ringsBefore + ringsAfter, 'update() après setFloorRadiusM() n\'a pas re-traversé');
	// La zone extérieure (bbox degrés, zoneOf) doit s'être élargie dans le
	// rapport des rayons : 500/200 = 2,5.
	const height = (z) => z.north - z.south;
	assert.ok(Math.abs(height(zones.at(-1)) / height(zones[ringsBefore - 1]) - 500 / FALLBACK_RADIUS_M) < 1e-9,
		`zone pas élargie : ${height(zones[ringsBefore - 1])} → ${height(zones.at(-1))}`);
	// Et le nœud déjà chargé n'a pas été re-fetché.
	assert.equal(fetched.length, 1, `re-fetch inutile : ${fetched}`);
});

// Le constructeur accepte le plancher initial (la valeur stockée du curseur) :
// démarrer à 200 puis élargir à 300 une frame plus tard fetcherait le boot en
// deux vagues pour rien.
await t('floorRadiusM au constructeur : le rayon de boot est celui du curseur, pas le repli (#182)', async () => {
	const { traverse, fetchNode } = fakeDeps({ traverseNodes: [NODE_A] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, floorRadiusM: 300, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	assert.equal(win.nearestTrustedRadius(), 300 - TRUST_MARGIN_M);
});

// L'ordre de fetch (#184) : les nœuds proches du drone d'abord. Sans ça,
// l'ordre est celui de la marche de l'octree — le nœud SOUS le spawn peut
// arriver en dernier (l'attente du sol de bootLive() expirait à froid, drone
// mesuré à −917 m), et le terrain lointain apparaît avant le proche.
await t('update() fetche les nœuds par distance croissante au drone (#184)', async () => {
	const near = { path: 'near', epoch: 1, imageryEpoch: null, flags: 0, box: { s: 48.849, n: 48.851, w: 2.289, e: 2.291 } };
	const far = { path: 'far', epoch: 1, imageryEpoch: null, flags: 0, box: { s: 48.86, n: 48.862, w: 2.31, e: 2.312 } };
	const mid = { path: 'mid', epoch: 1, imageryEpoch: null, flags: 0, box: { s: 48.853, n: 48.855, w: 2.295, e: 2.297 } };
	// traverse rend l'ordre de la marche de l'octree : loin d'abord, exprès.
	const traverse = async () => ({ nodes: [far, mid, near], radius: RADIUS });
	const fetched = [];
	const fetchNode = async (nd) => { fetched.push(nd.path); return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] }; };
	// `far` est à ~1,8 km : un rayon de chargement assez grand pour que les
	// trois soient dans le disque (#21) — ce test ne juge que l'ORDRE.
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, floorRadiusM: 3000, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.deepEqual(fetched, ['near', 'mid', 'far']);
});

// Le build tourne dans le Worker (#187) : la conversion ECEF→ENU y a besoin
// du rayon de la sphère ET de l'origine ENU de la session — la fenêtre est
// la seule à les connaître, elle doit les joindre à chaque requête de fetch.
await t('_fetchNode reçoit sphereRadius/originEcef/originBasis avec le nœud (#187)', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	const got = [];
	const fetchNode = async (nd) => { got.push(nd); return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] }; };
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.equal(got.length, 1);
	assert.equal(got[0].path, NODE_A.path);
	assert.equal(got[0].sphereRadius, RADIUS, 'sphereRadius du traverse() doit voyager avec la requête');
	assert.deepEqual(got[0].originEcef, win.originEcef);
	assert.deepEqual(got[0].originBasis, win.originBasis);
});

// pendingCount() (#189) : ce que bootLive() attend derrière l'écran de
// chargement — le nombre de fetchs encore en vol. Sans lui, le drone est
// lâché dès le premier collider de sa colonne et peut atterrir dans un trou
// pas encore construit (passage sous la carte, churn infini mesuré à Lyon).
await t('pendingCount() suit les fetchs en vol : n pendant, 0 une fois résolus (#189)', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A, NODE_B] });
	let release;
	const gate = new Promise((r) => { release = r; });
	const fetchNode = async () => { await gate; return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] }; };
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	assert.equal(win.pendingCount(), 0);
	await win.update(ORIGIN);
	assert.equal(win.pendingCount(), 2, 'deux fetchs dispatchés, encore en vol');
	release();
	// laisse les continuations async retomber
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(win.pendingCount(), 0, 'tous résolus');
});

// Retry des fetchs échoués (#186) : un échec transitoire (réseau, 5xx, status
// null) laissait un trou permanent jusqu'au prochain recalcul de fenêtre
// (jusqu'à REFRESH_THRESHOLD_M de vol). update() doit désormais retenter sur
// place, avec backoff, SANS attendre ce recalcul.
await t('un échec non-404 (réseau/5xx) est retenté et finit par réussir (#186)', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	let calls = 0;
	// Échoue aux deux premières tentatives (status null = coupure réseau,
	// comme le rend rocktree-worker.js quand fetch() lève avant même la
	// réponse HTTP), réussit à la 3e — dans le budget de RETRY_MAX_ATTEMPTS.
	const fetchNode = async () => {
		calls++;
		if (calls < 3) { const err = new Error('réseau'); err.status = null; throw err; }
		return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] };
	};
	const ready = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: (p) => ready.push(p), onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	// Le budget total de backoff avant la dernière tentative est borné par
	// RETRY_DELAY_MS × 2^(RETRY_MAX_ATTEMPTS-1) environ ; large marge pour le
	// jitter de setTimeout.
	const deadline = Date.now() + RETRY_DELAY_MS * 2 ** RETRY_MAX_ATTEMPTS + 3000;
	while (ready.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	assert.equal(ready.length, 1, `jamais réussi après retry — tentatives=${calls}`);
	assert.equal(calls, 3, `nombre de tentatives inattendu : ${calls}`);
});

// 404/410 : résultat NORMAL du protocole (nœud absent), pas une panne — ne
// doit JAMAIS déclencher de retry, contrairement au cas ci-dessus.
await t('un 404 n\'est jamais retenté (#186)', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	let calls = 0;
	const fetchNode = async () => { calls++; const err = new Error('absent'); err.status = 404; throw err; };
	const win = new RocktreeWindow({
		level: 21, origin: ORIGIN,
		onNodeReady: () => { throw new Error('onNodeReady ne doit jamais être appelé pour un 404'); },
		onNodeReleased: () => {},
		_traverse: traverse, _fetchNode: fetchNode,
	});
	await win.update(ORIGIN);
	assert.equal(calls, 1);
	// Attend largement plus que le premier délai de backoff : s'il y avait un
	// (mauvais) retry, il se serait déclenché dans cette fenêtre.
	await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 200));
	assert.equal(calls, 1, `404 retenté à tort : ${calls} appels`);
	assert.equal(win.pendingCount(), 0, 'entrée doit être nettoyée, pas laissée pending, après un 404');
});

// Un retry en attente de backoff doit s'annuler proprement si le nœud sort de
// la fenêtre entre-temps (drone qui s'est déplacé) — même contrat que
// l'abort d'un fetch en vol : pas de fetch fantôme, pas d'appel à
// onNodeReleased (le nœud n'a jamais fini 'ready'), pas d'exception.
await t('un retry en attente est abandonné si le nœud n\'est plus désiré entre-temps (#186)', async () => {
	let call = 0;
	const traverse = async () => ({ nodes: call++ === 0 ? [NODE_A] : [NODE_B], radius: RADIUS });
	const fetchedPaths = [];
	const fetchNode = async (meta) => {
		fetchedPaths.push(meta.path);
		if (meta.path === NODE_A.path) { const err = new Error('réseau'); err.status = 500; throw err; }
		return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] };
	};
	const released = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: (p) => released.push(p), _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);   // NODE_A échoue, part en attente de backoff
	// La fenêtre bouge avant que le backoff n'expire : NODE_A n'est plus désiré.
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	// Laisse largement passer le délai de backoff qui aurait dû se déclencher
	// si l'annulation avait échoué.
	await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 300));
	assert.equal(fetchedPaths.filter((p) => p === NODE_A.path).length, 1,
		`NODE_A retenté après avoir quitté la fenêtre : ${JSON.stringify(fetchedPaths)}`);
	assert.deepEqual(released, [], 'NODE_A était encore pending — abort silencieux attendu, pas onNodeReleased');
	assert.equal(win.pendingCount(), 0, 'plus aucun fetch en vol une fois NODE_B résolu');
});

await t('la fenêtre est un disque : un nœud dans le coin du carré de traversée n\'est pas fetché (#21)', async () => {
	// Sans latence mesurée, le rayon de chargement est FALLBACK_RADIUS_M. Deux
	// nœuds à boxes minuscules : l'un dans le coin du carré (distance r·√2·0,9
	// ≈ 1,27 r, hors du disque), l'autre sur l'axe à 0,9 r (dedans). Et un
	// troisième dont la box est GRANDE et englobe l'origine : recoupe le
	// disque même si son centre est loin.
	const r = FALLBACK_RADIUS_M;
	const dLat = (m) => m / 111320;
	const dLon = (m) => m / (111320 * Math.cos(ORIGIN.lat * Math.PI / 180));
	const tiny = (lat, lon) => ({ s: lat - dLat(1), n: lat + dLat(1), w: lon - dLon(1), e: lon + dLon(1) });
	const corner = { ...NODE_A, path: '30600', box: tiny(ORIGIN.lat + dLat(0.9 * r), ORIGIN.lon + dLon(0.9 * r)) };
	const onAxis = { ...NODE_A, path: '30601', box: tiny(ORIGIN.lat + dLat(0.9 * r), ORIGIN.lon) };
	const big = { ...NODE_A, path: '30602', box: { s: ORIGIN.lat - dLat(3 * r), n: ORIGIN.lat + dLat(3 * r), w: ORIGIN.lon + dLon(0.5 * r), e: ORIGIN.lon + dLon(5 * r) } };
	const noBox = { ...NODE_A, path: '30603' };
	const { traverse, fetchNode, fetched } = fakeDeps({ traverseNodes: [corner, onAxis, big, noBox] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.deepEqual(fetched.sort(), ['30601', '30602', '30603'].sort(),
		`fetchés : ${JSON.stringify(fetched)} — le coin doit être écarté, l'axe, la grande box et le nœud sans box gardés`);
	assert.ok(boxIntersectsDisc(corner.box, ORIGIN, r) === false && boxIntersectsDisc(onAxis.box, ORIGIN, r) === true);
	// Un nœud dont la box touche juste le bord du disque est gardé (≤, pas <).
	const edge = tiny(ORIGIN.lat + dLat(r + 0.5), ORIGIN.lon);
	assert.equal(boxIntersectsDisc(edge, ORIGIN, r), true, 'une box à cheval sur le bord recoupe le disque');
});

await t('un nœud toujours désiré mais dont l\'exclude a changé est reconstruit, pas laissé tel quel (#22)', async () => {
	// Depuis le LOD par anneaux, `exclude` dépend de la POSITION de la fenêtre :
	// un nœud grossier n'exclut un octant que tant qu'un nœud plus fin le
	// redessine. En volant, ce nœud fin sort du premier anneau et est libéré —
	// si le grossier, lui, reste en place avec son ancien exclude, l'octant
	// n'est plus dessiné par personne (trou) ; dans l'autre sens, il est
	// dessiné deux fois (z-fight). Mesuré sur les vraies données à Paris :
	// 70 nœuds sur 870 dérivent à chaque recentrage de 50 m.
	let exclude = [];
	const traverse = async () => ({ nodes: [{ ...NODE_A, exclude: [...exclude] }], radius: RADIUS });
	const fetched = [], released = [];
	const fetchNode = async (n) => { fetched.push({ path: n.path, exclude: n.exclude }); return { matrix: new Float64Array(16), copyrightIds: [], meshes: [] }; };
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: (p) => released.push(p), _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.deepEqual(fetched.map((f) => f.exclude), [[]]);
	exclude = [3];
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	assert.deepEqual(released, ['3060'], 'l\'ancien mesh doit être libéré avant d\'être reconstruit');
	assert.deepEqual(fetched.map((f) => f.exclude), [[], [3]], `refetché avec le nouvel exclude : ${JSON.stringify(fetched)}`);
	// Et sans changement d'exclude, rien ne bouge : pas de churn gratuit.
	await win.update({ lat: ORIGIN.lat + 2000 / 111320, lon: ORIGIN.lon });
	assert.equal(fetched.length, 2, 'un exclude inchangé ne provoque aucun refetch');
});

console.log(`rocktree-window-selftest : ${n} tests ok`);
