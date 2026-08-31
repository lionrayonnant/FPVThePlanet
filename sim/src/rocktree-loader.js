// Adaptateur mince vers rocktree-worker-pool.js (#170) : rocktree-window.js
// (tranche suivante) n'a besoin de rien savoir du pool, juste de fetchNode().
export { fetchNode } from './rocktree-worker-pool.js';
