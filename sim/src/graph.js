// A small mono drawing kit for the DATA tab (issue #26, Bible §38–§39, §44).
//
// It knows how to put ink on a canvas and NOTHING else: no session, no track,
// no series names. Everything it draws arrives as plain numbers from
// tools/data-model.mjs, which is what keeps the model testable in Node and this
// file free of anything worth testing.
//
// The grammar, and it is the terminal's:
//   · hairlines, right angles, no fill behind anything, no rounded corners;
//   · ONE ink — the warm white of tokens.css, at three densities;
//   · magenta on the SELECTED item only (Bible §19: no permanent cyan/magenta —
//     it marks what the operator is pointing at, and disappears with it);
//   · axes and ticks lettered in the DATA face, at the DATA size.
//
// Every entry point tolerates a canvas that cannot give a 2D context and
// returns false: that is the headless case (tools/lib/fake-dom.mjs), and a
// graph that refuses to draw must never take a screen down with it.

import { token } from './palette.js';

// The DATA face, straight out of tokens.css. Read once per draw rather than
// hard-coded: the stylesheet stays the single source (PHASE 19).
const FONT_PX = 11;
const TICK = 3;              // tick length, px
const PAD = { top: 8, right: 8, bottom: 18, left: 34 };

function ink(alpha = 1) {
	const c = token('--warm-white') || '#ece7dd';
	return alpha >= 1 ? c : hexAlpha(c, alpha);
}

// tokens.css keeps the ramp in hex; the dim and faint densities are declared
// there as rgba() of the same white, which a canvas cannot resolve through a
// var(). Same white, same maths, one place.
function hexAlpha(hex, a) {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// The one colour that is not the ink, and only ever under the cursor.
function accent() { return token('--magenta') || '#e34de0'; }

// Sizes the backing store to the element and the device, and hands back a
// context whose units are CSS pixels. Returns null when there is no canvas to
// draw on — headless, or a browser without 2D.
function prepare(canvas, height) {
	const ctx = canvas?.getContext?.('2d');
	if (!ctx) return null;
	const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
	const w = Math.max(120, Math.round(canvas.clientWidth || canvas.width || 640));
	const h = Math.max(40, Math.round(height));
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = '100%';
	canvas.style.height = `${h}px`;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);
	ctx.font = `${FONT_PX}px ${token('--font-data') || 'ui-monospace, monospace'}`;
	ctx.textBaseline = 'alphabetic';
	// Hairlines land on the pixel grid: a 1px line drawn on an integer
	// coordinate straddles two rows and reads as a 2px blur.
	ctx.lineWidth = 1;
	return { ctx, w, h, plot: { x: PAD.left, y: PAD.top, w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom } };
}

const px = (v) => Math.round(v) + 0.5;

function line(ctx, x1, y1, x2, y2, alpha = 1) {
	ctx.strokeStyle = ink(alpha);
	ctx.beginPath();
	ctx.moveTo(px(x1), px(y1));
	ctx.lineTo(px(x2), px(y2));
	ctx.stroke();
}

// The two rules of a plot: the baseline and the left edge. No box, no grid —
// a grid is a dashboard (Bible §44), a rule is a machine.
function axes(ctx, p) {
	line(ctx, p.x, p.y + p.h, p.x + p.w, p.y + p.h, 0.28);
	line(ctx, p.x, p.y, p.x, p.y + p.h, 0.28);
}

function label(ctx, text, x, y, { align = 'left', alpha = 0.62 } = {}) {
	ctx.fillStyle = ink(alpha);
	ctx.textAlign = align;
	ctx.fillText(String(text), x, y);
	ctx.textAlign = 'left';
}

// Two graduations per axis and no more: nought and the ceiling. A mono screen
// reads a scale from its extremes; intermediate ticks only add ink.
function yTicks(ctx, p, max, fmt) {
	for (const [v, y] of [[0, p.y + p.h], [max, p.y]]) {
		line(ctx, p.x - TICK, y, p.x, y, 0.28);
		label(ctx, fmt(v), p.x - TICK - 2, y + (v === 0 ? 0 : FONT_PX * 0.8), { align: 'right', alpha: 0.38 });
	}
}

const round = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

// ---------------------------------------------------------------------------
// bars — one column per item, in the order given
//
// `items`: [{ label, value, selected }]. Labels are printed only while they fit
// without touching: a column strip that turns into a grey smear says less than
// no labels at all.

export function bars(canvas, { items = [], height = 96, format = round, everyLabel = 1 } = {}) {
	const g = prepare(canvas, height);
	if (!g) return false;
	const { ctx, plot: p } = g;
	axes(ctx, p);
	const max = items.reduce((m, b) => Math.max(m, b.value || 0), 0);
	yTicks(ctx, p, max, format);
	if (!items.length) return true;
	const step = p.w / items.length;
	const bw = Math.max(1, Math.min(step - 2, Math.floor(step * 0.7)));
	items.forEach((b, i) => {
		const v = Number.isFinite(b.value) ? b.value : 0;
		const h = max > 0 ? (v / max) * p.h : 0;
		const x = p.x + i * step + (step - bw) / 2;
		ctx.fillStyle = b.selected ? accent() : ink(b.current ? 0.9 : 0.62);
		// A zero column still gets a one-pixel foot: a week without a flight is
		// information, and an empty slot is not.
		ctx.fillRect(Math.round(x), Math.round(p.y + p.h - Math.max(h, v > 0 ? 1 : 0)), bw, Math.max(Math.round(h), v > 0 ? 1 : 1));
		if (b.label && i % everyLabel === 0) {
			label(ctx, b.label, x + bw / 2, p.y + p.h + FONT_PX + 4, { align: 'center', alpha: 0.38 });
		}
	});
	return true;
}

