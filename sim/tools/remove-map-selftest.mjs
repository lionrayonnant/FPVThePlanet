// Selftest de la résolution du cache brut à la suppression (issue #154).
//
// tools/remove-map.mjs gardait sa propre constante Flyover et n'importait pas
// add-map-core : supprimer une scène google-earth avec --raw orphelinait son
// cache sim/.cache/google-earth/ tout en prétendant l'avoir cherché. La règle
// vit maintenant en un seul endroit, rawTileDirFor(), que la GUI (DELETE
// ?raw=1) et le CLI partagent.
//
// Lancer : node tools/remove-map-selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTileDirFor } from './lib/add-map-core.mjs';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const AREA = { lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 };

await t('une entrée google-earth résout dans le cache Google', async () => {
	const dir = await rawTileDirFor({ ...AREA, provider: 'google-earth' });
	assert.match(dir, /\.cache[/\\]google-earth/, `cache Google attendu, obtenu ${dir}`);
});

await t('une entrée historique SANS provider retombe sur le défaut du registre (google-earth)', async () => {
	// Les entrées d'avant le multi-fournisseur, et celles d'avant le retrait
	// d'Apple Flyover (2026-09-07), n'en portent pas. Le fournisseur qu'elles
	// visaient à l'époque n'existe plus : retomber dessus rejetterait au lieu de
	// supprimer, là où retomber sur le défaut du registre résout au moins vers
	// un fournisseur qui existe.
	const dir = await rawTileDirFor({ ...AREA });
	assert.match(dir, /\.cache[/\\]google-earth/);
});

await t('la forme de la zone est respectée : poly et bbox ne retombent pas sur centre+rayon', async () => {
	// Sans ça, la clé de cache ne retomberait pas sur le dossier réellement
	// écrit à l'acquisition, et --raw ne supprimerait rien en le taisant.
	const base = { zoom: 20, altitude: 20, provider: 'google-earth' };
	const centre = await rawTileDirFor({ ...base, lat: 48.85, lon: 2.29, radius: 25 });
	const bbox = await rawTileDirFor({ ...base, bbox: { south: 48.85, west: 2.29, north: 48.86, east: 2.30 } });
	const poly = await rawTileDirFor({ ...base, poly: [48.85, 2.29, 48.86, 2.29, 48.86, 2.30] });
	assert.equal(new Set([centre, bbox, poly]).size, 3, 'trois formes, trois clés');
});

await t('un fournisseur inconnu REJETTE au lieu de rendre un chemin plausible', async () => {
	await assert.rejects(rawTileDirFor({ ...AREA, provider: 'inconnu' }), /fournisseur inconnu/);
});

await t('remove-map.mjs n\'a plus de constante de cache en propre', async () => {
	// La régression que corrige #154 : une seconde voie, recalculée sur place.
	const src = fs.readFileSync(path.join(SIM_ROOT, 'tools/remove-map.mjs'), 'utf8');
	assert.doesNotMatch(src, /downloaded_files/, 'plus de chemin Flyover en dur');
	assert.doesNotMatch(src, /FLYOVER_ROOT/, 'plus de racine Flyover en propre');
	assert.match(src, /rawTileDirFor/, 'il passe par la voie partagée');
});

console.log(`\n${n} tests remove-map OK`);
