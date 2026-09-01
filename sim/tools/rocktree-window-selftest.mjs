// Selftest de la politique de fenêtre de streaming rocktree (#168), SANS
// réseau réel : traverse() et fetchNode() sont injectés (mêmes fixtures que
// tools/rocktree-selftest.mjs, capture Paris epoch 1014). traverse() rend
// { nodes, radius } — même forme que le vrai traverse() de traverse.mjs
// (radius vient de PlanetoidMetadata) — PAS un tableau nu.
import assert from 'node:assert/strict';
import { RocktreeWindow, REFRESH_THRESHOLD_M, TRUST_MARGIN_M, FALLBACK_RADIUS_M } from '../src/rocktree-window.js';
import { WORST_MEASURED_SPEED_MS } from '../src/geofence.js';

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

console.log(`rocktree-window-selftest : ${n} tests ok`);
