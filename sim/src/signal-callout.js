// The HUD callout (issue #185, spec §4): a leader line from the landmark to a
// mono box, in the FPVTP! OSD — the local layer, which does not cross the
// link, so the callout never degrades with the video. Layout decisions are in
// tools/signal-callout-model.mjs; here there is only DOM. OSM text is written
// with textContent (PR #81).
import { revealCount, scramble, headline } from '../tools/signal-callout-model.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const CELLS = 12;

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
		if (!view) { this.el.hidden = true; this.chev.hidden = true; return; }
		const { signal, row, placed, now } = view;
		const { word, tone } = headline(row.state, { need: signal.need });
		if (!placed.onScreen) {
			this.el.hidden = true;
			this.chev.hidden = false;
			this.chev.dataset.tone = tone;
			const dist = Math.round(row.dist);
			this.chevTxt.textContent = `SIGNAL ${dist} M`;
			this.chevArrow.textContent = '▶';
			this.chevArrow.style.transform = `rotate(${placed.edge.angleDeg}deg)`;
			// Arrow on the side the chevron points to.
			if (placed.edge.nx > 0) this.chev.replaceChildren(this.chevTxt, this.chevArrow);
			else this.chev.replaceChildren(this.chevArrow, this.chevTxt);
			this.chev.style.left = `${placed.edge.x}px`;
			this.chev.style.top = `${placed.edge.y}px`;
			// Pulled inward by its own size: centred on the edge point, half of it
			// would hang off the image.
			this.chev.style.transform = `translate(${-50 - 50 * placed.edge.nx}%, ${-50 - 50 * placed.edge.ny}%)`;
			return;
		}
		this.chev.hidden = true;
		this.el.hidden = false;
		this.el.dataset.tone = tone;
		this.line.setAttribute('x1', placed.ax); this.line.setAttribute('y1', placed.ay);
		this.line.setAttribute('x2', placed.bx); this.line.setAttribute('y2', placed.by + 10);
		this.dot.setAttribute('x', placed.ax - 4); this.dot.setAttribute('y', placed.ay - 4);
		this.box.style.left = `${placed.bx}px`;
		this.box.style.top = `${placed.by}px`;
		this.word.textContent = word;
		this.dist.textContent = `${Math.round(row.dist)} M`;
		const lit = Math.round(row.gauge * CELLS);
		this.gauge.hidden = row.state === 'near' || row.state === 'encrypted';
		this.cells.forEach((c, i) => { c.className = i < lit ? 'on' : ''; });
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
		signal.fields.forEach((f, i) => {
			const v = this.rows.children[i].lastChild;
			const clear = i < shown;
			v.textContent = clear ? f.value : scramble(f.value, seed + i);
			v.dataset.clear = String(clear);
		});
	}
}