// ---------------------------------------------------------------------------
// histogram — the same columns, read from bins rather than items

export function histogram(canvas, { bins = [], height = 96, format = round } = {}) {
	return bars(canvas, {
		height,
		format,
		items: bins.map((b, i) => ({
			value: b.n,
			label: i === 0 || i === bins.length - 1 ? format(i === 0 ? b.x0 : b.x1) : '',
			selected: false,
		})),
	});
}

// ---------------------------------------------------------------------------
// scatter — one mark per point
//
// The mark is a cross, not a disc: a filled dot at this size is a bullet
// point, and this screen has no bullet points. The selected point keeps the
// cross and gains the accent, so what changes is the ink, not the shape.

export function scatter(canvas, {
	points = [], height = 140, maxX = 0, maxY = 0,
	formatX = round, formatY = round, xLabel = '', yLabel = '',
} = {}) {
	const g = prepare(canvas, height);
	if (!g) return false;
	const { ctx, plot: p } = g;
	axes(ctx, p);
	const mx = maxX > 0 ? maxX : points.reduce((m, q) => Math.max(m, q.x || 0), 0) || 1;
	const my = maxY > 0 ? maxY : points.reduce((m, q) => Math.max(m, q.y || 0), 0) || 1;
	yTicks(ctx, p, my, formatY);
	label(ctx, formatX(0), p.x, p.y + p.h + FONT_PX + 4, { alpha: 0.38 });
	label(ctx, formatX(mx), p.x + p.w, p.y + p.h + FONT_PX + 4, { align: 'right', alpha: 0.38 });
	if (xLabel) label(ctx, xLabel, p.x + p.w / 2, p.y + p.h + FONT_PX + 4, { align: 'center', alpha: 0.38 });
	if (yLabel) label(ctx, yLabel, p.x - PAD.left + 1, p.y - 1, { alpha: 0.38 });
	const r = 3;
	for (const q of points) {
		const x = p.x + ((q.x || 0) / mx) * p.w;
		const y = p.y + p.h - ((q.y || 0) / my) * p.h;
		const a = q.selected ? accent() : ink(0.62);
		ctx.strokeStyle = a;
		ctx.beginPath();
		ctx.moveTo(px(x - r), px(y)); ctx.lineTo(px(x + r), px(y));
		ctx.moveTo(px(x), px(y - r)); ctx.lineTo(px(x), px(y + r));
		ctx.stroke();
	}
	return true;
}

// ---------------------------------------------------------------------------
// steps — a curve read as a staircase
//
// A flight profile sampled at 5 Hz is a series of held values, not a smooth
// function, and a stepped line says exactly that. `marks` are the photos: a
// short vertical tick from the curve, which is what a capture is — an instant,
// not a value.

export function steps(canvas, {
	points = [], marks = [], height = 140, maxX = 0, maxY = 0,
	formatX = round, formatY = round, xLabel = '',
} = {}) {
	const g = prepare(canvas, height);
	if (!g) return false;
	const { ctx, plot: p } = g;
	axes(ctx, p);
	if (!points.length) return true;
	const x0 = points[0].x;
	const mx = (maxX > 0 ? maxX : points[points.length - 1].x - x0) || 1;
	const my = (maxY > 0 ? maxY : points.reduce((m, q) => Math.max(m, q.y || 0), 0)) || 1;
	yTicks(ctx, p, my, formatY);
	label(ctx, formatX(0), p.x, p.y + p.h + FONT_PX + 4, { alpha: 0.38 });
	label(ctx, formatX(mx), p.x + p.w, p.y + p.h + FONT_PX + 4, { align: 'right', alpha: 0.38 });
	if (xLabel) label(ctx, xLabel, p.x + p.w / 2, p.y + p.h + FONT_PX + 4, { align: 'center', alpha: 0.38 });
	const sx = (v) => p.x + ((v - x0) / mx) * p.w;
	const sy = (v) => p.y + p.h - ((v || 0) / my) * p.h;
	ctx.strokeStyle = ink(0.9);
	ctx.beginPath();
	let held = px(sy(points[0].y));
	ctx.moveTo(px(sx(points[0].x)), held);
	for (const q of points.slice(1)) {
		const x = px(sx(q.x));
		const y = px(sy(q.y));
		// Along at the held altitude, then up or down to the new one.
		ctx.lineTo(x, held);
		ctx.lineTo(x, y);
		held = y;
	}
	ctx.stroke();
	for (const m of marks) {
		const x = sx(m.x);
		const y = sy(m.y);
		line(ctx, x, y - 7, x, y, 1);
		ctx.strokeStyle = ink(1);
		ctx.strokeRect(px(x - 2), px(y - 11), 4, 4);
	}
	return true;
}
