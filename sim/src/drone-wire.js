// Le portrait fil de fer du quad (issue #264) — la MÊME recette que le vol,
// projetée en segments 2D. Module PUR : aucun Three, aucun DOM, donc le
// portrait de l'archive se vérifie en Node, comme tout le reste des écrans.
//
// Pourquoi du fil de fer et pas le rendu du vol : le monde est photographique,
// le terminal est monochrome et vectoriel, et les deux restent étanches. Un
// contexte WebGL dans les écrans du journal ferait entrer le moteur dans des
// clients purs (src/session-log.js) pour un dessin de deux cents traits.
//
// Pourquoi pas de liste d'arêtes dans la recette : les arêtes se DÉRIVENT des
// primitives que src/drone-mesh.js assemble déjà — une boîte donne douze
// arêtes, un cylindre deux cercles et des génératrices, un disque un cercle.
// Les écrire dans drone-shape.js serait une seconde description de la même
// géométrie, à tenir synchronisée pour rien.
//
// Pas d'élimination des faces cachées : les arêtes lointaines s'ATTÉNUENT.
// Une machine qu'on voit à travers se lit mieux qu'une silhouette pleine, et
// c'est le vocabulaire des `vector animations` de PHASE 20.

// Nombre de côtés d'un cercle. Exporté pour que le selftest exprime le contrat
// « une primitive rend exactement ses arêtes » sans le recopier.
export const CIRCLE_STEPS = 16;

const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

// Les arêtes d'une primitive, en coordonnées locales de la pièce.
function edgesOf(part) {
	const out = [];
	const push = (a, b) => out.push([a, b]);
	switch (part.kind) {
		case 'box': {
			const [w, h, d] = part.size.map((v) => v / 2);
			const c = [];
			for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) c.push([sx * w, sy * h, sz * d]);
			// Deux sommets sont voisins s'ils diffèrent sur un seul axe.
			for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
				const diff = c[i].reduce((n, v, k) => n + (v !== c[j][k] ? 1 : 0), 0);
				if (diff === 1) push(c[i], c[j]);
			}
			break;
		}
		case 'cylinder':
		case 'ring': {
			// Un conduit est un cylindre creux : src/drone-mesh.js le monte déjà
			// avec la même CylinderGeometry, donc size = [rayon, hauteur] pour
			// les deux. Le fil de fer n'a pas à savoir lequel a un fond.
			const r = part.size[0], h = (part.size[1] ?? 0) / 2;
			for (let i = 0; i < CIRCLE_STEPS; i++) {
				const a = (2 * Math.PI * i) / CIRCLE_STEPS, b = (2 * Math.PI * (i + 1)) / CIRCLE_STEPS;
				for (const y of [-h, h]) push([r * Math.cos(a), y, r * Math.sin(a)], [r * Math.cos(b), y, r * Math.sin(b)]);
				if (i % 4 === 0) push([r * Math.cos(a), -h, r * Math.sin(a)], [r * Math.cos(a), h, r * Math.sin(a)]);
			}
			break;
		}
		case 'disc': {
			const r = part.size[0];
			for (let i = 0; i < CIRCLE_STEPS; i++) {
				const a = (2 * Math.PI * i) / CIRCLE_STEPS, b = (2 * Math.PI * (i + 1)) / CIRCLE_STEPS;
				push([r * Math.cos(a), 0, r * Math.sin(a)], [r * Math.cos(b), 0, r * Math.sin(b)]);
			}
			break;
		}
		default: break;   // 'point' (LED) : rien à tracer
	}
	return out;
}

// Le placement d'un point de la pièce dans le repère du corps. Même ordre de
// rotations que src/drone-mesh.js, pour que le portrait et le maillage soient
// deux vues du même objet et pas deux objets qui se ressemblent.
function place(p, part) {
	let [x, y, z] = p;
	if (part.rotZ) { const c = Math.cos(part.rotZ), s = Math.sin(part.rotZ); [x, y] = [x * c - y * s, x * s + y * c]; }
	if (part.rotX) { const c = Math.cos(part.rotX), s = Math.sin(part.rotX); [y, z] = [y * c - z * s, y * s + z * c]; }
	if (part.rotY) { const c = Math.cos(part.rotY), s = Math.sin(part.rotY); [x, z] = [x * c + z * s, -x * s + z * c]; }
	return [x + part.at[0], y + part.at[1], z + part.at[2]];
}

export function wireOf(shape, { yawDeg = 30, pitchDeg = 20 } = {}) {
	if (!shape?.parts?.length) return { segments: new Float32Array(0), depth: new Float32Array(0) };

	const cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180);
	const cp = Math.cos(pitchDeg * Math.PI / 180), sp = Math.sin(pitchDeg * Math.PI / 180);

	const xs = [], ys = [], ds = [];
	for (const part of shape.parts) {
		for (const [a, b] of edgesOf(part)) {
			for (const p of [a, b]) {
				const [wx, wy, wz] = place(p, part);
				// Rotation d'orbite (lacet puis tangage), projection orthographique :
				// un portrait technique n'a pas de perspective.
				const rx = wx * cy + wz * sy;
				const rz = -wx * sy + wz * cy;
				xs.push(rx);
				ys.push(wy * cp - rz * sp);
				ds.push(wy * sp + rz * cp);
			}
		}
	}

	// Normalisation dans [-1, 1] en gardant les proportions : une machine large
	// doit RESTER large à côté d'une machine étroite. D'où boundingRadius, la
	// mesure que la recette porte déjà, et pas l'étendue mesurée sur les
	// segments — un recadrage ferait tenir toutes les familles à la même taille.
	const r = shape.boundingRadius || 1;
	const n = xs.length / 2;
	const segments = new Float32Array(4 * n);
	const depth = new Float32Array(n);
	let dMin = Infinity, dMax = -Infinity;
	for (const d of ds) { if (d < dMin) dMin = d; if (d > dMax) dMax = d; }
	const span = dMax - dMin || 1;
	for (let i = 0; i < n; i++) {
		segments[4 * i] = clamp(xs[2 * i] / r);
		segments[4 * i + 1] = clamp(ys[2 * i] / r);
		segments[4 * i + 2] = clamp(xs[2 * i + 1] / r);
		segments[4 * i + 3] = clamp(ys[2 * i + 1] / r);
		depth[i] = ((ds[2 * i] + ds[2 * i + 1]) / 2 - dMin) / span;
	}
	return { segments, depth };
}
