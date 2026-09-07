// URL du protocole rocktree (issue #18). Extrait de
// tools/lib/providers/google-earth.mjs (#168) : nodeUrl() ne dépend de rien
// de Node, contrairement au reste de ce fichier-là (fileURLToPath pour le
// cache de préparation) — la garder à côté de lui aurait entraîné cet import
// Node dans tout code qui voudrait construire une URL NodeData depuis un
// navigateur (src/rocktree-worker.js, #168).
// Surchargeable en dev par `VITE_ROCKTREE_BASE` (vérification headless
// derrière un proxy qui refuse le CONNECT de Chromium : un relais local sert
// les mêmes chemins). En Node, import.meta.env n'existe pas : Google direct.
export const PREFIX = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_ROCKTREE_BASE) || 'https://kh.google.com/rt/earth/';

// imageryEpoch peut rester null même avec le flag posé (ni meta.imageryEpoch
// ni bulk.defaultImageryEpoch renseignés dans certaines captures, cf.
// traverse() dans google-earth.mjs) : sans cette garde on émettait `!3unull`,
// un 404 garanti compté comme nœud manquant.
export function nodeUrl({ path, epoch, imageryEpoch, flags }) {
	let u = `${PREFIX}NodeData/pb=!1m2!1s${path}!2u${epoch}!2e1`;
	if ((flags & 16) && imageryEpoch != null) u += `!3u${imageryEpoch}`;
	return u + '!4b0';
}
