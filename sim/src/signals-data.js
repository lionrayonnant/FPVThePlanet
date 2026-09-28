// What you uplinked, inside DATA (issue #185, lot 3 task 9): the SIGNALS
// section (places, then the selected place's rows) and the capture view one
// uplinked row opens. The numbers come from tools/signals-data-model.mjs; this
// module only draws. Nothing touches `document` at import.
//
// Everything that comes from outside (names, descriptions, credits) goes in
// through textContent; an <img> src is either a safeImageUrl() Wikimedia URL
// or an object URL of our own session photo; the one link is a validated
// Commons file page.
import { mountScreen, screenButton } from './screen.js';
import { menuNav } from './menu-nav.js';
import { sharedSignalSource } from './signal-source.js';
import { sharedPlaceInfo } from './place-info.js';
import { safeImageUrl } from '../tools/wikidata-model.mjs';
import { clearanceOf } from '../tools/signal-clearance-model.mjs';
import { fit } from '../tools/session-log-model.mjs';
import {
	ELSEWHERE, DATA_CREDIT, buildSignals, listRows, detailRows, creditOf,
} from '../tools/signals-data-model.mjs';

// The place last looked at, for the session (same idea as terminal.js lastTab).
let lastPlace = null;

const NAME_W = 28;
const KEY_W = 13;

const el = (tag, cls = '', text = null) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== null) e.textContent = text;
	return e;
};

async function knownSignals() {
	try { return await sharedSignalSource().cachedSignals(); } catch { return []; }
}

// The SIGNALS section, as a DATA `.data-section`. `onOpen(entries, index)` is
// called when an uplinked row is chosen: `entries` are the selected place's
// uplinked entries (newest first), `index` the chosen one — hand both to
// runCapture(). Resolves once the cached signals have been read.
export async function signalsSection(api, { onOpen = () => {} } = {}) {
	const store = api.getOperator()?.signals ?? null;
	const data = buildSignals({ store, known: await knownSignals() });
	const clearance = clearanceOf(store);

	const box = el('div', 'data-section signals-section');
	box.appendChild(el('pre', '', 'SIGNALS'));
	box.appendChild(el('pre', 'terminal-foot',
		`${data.uplinked} UPLINKED · ${data.knownCount} KNOWN · ${data.places.length} PLACES`));

	if (!data.places.length) {
		box.appendChild(el('pre', 'terminal-empty', 'NOTHING UPLINKED YET'));
		box.appendChild(el('pre', 'terminal-empty signals-hint', 'FIELD → A SIGNAL ON THE SCANNER'));
		return box;
	}

	let selected = data.places.find((p) => p.name === lastPlace) ?? data.places[0];
	const places = el('div', 'terminal-nav signals-places');
	const list = el('div', 'signals-list');
	box.appendChild(places);
	box.appendChild(list);

	const drawPlaces = () => {
		places.replaceChildren();
		for (const p of data.places) {
			if (places.children.length) places.appendChild(document.createTextNode(' · '));
			const b = screenButton(`${p.name} ${p.uplinked.length}/${p.total}`, () => {
				if (selected === p) return;
				selected = p;
				lastPlace = p.name;
				drawPlaces();
				drawList();
				places.querySelector('.on')?.focus();
			}, 'terminal-link');
			if (p === selected) b.classList.add('on');
			places.appendChild(b);
		}
	};

	const drawList = () => {
		list.replaceChildren();
		const rows = listRows(selected, clearance);
		for (const r of rows) {
			if (r.kind === 'uplinked') {
				const b = el('button', 'terminal-row signals-row');
				b.type = 'button';
				b.appendChild(el('span', 'signals-mark-up', '[+]'));
				b.appendChild(document.createTextNode(` ${fit(r.text, NAME_W)}  ${r.right}`));
				const i = selected.uplinked.findIndex((e) => e.id === r.id);
				b.onclick = () => onOpen(selected.uplinked, i);
				list.appendChild(b);
			} else if (r.kind === 'more') {
				list.appendChild(el('pre', 'signals-line signals-more', `    ${r.text}`));
			} else {
				const line = el('pre', `signals-line signals-${r.kind}`);
				line.appendChild(document.createTextNode('[?] '));
				line.appendChild(el('span', 'signals-scrambled', fit(r.text, NAME_W)));
				line.appendChild(document.createTextNode(`  ${r.right}`));
				list.appendChild(line);
			}
		}
	};

	drawPlaces();
	drawList();
	return box;
}

