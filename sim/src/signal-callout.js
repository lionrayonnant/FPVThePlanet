// The HUD callout (issue #185, spec §4): a leader line from the landmark to a
// mono box, in the FPVTP! OSD — the local layer, which does not cross the
// link, so the callout never degrades with the video. Layout decisions are in
// tools/signal-callout-model.mjs; here there is only DOM. OSM text is written
// with textContent (PR #81).
import { revealCount, scramble, headline, chevronText } from '../tools/signal-callout-model.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const CELLS = 12;

// render() runs every frame, and a DOM write costs even when it writes the
// same value: each one goes through a cache of the last value written and is
// skipped when unchanged. Nothing else writes these nodes.
const written = new WeakMap();
function changed(el, key, v) {
	let c = written.get(el);
	if (!c) written.set(el, c = {});
	if (c[key] === v) return false;
	c[key] = v;
	return true;
}
const prop = (el, k, v) => { if (changed(el, k, v)) el[k] = v; };
const style = (el, k, v) => { if (changed(el, 's:' + k, v)) el.style[k] = v; };
const attr = (el, k, v) => { if (changed(el, 'a:' + k, v)) el.setAttribute(k, v); };
const data = (el, k, v) => { if (changed(el, 'd:' + k, v)) el.dataset[k] = v; };

export class SignalCallout {
	constructor(root) {
		const el = document.createElement('div');
		el.id = 'fo-signal';
		el.hidden = true;
		const svg = document.createElementNS(SVG, 'svg');
		svg.setAttribute('class', 'fo-signal-lead');
		const line = document.createElementNS(SVG, 'line');
		const dot = document.createElementNS(SVG, 'rect');
		dot.setAttribute('width', '8'); dot.setAttribute('height', '8');
		svg.append(line, dot);
		const box = document.createElement('div');
		box.className = 'fo-signal-box';
		const hd = document.createElement('div'); hd.className = 'hd';
		const word = document.createElement('span');
		const dist = document.createElement('span'); dist.className = 'dist';
		hd.append(word, dist);
		const gauge = document.createElement('div'); gauge.className = 'gauge';
		const cells = Array.from({ length: CELLS }, () => gauge.appendChild(document.createElement('i')));
		const rows = document.createElement('div'); rows.className = 'rows';
		box.append(hd, gauge, rows);
		const chev = document.createElement('div');
		chev.className = 'fo-signal-chev';
		chev.hidden = true;
		const chevArrow = document.createElement('span'); chevArrow.className = 'arrow';
		const chevTxt = document.createElement('span'); chevTxt.className = 'txt';
		chev.append(chevArrow, chevTxt);
		el.append(svg, box);
		root.append(el, chev);
		Object.assign(this, { el, svg, line, dot, box, word, dist, gauge, cells, rows, chev, chevArrow, chevTxt, _rowsFor: null });
	}

	render(view) {
		if (!view) { prop(this.el, 'hidden', true); prop(this.chev, 'hidden', true); return; }
		const { signal, row, placed, now, trace } = view;
		// trace: { shape, pct, wait } while this signal's trace is in the world.
		const { word, tone } = trace
			? headline(trace.wait ? 'trace-wait' : 'trace', trace)
			: headline(row.state, { need: signal.need });
		if (!placed.onScreen) {
			prop(this.el, 'hidden', true);
			prop(this.chev, 'hidden', false);
			data(this.chev, 'tone', tone);
			prop(this.chevTxt, 'textContent', chevronText(row.dist, trace));
			prop(this.chevArrow, 'textContent', '▶');
			style(this.chevArrow, 'transform', `rotate(${placed.edge.angleDeg}deg)`);
			// Arrow on the side the chevron points to.
			const right = placed.edge.nx > 0;
			if (changed(this.chev, 'side', right)) {
				if (right) this.chev.replaceChildren(this.chevTxt, this.chevArrow);
				else this.chev.replaceChildren(this.chevArrow, this.chevTxt);
			}
			style(this.chev, 'left', `${placed.edge.x}px`);
			style(this.chev, 'top', `${placed.edge.y}px`);
			// Pulled inward by its own size: centred on the edge point, half of it
			// would hang off the image.
			style(this.chev, 'transform', `translate(${-50 - 50 * placed.edge.nx}%, ${-50 - 50 * placed.edge.ny}%)`);
			return;
		}
		prop(this.chev, 'hidden', true);
		prop(this.el, 'hidden', false);
		data(this.el, 'tone', tone);
		attr(this.line, 'x1', placed.ax); attr(this.line, 'y1', placed.ay);
		attr(this.line, 'x2', placed.bx); attr(this.line, 'y2', placed.by + 10);
		attr(this.dot, 'x', placed.ax - 4); attr(this.dot, 'y', placed.ay - 4);
		style(this.box, 'left', `${placed.bx}px`);
		style(this.box, 'top', `${placed.by}px`);
		prop(this.word, 'textContent', word);
		prop(this.dist, 'textContent', `${Math.round(row.dist)} M`);
		const lit = Math.round(row.gauge * CELLS);
		prop(this.gauge, 'hidden', row.state === 'near' || row.state === 'encrypted');
		for (let i = 0; i < CELLS; i++) prop(this.cells[i], 'className', i < lit ? 'on' : '');
		if (this._rowsFor !== signal.id) {
			this.rows.replaceChildren(...signal.fields.map((f) => {
				const r = document.createElement('div');
				const k = document.createElement('span'); k.className = 'k'; k.textContent = f.label;
				const v = document.createElement('span'); v.className = 'v';
				r.append(k, v);
				return r;
			}));
			this._rowsFor = signal.id;
		}
		const shown = revealCount(signal.fields.length, row.gauge, row.state);
		const seed = Math.floor(now * 8);
		const fields = signal.fields;
		for (let i = 0; i < fields.length; i++) {
			const v = this.rows.children[i].lastChild;
			const clear = i < shown;
			// The scramble only changes at 8 Hz (its seed): not recomputed in between.
			const key = clear ? 'clear' : seed + i;
			const keyNew = changed(v, 'key', key), valueNew = changed(v, 'value', fields[i].value);
			if (keyNew || valueNew) {
				v.textContent = clear ? fields[i].value : scramble(fields[i].value, seed + i);
			}
			data(v, 'clear', String(clear));
		}
	}
}
