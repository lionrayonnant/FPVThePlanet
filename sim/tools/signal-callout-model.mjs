// The HUD callout's pure half (issue #185, spec §4): where the box goes, how
// much of it is decrypted, what the headline says. No DOM — the DOM layer is
// src/signal-callout.js.

// `w`, `h` are the DISPLAYED IMAGE (the sensor's aspect, letterboxed in the
// canvas); `x0`, `y0` its top-left in the OSD's coordinate space. Every px
// result is in that space. edge.nx/ny in [-1, 1]: where on the border the
// chevron sits, so the DOM can pull it inward rather than centre it on the edge.
export function placeCallout({ ndcX, ndcY, behind }, { w, h, x0 = 0, y0 = 0 }, { boxW = 230, boxH = 110, margin = 24 } = {}) {
	const ax = (ndcX + 1) / 2 * w;
	const ay = (1 - ndcY) / 2 * h;
	const onScreen = !behind && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;
	if (!onScreen) {
		let dx = ax - w / 2, dy = ay - h / 2;
		if (behind) { dx = -dx; dy = -dy; }
		if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = h; // dead behind: point down
		const hw = w / 2 - margin, hh = h / 2 - margin;
		const k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
		return {
			onScreen: false, ax: x0 + ax, ay: y0 + ay, bx: 0, by: 0,
			edge: {
				x: x0 + w / 2 + dx * k, y: y0 + h / 2 + dy * k,
				angleDeg: Math.atan2(dy, dx) * 180 / Math.PI,
				nx: hw > 0 ? (dx * k) / hw : 0, ny: hh > 0 ? (dy * k) / hh : 0,
			},
		};
	}
	let bx = ax + 60;
	if (bx + boxW > w - margin) bx = ax - 60 - boxW;
	let by = ay - 70 - boxH / 2;
	by = Math.max(margin, Math.min(h - margin - boxH, by));
	return { onScreen: true, ax: x0 + ax, ay: y0 + ay, bx: x0 + bx, by: y0 + by, edge: null };
}

// Where a rectilinear NDC point lands on screen once the lens has bent the
// picture (src/lens.js: the screen pixel q samples the render at
// q * (1 + k1 r^2 + k2 r^4) / (1 + k1 + k2 + ca), r = |q| / |(aspect, 1)|, in
// square-pixel space). Inverts that radial map by bisection: it is monotonic
// for the barrel terms the lens uses. No lens (k1 = k2 = ca = 0): identity.
export function lensWarp(ndcX, ndcY, { aspect = 1, k1 = 0, k2 = 0, ca = 0 } = {}) {
	if (!k1 && !k2 && !ca) return { x: ndcX, y: ndcY };
	const bx = ndcX * aspect, by = ndcY;
	const b = Math.hypot(bx, by);
	if (b < 1e-9) return { x: ndcX, y: ndcY };
	const rMax = Math.hypot(aspect, 1);
	const inv = 1 / (1 + k1 + k2 + ca);
	const fwd = (s) => { const r2 = (s / rMax) ** 2; return s * (1 + k1 * r2 + k2 * r2 * r2) * inv; };
	let lo = 0, hi = b;
	while (fwd(hi) < b && hi < 1e6) hi *= 2;
	for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fwd(mid) < b) lo = mid; else hi = mid; }
	const k = ((lo + hi) / 2) / b;
	return { x: ndcX * k, y: ndcY * k };
}

export function revealCount(nFields, gauge, state) {
	if (state === 'resolved') return nFields;
	if (state === 'encrypted') return 0;
	if (state !== 'capturing' && state !== 'held') return 0;
	return Math.min(nFields, Math.floor(gauge * (nFields + 1)));
}

const GLYPHS = '░▒▓█';
export function scramble(text, seed) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		if (text[i] === ' ') { out += ' '; continue; }
		let x = (seed * 374761393 + i * 668265263) >>> 0;
		x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
		out += GLYPHS[(x ^ (x >>> 16)) & 3];
	}
	return out;
}

// 'trace' / 'trace-wait': a tier II/III signal flown along its trace (lot 4),
// in the trace's own yellow — `TRACE · SPIRAL · 42 %`, and before the gate
// `TRACE · SPIRAL · ENTER THE GATE`.
export function headline(state, { need, shape, pct } = {}) {
	if (state === 'trace' || state === 'trace-wait') {
		const kind = String(shape ?? 'orbit').toUpperCase();
		const tail = state === 'trace-wait' ? 'ENTER THE GATE' : `${Math.max(0, Math.min(100, Math.floor(pct ?? 0)))} %`;
		return { word: `TRACE · ${kind} · ${tail}`, tone: 'yellow' };
	}
	if (state === 'capturing') return { word: 'CAPTURING', tone: 'orange' };
	if (state === 'resolved') return { word: 'UPLINKED', tone: 'green' };
	if (state === 'encrypted') return { word: `ENCRYPTED · CLEARANCE ${need}`, tone: 'dim' };
	return { word: 'SIGNAL', tone: 'dim' };
}
