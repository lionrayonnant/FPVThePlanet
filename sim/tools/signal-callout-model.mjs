// The HUD callout's pure half (issue #185, spec §4): where the box goes, how
// much of it is decrypted, what the headline says. No DOM — the DOM layer is
// src/signal-callout.js.

export function placeCallout({ ndcX, ndcY, behind }, { w, h }, { boxW = 230, boxH = 110, margin = 24 } = {}) {
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
			onScreen: false, ax, ay, bx: 0, by: 0,
			edge: { x: w / 2 + dx * k, y: h / 2 + dy * k, angleDeg: Math.atan2(dy, dx) * 180 / Math.PI },
		};
	}
	let bx = ax + 60;
	if (bx + boxW > w - margin) bx = ax - 60 - boxW;
	let by = ay - 70 - boxH / 2;
	by = Math.max(margin, Math.min(h - margin - boxH, by));
	return { onScreen: true, ax, ay, bx, by, edge: null };
}

export function revealCount(nFields, gauge, state) {
	if (state === 'resolved') return nFields;
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

export function headline(state) {
	if (state === 'capturing') return { word: 'CAPTURING', tone: 'orange' };
	if (state === 'resolved') return { word: 'UPLINKED', tone: 'green' };
	return { word: 'SIGNAL', tone: 'dim' };
}
