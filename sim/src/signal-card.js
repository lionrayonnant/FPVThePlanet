// The UPLINKED card (issue #185, spec 2026-09-27-signals-lot2b, layout B):
// slides into the right column ~6s after a landmark is UPLINKED; the end of
// the flight recaps the uplinks as a compact strip of tiles. Layout decisions are in
// tools/signal-card-model.mjs; here there is only DOM. Every external string
// (OSM, Wikidata, Commons) reaches the page through textContent, never
// innerHTML (src/signal-callout.js's pattern) — an image src only from a
// frame we captured ourselves (a `data:image/` URL) or a Commons URL already
// checked by safeImageUrl.
import { iconPath } from './pixel-icons.js';
import { safeImageUrl } from '../tools/wikidata-model.mjs';
import { cardFacts, creditLine, recapTiles } from '../tools/signal-card-model.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const DATA_LINE = 'DATA © OSM · WIKIDATA';

function pictogram(icon) {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 12 12');
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('fill', 'currentColor');
	svg.setAttribute('class', 'signal-card-pi');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG, 'path');
	path.setAttribute('d', iconPath(icon));
	svg.appendChild(path);
	return svg;
}

// The in-flight card's DOM.
function buildCard() {
	const el = document.createElement('div');
	el.className = 'signal-card';

	const top = document.createElement('div'); top.className = 'signal-card-top';
	const word = document.createElement('span'); word.textContent = 'UPLINKED';
	const n = document.createElement('span'); n.className = 'signal-card-n';
	top.append(word, n);

	const imgs = document.createElement('div'); imgs.className = 'signal-card-imgs';
	const shotFig = document.createElement('figure');
	const shotImg = document.createElement('img'); shotImg.alt = '';
	const shotCap = document.createElement('figcaption'); shotCap.textContent = 'INTERCEPTED';
	shotFig.append(shotImg, shotCap);
	const photoFig = document.createElement('figure');
	const photoImg = document.createElement('img'); photoImg.alt = '';
	const photoCap = document.createElement('figcaption'); photoCap.textContent = 'REFERENCE';
	photoFig.append(photoImg, photoCap);
	imgs.append(shotFig, photoFig);

	const body = document.createElement('div'); body.className = 'signal-card-body';
	const name = document.createElement('div'); name.className = 'signal-card-name';
	const desc = document.createElement('div'); desc.className = 'signal-card-desc';
	const facts = document.createElement('div'); facts.className = 'signal-card-facts';
	body.append(name, desc, facts);

	const timerEl = document.createElement('div'); timerEl.className = 'signal-card-timer';
	const timerFill = document.createElement('i');
	timerEl.append(timerFill);

	const credit = document.createElement('div'); credit.className = 'signal-card-credit';
	const creditPhoto = document.createElement('div');
	const creditData = document.createElement('div'); creditData.textContent = DATA_LINE;
	credit.append(creditPhoto, creditData);

	el.append(top, imgs, body, timerEl, credit);

	return { el, word, n, shotFig, shotImg, photoFig, photoImg, name, desc, facts, timerFill, creditPhoto, _factsFor: null, _n: '', _w: '' };
}

// The "n" line: SIGNAL index/total (frozen at the uplink), distance, hold.
function nLine({ index, total, distM, holdS }) {
	const prefix = index != null && total != null ? `SIGNAL ${index}/${total} · ` : '';
	return `${prefix}${Math.round(distM)} M · ${holdS.toFixed(1)} S`;
}

const isFrame = (src) => typeof src === 'string' && src.startsWith('data:image/');

// render() runs every frame while the card is up: text and styles are written
// only when they change, the rest only when the card shows another signal.
function fillCard(dom, view) {
	const line = nLine(view);
	if (dom._n !== line) { dom._n = line; dom.n.textContent = line; }
	const { signal, info, frameSrc } = view;

	if (dom._factsFor === signal.id) return;
	dom._factsFor = signal.id;

	// A missing image collapses its whole figure: no grey block, no caption.
	dom.shotFig.hidden = !isFrame(frameSrc);
	if (!dom.shotFig.hidden) dom.shotImg.src = frameSrc;

	const photoUrl = safeImageUrl(info?.photo?.url);
	dom.photoFig.hidden = !photoUrl;
	if (photoUrl) dom.photoImg.src = photoUrl;

	dom.name.textContent = signal.name;
	dom.desc.textContent = info?.description ?? '';
	dom.desc.hidden = !info?.description;

	dom.facts.replaceChildren(...cardFacts(signal, info).map((f) => {
		const span = document.createElement('span');
		span.append(pictogram(f.icon), document.createTextNode(f.text));
		return span;
	}));

	dom.creditPhoto.textContent = creditLine(info) ?? '';
	dom.creditPhoto.hidden = !info?.photo;
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
		const { el, timerFill } = this._dom;
		if (!view) { el.hidden = true; return; }
		el.hidden = false;
		fillCard(this._dom, view);
		const w = `${Math.round(Math.max(0, Math.min(1, view.remaining01)) * 100)}%`;
		if (this._dom._w !== w) { this._dom._w = w; timerFill.style.width = w; }
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
	const root = document.createElement('div');
	root.className = 'signal-recap';
	const hd = document.createElement('div'); hd.className = 'signal-recap-hd';
	hd.textContent = `${entries.length} SIGNAL${entries.length === 1 ? '' : 'S'} UPLINKED`;
	const row = document.createElement('div'); row.className = 'signal-recap-row';
	for (const { signal, frameSrc } of strip.tiles) {
		const tile = document.createElement('div'); tile.className = 'signal-recap-tile';
		const img = document.createElement('img'); img.alt = '';
		if (isFrame(frameSrc)) img.src = frameSrc;
		const name = document.createElement('div'); name.className = 'signal-recap-name';
		name.textContent = signal?.name ?? '';
		tile.append(img, name);
		row.append(tile);
	}
	if (strip.more > 0) {
		const more = document.createElement('div'); more.className = 'signal-recap-tile signal-recap-more';
		more.textContent = `+${strip.more}`;
		row.append(more);
	}
	root.append(hd, row);
	return root;
}