// One capture, opened (mockup dossier-v3.html, "ONE CAPTURE, OPENED"). Its
// own full-frame screen; PREVIOUS / NEXT walk `entries`. Resolves
// { live: [lat, lon], place } for FLY THERE, null for BACK / Escape.
export function runCapture(root, { api, entries, index = 0 }) {
	const s = mountScreen(root, { cls: 'terminal terminal-capture', boxCls: 'terminal-box' });
	let i = Math.max(0, Math.min(entries.length - 1, index));
	let shotUrl = null;
	let token = 0;
	let nav = null;
	const signalsP = knownSignals();

	const revoke = () => {
		if (shotUrl) URL.revokeObjectURL(shotUrl);
		shotUrl = null;
	};

	return new Promise((resolve) => {
		const done = (value) => {
			token++;
			revoke();
			nav?.detach();
			s.remove();
			resolve(value);
		};

		const render = (focusLabel = null) => {
			const mine = ++token;
			revoke();
			const entry = entries[i];
			const box = s.box;
			box.replaceChildren();
			box.appendChild(el('pre', 'capture-title', (entry.name || entry.id).toUpperCase()));
			const foot = el('pre', 'terminal-foot capture-foot', (entry.place ?? ELSEWHERE).toUpperCase());
			box.appendChild(foot);
			// The real place first, and large: its slot stays collapsed until (and
			// unless) Wikimedia gives a photo.
			const refSlot = el('div', 'capture-ref-slot');
			box.appendChild(refSlot);
			const credit = el('div', 'capture-credit');
			box.appendChild(credit);
			const facts = el('div', 'capture-sec');
			const kv = el('pre', 'capture-kv');
			facts.appendChild(kv);
			box.appendChild(facts);

			const own = detailRows(entry, null, null);
			const drawFacts = (rows) => {
				kv.replaceChildren();
				rows.forEach((row, k) => {
					if (k) kv.appendChild(document.createTextNode('\n'));
					if (!row) return;
					kv.appendChild(document.createTextNode(row[0].padEnd(KEY_W)));
					kv.appendChild(el('span', 'capture-v', row[1]));
				});
			};
			const drawCredit = (info) => {
				credit.replaceChildren();
				const c = creditOf(info);
				if (c) credit.appendChild(el('span', '', `${c.text} · `));
				credit.appendChild(el('span', '', DATA_CREDIT));
				if (c?.href) {
					credit.appendChild(document.createTextNode('  '));
					const a = el('a', 'capture-source', '[ SOURCE ]');
					a.href = c.href;
					a.target = '_blank';
					a.rel = 'noopener noreferrer';
					credit.appendChild(a);
				}
			};
			drawFacts(own);
			drawCredit(null);

			// What the machine saw: small, after the place.
			const seen = el('div', 'capture-sec');
			seen.appendChild(el('pre', 'capture-head', 'INTERCEPTED'));
			const shotSlot = el('div', 'capture-shot-slot');
			seen.appendChild(shotSlot);
			box.appendChild(seen);
			const noFrame = () => shotSlot.replaceChildren(el('pre', 'terminal-empty',
				entry.sessionId ? 'NO FRAME' : 'NO FRAME — CAPTURED WITHOUT A SESSION'));
			const caption = [own.find((r) => r?.[0] === 'MACHINE')?.[1], own[0][1], 'WHAT THE MACHINE SAW']
				.filter(Boolean).join(' · ');
			if (entry.sessionId && Number.isInteger(entry.photo)) {
				(async () => {
					let url = null;
					try { url = await api.fetchPhoto(entry.sessionId, entry.photo); } catch { url = null; }
					if (mine !== token) { if (url) URL.revokeObjectURL(url); return; }
					if (!url) { noFrame(); return; }
					shotUrl = url;
					const img = el('img', 'capture-shot');
					img.alt = '';
					img.src = url;
					shotSlot.replaceChildren(img, el('pre', 'capture-cap', caption));
				})();
			} else noFrame();

			const acts = el('div', 'terminal-acts');
			acts.appendChild(screenButton('FLY THERE',
				() => done({ live: [entry.lat, entry.lon], place: entry.place ?? null }), 'terminal-cta'));
			if (entries.length > 1) {
				const prev = screenButton('PREVIOUS', () => { i--; render('PREVIOUS'); }, 'terminal-cta');
				prev.disabled = i === 0;
				const next = screenButton('NEXT', () => { i++; render('NEXT'); }, 'terminal-cta');
				next.disabled = i === entries.length - 1;
				acts.append(prev, next);
			}
			acts.appendChild(screenButton('BACK', () => done(null), 'terminal-cta'));
			box.appendChild(acts);
			box.appendChild(el('pre', 'terminal-keys', '[ESC] BACK'));

			if (!nav) nav = menuNav(s.el, { back: () => done(null) });
			const target = [...acts.querySelectorAll('button')]
				.find((b) => !b.disabled && focusLabel && b.textContent === `[ ${focusLabel} ]`);
			(target ?? acts.querySelector('button')).focus();

			// The landmark's facts and photo: cached signals + Wikidata/Commons,
			// both allowed to fail (offline, rate-limited) — the capture is
			// readable without them.
			(async () => {
				const [signals, info] = await Promise.all([
					signalsP,
					Promise.resolve().then(() => sharedPlaceInfo().info(entry.id)).catch(() => null),
				]);
				if (mine !== token) return;
				const signal = signals.find((x) => x.id === entry.id) ?? null;
				if (info?.description) foot.textContent = info.description.toUpperCase();
				const refUrl = safeImageUrl(info?.photo?.url);
				if (refUrl) {
					const img = el('img', 'capture-ref');
					img.alt = '';
					img.decoding = 'async';
					img.onerror = () => { img.hidden = true; };
					img.src = refUrl;
					refSlot.replaceChildren(img);
				}
				drawCredit(info);
				drawFacts(detailRows(entry, signal, info));
			})();
		};

		render();
	});
}
