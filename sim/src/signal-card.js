// The UPLINKED card (issue #185, spec 2026-09-27-signals-lot2b, layout B):
// slides into the right column ~6s after a landmark is UPLINKED, and doubles
// as a recap node on the end-of-flight screen. Layout decisions are in
// tools/signal-card-model.mjs; here there is only DOM. Every external string
// (OSM, Wikidata, Commons) reaches the page through textContent, never
// innerHTML (src/signal-callout.js's pattern) — an image src only from a
// frame we captured ourselves (a `data:image/` URL) or a Commons URL already
// checked by safeImageUrl.
import { iconPath } from './pixel-icons.js';
import { safeImageUrl } from '../tools/wikidata-model.mjs';
import { cardFacts, creditLine } from '../tools/signal-card-model.mjs';

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

// One card's DOM, shared by the in-flight card and each recap tile. `timer`
// adds the thin progress bar the recap does not show.
function buildCard({ timer }) {
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
	const photoPlaceholder = document.createElement('div'); photoPlaceholder.className = 'signal-card-placeholder';
	const photoCap = document.createElement('figcaption'); photoCap.textContent = 'REFERENCE';
	photoFig.append(photoImg, photoPlaceholder, photoCap);
	imgs.append(shotFig, photoFig);

	const body = document.createElement('div'); body.className = 'signal-card-body';
	const name = document.createElement('div'); name.className = 'signal-card-name';
	const desc = document.createElement('div'); desc.className = 'signal-card-desc';
	const facts = document.createElement('div'); facts.className = 'signal-card-facts';
	body.append(name, desc, facts);

	let timerFill = null;
	let timerEl = null;
	if (timer) {
		timerEl = document.createElement('div'); timerEl.className = 'signal-card-timer';
		timerFill = document.createElement('i');
		timerEl.append(timerFill);
	}

	const credit = document.createElement('div'); credit.className = 'signal-card-credit';
	const creditPhoto = document.createElement('div');
	const creditData = document.createElement('div'); creditData.textContent = DATA_LINE;
	credit.append(creditPhoto, creditData);

	el.append(top, imgs, body);
	if (timerEl) el.append(timerEl);
	el.append(credit);

	return { el, word, n, shotImg, photoImg, photoPlaceholder, name, desc, facts, timerFill, creditPhoto, _factsFor: null };
}

// The "n" line: SIGNAL index/total for the in-flight card (index/total
// present), just the distance/hold for a recap tile (they are not).
function nLine({ index, total, distM, holdS }) {
	const prefix = index != null && total != null ? `SIGNAL ${index}/${total} · ` : '';
	return `${prefix}${Math.round(distM)} M · ${holdS.toFixed(1)} S`;
}

// Rebuilds the facts row and swaps image sources only when the signal
// changes — not on every render() call, which happens every frame while the
// card is up. The distance/hold line is cheap text and always refreshed.
function fillCard(dom, view) {
	dom.n.textContent = nLine(view);
	const { signal, info, frameSrc } = view;

	if (dom._factsFor === signal.id) return;
	dom._factsFor = signal.id;

	dom.shotImg.hidden = !(typeof frameSrc === 'string' && frameSrc.startsWith('data:image/'));
	if (!dom.shotImg.hidden) dom.shotImg.src = frameSrc;

	const photoUrl = safeImageUrl(info?.photo?.url);
	dom.photoImg.hidden = !photoUrl;
	dom.photoPlaceholder.hidden = !!photoUrl;
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
		const dom = buildCard({ timer: true });
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
		timerFill.style.width = `${Math.round(Math.max(0, Math.min(1, view.remaining01)) * 100)}%`;
	}
}

// The end-of-flight recap: a titled grid of small cards, one per uplink, no
// timer. `entries` is the flight's `{ signal, info, frameSrc, distM, holdS }`
// list; null when the flight uplinked nothing (nothing to recap).
export function recapNode(entries) {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const root = document.createElement('div');
	root.className = 'signal-recap';
	const hd = document.createElement('div'); hd.className = 'signal-recap-hd';
	hd.textContent = `${entries.length} SIGNAL${entries.length === 1 ? '' : 'S'} UPLINKED`;
	const grid = document.createElement('div'); grid.className = 'signal-recap-grid';
	for (const entry of entries) {
		const dom = buildCard({ timer: false });
		dom.el.classList.add('signal-card-mini');
		fillCard(dom, entry);
		grid.append(dom.el);
	}
	root.append(hd, grid);
	return root;
}
