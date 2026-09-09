// Coût CPU des primitives demo scene (PHASE 20, issue #57 : « une folie de
// 4 secondes ne doit pas retarder l'entrée en vol »). Les primitives écrivent
// du texte dans un <pre> — le coût est CPU pur (génération de chaîne), mesuré
// ici sur un faux élément. Budget : 2 ms/frame par primitive (à 60 fps la
// frame entière dispose de 16 ms, le rendu 3D est coupé pendant le rituel).
// Lancer : node tools/intro-primitives-bench.mjs — exit 1 si budget dépassé.
import { RITUAL_PRIMITIVES } from '../src/hack-grammars.js';

const FRAMES = 480; // 2 passes de V4 à 60 fps
const BUDGET_MS = 2;
const el = { textContent: '' };
let worst = ['', 0];

console.log('primitive        ms/frame');
for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
	fn(el, { t: 0, seed: 0.42, dur: 4 }); // échauffement JIT
	const t0 = performance.now();
	for (let i = 0; i < FRAMES; i++) fn(el, { t: (i / FRAMES) * 4, seed: 0.42, dur: 4 });
	const ms = (performance.now() - t0) / FRAMES;
	if (ms > worst[1]) worst = [name, ms];
	console.log(`${name.padEnd(16)} ${ms.toFixed(3)}`);
}

console.log(`\npire cas : ${worst[0]} à ${worst[1].toFixed(3)} ms/frame (budget ${BUDGET_MS} ms)`);
process.exit(worst[1] < BUDGET_MS ? 0 : 1);
