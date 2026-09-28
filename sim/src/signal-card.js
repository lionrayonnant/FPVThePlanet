// The UPLINKED card (issue #185), in the terminal's grammar (mockup
// flight-da.html): a hairline frame on the OSD scrim, `[+] UPLINKED` /
// `SIGNAL n · d m`, a green rule that shortens (the timer), the real place
// large, its name, its description, key/value lines, then the intercepted
// frame small and the credit. No pictograms, no filled boxes. It slides into
// the right column when a landmark is UPLINKED; the end of the flight recaps
// the uplinks as a compact strip. Layout decisions are in
// tools/signal-card-model.mjs; here there is only DOM. Every external string
// (OSM, Wikidata, Commons) reaches the page through textContent, never
// innerHTML (src/signal-callout.js's pattern) — an image src only from a
// frame we captured ourselves (a `data:image/` URL) or a Commons URL already
// checked by safeImageUrl.
import { safeImageUrl } from '../tools/wikidata-model.mjs';
import { cardRows, creditLine, recapTiles, interceptLines, MACHINE_NAMES } from '../tools/signal-card-model.mjs';

const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};

// The in-flight card's DOM.
function buildCard() {
	const root = el('div', 'signal-card');

	const hd = el('div', 'signal-card-hd');
	const word = el('span', 'signal-card-word', '[+] UPLINKED');
	const n = el('span', 'signal-card-n');
	hd.append(word, n);

	const rule = el('div', 'signal-card-rule');
	const ref = el('img', 'signal-card-ref'); ref.alt = '';
	const name = el('div', 'signal-card-name');
	const desc = el('div', 'signal-card-desc');
	const rows = el('pre', 'signal-card-rows');

	const icpt = el('div', 'signal-card-icpt');
	const shot = el('img'); shot.alt = '';
	const icptText = el('span');
	const icptLines = el('span');
	icptText.append('INTERCEPTED', document.createElement('br'), icptLines);
	icpt.append(shot, icptText);

	const credit = el('div', 'signal-card-credit');

	root.append(hd, rule, ref, name, desc, rows, icpt, credit);
	return { el: root, n, rule, ref, name, desc, rows, shot, icptLines, credit, _for: null, _n: '', _k: '' };
}

const isFrame = (src) => typeof src === 'string' && src.startsWith('data:image/');
const machineName = (family) => (family ? MACHINE_NAMES[family] ?? String(family).toUpperCase() : null);

// The key/value lines as the terminal's <pre>: labels padded to one column,
// values in ink (a <b>), built with text nodes only.
function fillRows(pre, rows) {
	const w = Math.max(0, ...rows.map(([k]) => k.length)) + 2;
	pre.replaceChildren();
	rows.forEach(([k, v], i) => {
		if (i) pre.append('\n');
		pre.append(k.padEnd(w, ' '));
		pre.append(el('b', null, v));
	});
	pre.hidden = rows.length === 0;
}

// render() runs every frame while the card is up: text and styles are written
// only when they change, the rest only when the card shows another signal.
function fillCard(dom, view) {
	const line = `SIGNAL ${view.index ?? '—'} · ${Math.round(view.distM)} m`;
	if (dom._n !== line) { dom._n = line; dom.n.textContent = line; }
	const { signal, info, frameSrc } = view;

	if (dom._for === signal.id) return;
	dom._for = signal.id;

	// A missing image collapses: no grey block.
	const photoUrl = safeImageUrl(info?.photo?.url);
	dom.ref.hidden = !photoUrl;
	if (photoUrl) dom.ref.src = photoUrl; else dom.ref.removeAttribute('src');

	dom.name.textContent = signal.name;
	dom.desc.textContent = info?.description ?? '';
	dom.desc.hidden = !info?.description;

	fillRows(dom.rows, cardRows(signal, info));

	dom.shot.hidden = !isFrame(frameSrc);
	if (!dom.shot.hidden) dom.shot.src = frameSrc; else dom.shot.removeAttribute('src');
	const machine = machineName(view.family);
	dom.icptLines.replaceChildren();
	interceptLines({ machine, holdS: view.holdS, trace: view.trace }).forEach((t, i) => {
		if (i) dom.icptLines.append(document.createElement('br'));
		dom.icptLines.append(t);
	});

	dom.credit.textContent = creditLine(info);
}

export class SignalCard {
	constructor(root) {
		const dom = buildCard();
		dom.el.id = 'fo-signal-card';
		dom.el.hidden = true;
		root.append(dom.el);
		this._dom = dom;
	}

	render(view) {
		const dom = this._dom;
		if (!view) { dom.el.hidden = true; return; }
		dom.el.hidden = false;
		fillCard(dom, view);
		// The timer: the rule shortens towards its left end, like the cut-link gauge.
		const k = (Math.round(Math.max(0, Math.min(1, view.remaining01)) * 200) / 200).toString();
		if (dom._k !== k) { dom._k = k; dom.rule.style.transform = `scaleX(${k})`; }
	}
}

// The end-of-flight recap: one row — the title, then a tile per uplink (the
// intercepted frame and the name), a `+N` tile past recapTiles()'s max. The
// full cards were the in-flight ones; no photo or facts here, the end screen
// has no height to spare. `entries` is the flight's uplink list; null when
// the flight uplinked nothing.
export function recapNode(entries) {
	const strip = recapTiles(entries);
	if (!strip) return null;
	const root = el('div', 'signal-recap');
	const hd = el('div', 'signal-recap-hd');
	hd.append(el('span', 'signal-recap-mark', '[+]'), ` ${entries.length} SIGNAL${entries.length === 1 ? '' : 'S'} UPLINKED`);
	const row = el('div', 'signal-recap-row');
	for (const { signal, frameSrc } of strip.tiles) {
		const tile = el('div', 'signal-recap-tile');
		const img = el('img'); img.alt = '';
		if (isFrame(frameSrc)) img.src = frameSrc;
		tile.append(img, el('div', 'signal-recap-name', signal?.name ?? ''));
		row.append(tile);
	}
	if (strip.more > 0) row.append(el('div', 'signal-recap-tile signal-recap-more', `+${strip.more}`));
	root.append(hd, row);
	return root;
}
