# Signals — Lot 2b: the card after UPLINKED — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signals work anywhere in the world, wild places included; and when a signal is UPLINKED, a card slides into the right column for ~6 s — the intercepted frame, the real photo of the place (Wikidata P18 via Wikimedia Commons, credited), its name, a short description and pictogram facts — and the end-of-flight screen recaps the flight's captures as small cards.

**Architecture:** Pure models decide (`tools/wikidata-model.mjs`: URLs + parsing; `tools/signal-card-model.mjs`: facts, credit, queue timing). One cached client fetches (`src/place-info.js`, injected fetch + IndexedDB like `src/signal-source.js`). One DOM layer draws (`src/signal-card.js`, in the FPVTP! OSD). The end screen gets a new timeline token `SIGNALS_LINE` next to `PORTRAIT_LINE` / `RANDOMART_LINE`. `main.js` wires it.

**Tech Stack:** ES modules, Node `assert/strict` selftests, Wikidata `wbgetentities` API, Commons `imageinfo` API (both with `origin=*` for CORS).

**Spec:** `sim/docs/superpowers/specs/2026-09-27-signals-design.md` §5 (DOSSIER / reference photo). Lot 2 is on this branch. Issue #185.

## Decisions taken with the author (2026-09-27)

- Real photo from **Wikidata P18** (49/50 of the top Paris landmarks have one; OSM tags: 2/50), served by Wikimedia Commons with author + licence. The author's earlier "OSM only for V1" is superseded for images and the short description.
- The card shows **in flight after UPLINKED AND as a recap at the end of the flight**.
- Layout **B**: a right-column card, ~250 px wide, stacked: intercepted frame (16:7 crop), real photo (4:3), name, description, 4 pictogram facts, credit line, a thin green timer bar. Mockup validated (brainstorm `signal-card.html`).
- Facts as **pictograms + labels** (the author's standing preference for player info screens).

## Global Constraints

- Worktree `/home/user/Documents/dev/FPVThePlanet-signals2`, branch `signals-lot2`. Paths relative to `sim/`.
- English code/comments/labels; a touched file leaves in English (translate the comments of what you touch; `src/flight-end.js` and `tools/flight-end-selftest.mjs` are French — translate the file headers and every comment/label you add or edit). `CHANGELOG.md` in French.
- Selftests: `node:assert/strict`, local `t(name, fn)` printing `  ok  <name>`. Only the touched modules' selftests; never `npm run selftest:ci`.
- External text (Wikidata, Commons, OSM) reaches the DOM only via `textContent` / `setAttribute('src', url)` after the URL is checked against an allowlist of hosts (`https://thumb.wikimedia.org/`, `https://upload.wikimedia.org/`). Commons `Artist` is HTML: strip tags, decode the few entities, cap 60 code points.
- A failure of Wikidata or Commons never blocks anything: the card shows without the reference photo / description.
- Colours: functional only (`--green` for the UPLINKED card border/title/timer). Spacing via `--space-*` tokens (palette-selftest).
- Commits end with a `Co-Authored-By:` trailer naming the model that wrote them.

## File Structure

| File | Responsibility |
|---|---|
| Modify `tools/signal-model.mjs` + selftest | Task 0: worldwide query (maxsize, temples, natural features). |
| Create `tools/wikidata-model.mjs` + `tools/wikidata-model-selftest.mjs` | URLs, entity parsing, Commons parsing, host allowlist. |
| Create `src/place-info.js` + `tools/place-info-selftest.mjs` | `createPlaceInfo({fetch, cache, now})` → `info(qid)`; memo, IndexedDB cache 30 d, `sharedPlaceInfo()`. |
| Modify `server/headers.mjs` + `tools/server-selftest.mjs` | CSP. |
| Create `tools/signal-card-model.mjs` + `tools/signal-card-selftest.mjs` | Facts, credit line, card queue timing. |
| Modify `src/pixel-icons.js` | Icons `calendar`, `height`, `heritage`, `landmark`. |
| Create `src/signal-card.js`; modify `src/style.css` | The DOM card and the recap node. |
| Modify `src/flight-end.js`, `tools/flight-end-selftest.mjs`, `src/fpvtp-osd.js` | `SIGNALS_LINE` token in the three timelines; rendering hook. |
| Modify `src/main.js`, `package.json`, `../CHANGELOG.md` | Wiring. |

---

### Task 0: Anywhere in the world, cities and wild places

The author (2026-09-27): "build it so it adapts to any city in the world — and not only cities, natural spaces too". Measured on real tiles the same day (controller probe, raw Overpass elements per z12 tile):

| Place | Current query | Point-like natural features with `wikidata` |
|---|---|---|
| Tokyo | **fails: "out of memory … needs at least 32 MB"** — our `[maxsize:4194304]` is a RAM cap, not an output cap | — (119 elements once maxsize is 64 MiB) |
| Skógafoss (Iceland) | **0** | 2 waterfalls (Skógafoss, Kvernufoss) |
| Yosemite | 35 | 43 — waterfalls (Vernal, Nevada Fall), cliffs, rocks, peaks, valleys |
| Lauterbrunnen | 21 | + Staubbachfall |
| Kyoto | 64 | temples/shrines are `building=temple|shrine` — not in our building list |

**Files:** `tools/signal-model.mjs`, `tools/signal-model-selftest.mjs`.

Changes (test-first):
1. `MAXSIZE = 64 * 1024 * 1024` with a comment: Overpass `maxsize` is the query's RAM budget; 4 MiB made dense cities (Tokyo) fail forever. Test: the query string contains `[maxsize:67108864]`.
2. Query clauses — keep the `wikidata` filter on every clause, and every clause point-like (a lake, a reserve or a national park is a polygon whose centre is not a place you can frame from 300 m — excluded on purpose):
   - `nwr["wikidata"]["building"~"^(cathedral|church|castle|temple|shrine|mosque|synagogue|pagoda|monastery)$"]`
   - `nwr["wikidata"]["natural"~"^(peak|volcano|arch|cave_entrance|rock|stone|cliff|geyser|hot_spring)$"]` (replaces the `natural=peak` clause)
   - `nwr["wikidata"]["waterway"="waterfall"]`
   Tests: the query matches each of these; it does not contain `natural=water`, `leisure=nature_reserve`, `boundary=national_park`.
3. `kindOf`: `waterway=waterfall` → `WATERFALL`; natural values → their uppercased name with `_` → space (`CAVE ENTRANCE`, `HOT SPRING`), before the building/historic fallbacks. `tierOf`: tier III for `peak`, `volcano`, `dam`, `bridge` (unchanged set + volcano); tier II adds `waterfall`, `cliff`, `arch`; the rest tier I. `rankOf`: MAJOR adds `volcano`, `waterfall`, `temple`, `shrine`, `mosque`, `pagoda`; MINOR adds `arch`, `geyser`, `cave_entrance`, `rock`, `cliff`, `synagogue`. Tests: a Skógafoss-like node (`waterway=waterfall`, wikidata, name) → kind `WATERFALL`, tier 2; a Kyoto-like temple way (`building=temple`, wikidata, name, `tourism=attraction`) outranks a plain `historic=memorial` node; a `natural=volcano` → tier 3.
4. Names outside the Latin script: `name:en` is already preferred; keep `name` as the fallback (the Japanese `阿弥陀ヶ峰` must survive `clean()` intact — test it; uppercasing leaves CJK unchanged).
5. `MODEL_VERSION = 3` (cached tiles were parsed with the old filter).

Commit: `Signals: anywhere in the world — Tokyo's tile no longer runs out of memory, waterfalls, cliffs, volcanoes and temples count (#185)`

---

### Task 1: Wikidata / Commons model

**Files:** Create `tools/wikidata-model.mjs`, `tools/wikidata-model-selftest.mjs`

**Interfaces — Produces:**
- `entityUrl(qid) -> string` — `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=<qid>&props=claims|descriptions&languages=en&format=json&origin=*`
- `parseEntity(json, qid) -> { description: string|null, image: string|null, year: number|null, heightM: number|null }` — `image` = P18 file name (preferred-rank first, else first normal), `year` from P571 (`+1758-00-00T…`, precision ≥ 9; negative years allowed), `heightM` from P2048 only when the unit is metre (`…/Q11573`), description `en`, capped 90 code points, control chars stripped.
- `commonsUrl(file, width = 480) -> string` — `https://commons.wikimedia.org/w/api.php?action=query&titles=File:<file>&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=<width>&iiextmetadatafilter=Artist|LicenseShortName&format=json&origin=*` (file URI-encoded).
- `parseCommons(json) -> { url, w, h, artist, license } | null` — `url` = `thumburl` only if it passes `safeImageUrl`; `artist` HTML-stripped.
- `safeImageUrl(u) -> string|null` — only `https://thumb.wikimedia.org/…` or `https://upload.wikimedia.org/…`.
- `qidOf(signalId) -> string|null` — `'wd:Q188856'` → `'Q188856'`.

- [ ] **Step 1: Failing test** — `tools/wikidata-model-selftest.mjs`:

```js
// Selftest of the Wikidata / Commons model (issue #185, lot 2b). Fixtures are
// trimmed from the real answers for the Panthéon (2026-09-27). No network.
// Run: node tools/wikidata-model-selftest.mjs
import assert from 'node:assert/strict';
import { entityUrl, parseEntity, commonsUrl, parseCommons, safeImageUrl, qidOf } from './wikidata-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ENTITY = { entities: { Q188856: {
	descriptions: { en: { language: 'en', value: 'mausoleum in Paris for the most distinguished French people' } },
	claims: {
		P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Panthéon, Paris 25 March 2012.jpg' } } }],
		P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+1758-00-00T00:00:00Z', precision: 9 } } } }],
		P2048: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+83', unit: 'http://www.wikidata.org/entity/Q11573' } } } }],
	},
} } };

const COMMONS = { query: { pages: { 38044545: { imageinfo: [{
	thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/58/Panth%C3%A9on%2C_Paris_25_March_2012.jpg/500px-Panth%C3%A9on%2C_Paris_25_March_2012.jpg',
	thumbwidth: 480, thumbheight: 326,
	extmetadata: {
		Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Trizek">Camille G&eacute;vaudan</a>' },
		LicenseShortName: { value: 'CC BY-SA 3.0' },
	},
}] } } } };

t('qidOf', () => {
	assert.equal(qidOf('wd:Q188856'), 'Q188856');
	assert.equal(qidOf('osm:way/1'), null);
	assert.equal(qidOf('wd:Q1;drop'), null);
});

t('entityUrl: CORS origin, the one id, claims + descriptions in English', () => {
	const u = new URL(entityUrl('Q188856'));
	assert.equal(u.origin, 'https://www.wikidata.org');
	assert.equal(u.searchParams.get('ids'), 'Q188856');
	assert.equal(u.searchParams.get('origin'), '*');
	assert.equal(u.searchParams.get('props'), 'claims|descriptions');
	assert.equal(u.searchParams.get('languages'), 'en');
});

t('parseEntity: the Panthéon', () => {
	assert.deepEqual(parseEntity(ENTITY, 'Q188856'), {
		description: 'mausoleum in Paris for the most distinguished French people',
		image: 'Panthéon, Paris 25 March 2012.jpg',
		year: 1758,
		heightM: 83,
	});
});

t('parseEntity: preferred rank wins, deprecated ignored, feet are not metres, BC years, garbage', () => {
	const e = { entities: { Q1: { claims: {
		P18: [
			{ rank: 'deprecated', mainsnak: { datavalue: { value: 'bad.jpg' } } },
			{ rank: 'normal', mainsnak: { datavalue: { value: 'normal.jpg' } } },
			{ rank: 'preferred', mainsnak: { datavalue: { value: 'best.jpg' } } },
		],
		P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '-0052-00-00T00:00:00Z', precision: 9 } } } }],
		P2048: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+300', unit: 'http://www.wikidata.org/entity/Q3710' } } } }],
	} } } };
	assert.deepEqual(parseEntity(e, 'Q1'), { description: null, image: 'best.jpg', year: -52, heightM: null });
	assert.deepEqual(parseEntity(null, 'Q1'), { description: null, image: null, year: null, heightM: null });
	assert.deepEqual(parseEntity({ entities: { Q1: { claims: 'x' } } }, 'Q1'), { description: null, image: null, year: null, heightM: null });
});

t('parseEntity: a decade/century precision is not a year', () => {
	const e = { entities: { Q1: { claims: { P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+1700-00-00T00:00:00Z', precision: 7 } } } }] } } } };
	assert.equal(parseEntity(e, 'Q1').year, null);
});

t('commonsUrl: the file title, the width, the two metadata fields, CORS', () => {
	const u = new URL(commonsUrl('Panthéon, Paris 25 March 2012.jpg', 480));
	assert.equal(u.origin, 'https://commons.wikimedia.org');
	assert.equal(u.searchParams.get('titles'), 'File:Panthéon, Paris 25 March 2012.jpg');
	assert.equal(u.searchParams.get('iiurlwidth'), '480');
	assert.equal(u.searchParams.get('iiextmetadatafilter'), 'Artist|LicenseShortName');
	assert.equal(u.searchParams.get('origin'), '*');
});

t('parseCommons: thumb URL, size, artist stripped of HTML, licence', () => {
	assert.deepEqual(parseCommons(COMMONS), {
		url: COMMONS.query.pages[38044545].imageinfo[0].thumburl,
		w: 480, h: 326,
		artist: 'Camille Gévaudan',
		license: 'CC BY-SA 3.0',
	});
	assert.equal(parseCommons(null), null);
	assert.equal(parseCommons({ query: { pages: { '-1': { missing: '' } } } }), null);
});

t('safeImageUrl: only the two Wikimedia image hosts, https', () => {
	assert.ok(safeImageUrl('https://upload.wikimedia.org/a.jpg'));
	assert.ok(safeImageUrl('https://thumb.wikimedia.org/a.jpg'));
	assert.equal(safeImageUrl('http://upload.wikimedia.org/a.jpg'), null);
	assert.equal(safeImageUrl('https://upload.wikimedia.org.evil.com/a.jpg'), null);
	assert.equal(safeImageUrl('javascript:alert(1)'), null);
	assert.equal(safeImageUrl(3), null);
	const bad = structuredClone(COMMONS);
	bad.query.pages[38044545].imageinfo[0].thumburl = 'https://evil.example/x.jpg';
	assert.equal(parseCommons(bad), null, 'no usable image, no card photo');
});

console.log(`wikidata-model: ${n} ok`);
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** — `tools/wikidata-model.mjs`:

```js
// The real photo and a few reliable facts of a signal (issue #185, lot 2b):
// Wikidata P18 / P571 / P2048 and the English description, the photo's thumb
// and credit from Wikimedia Commons. Pure — URLs and parsing only — checked
// in tools/wikidata-model-selftest.mjs. src/place-info.js does the fetching.
//
// Everything that comes back is data from strangers: text is stripped and
// capped here and rendered with textContent; an image URL is used only if it
// points at one of the two Wikimedia image hosts.

const TEXT_MAX = 90;
const ARTIST_MAX = 60;
const METRE = 'http://www.wikidata.org/entity/Q11573';

const clean = (v, max) => (typeof v === 'string'
	? (Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('') || null)
	: null);

export function qidOf(signalId) {
	const m = /^wd:(Q\d+)$/.exec(signalId ?? '');
	return m ? m[1] : null;
}

export function entityUrl(qid) {
	const p = new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'claims|descriptions', languages: 'en', format: 'json', origin: '*' });
	return `https://www.wikidata.org/w/api.php?${p}`;
}

// Preferred rank first, then normal; deprecated never.
function best(claims) {
	if (!Array.isArray(claims)) return null;
	const ok = claims.filter((c) => c && c.rank !== 'deprecated' && c.mainsnak?.datavalue);
	return (ok.find((c) => c.rank === 'preferred') ?? ok[0])?.mainsnak.datavalue.value ?? null;
}

export function parseEntity(json, qid) {
	const out = { description: null, image: null, year: null, heightM: null };
	const e = json?.entities?.[qid];
	if (!e || typeof e !== 'object') return out;
	out.description = clean(e.descriptions?.en?.value, TEXT_MAX);
	const c = e.claims && typeof e.claims === 'object' && !Array.isArray(e.claims) ? e.claims : {};
	const img = best(c.P18);
	if (typeof img === 'string' && img.trim()) out.image = img.trim();
	const inc = best(c.P571);
	if (inc && typeof inc.time === 'string' && inc.precision >= 9) {
		const m = /^([+-])(\d+)-/.exec(inc.time);
		if (m) out.year = (m[1] === '-' ? -1 : 1) * Number(m[2]);
	}
	const h = best(c.P2048);
	if (h && h.unit === METRE) {
		const v = Number(h.amount);
		if (Number.isFinite(v) && v > 0) out.heightM = v;
	}
	return out;
}

export function commonsUrl(file, width = 480) {
	const p = new URLSearchParams({
		action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata',
		iiurlwidth: String(width), iiextmetadatafilter: 'Artist|LicenseShortName', format: 'json', origin: '*',
	});
	return `https://commons.wikimedia.org/w/api.php?${p}`;
}

const IMAGE_HOSTS = ['https://thumb.wikimedia.org/', 'https://upload.wikimedia.org/'];
export function safeImageUrl(u) {
	if (typeof u !== 'string') return null;
	return IMAGE_HOSTS.some((h) => u.startsWith(h)) ? u : null;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&eacute;': 'é', '&egrave;': 'è', '&agrave;': 'à', '&ccedil;': 'ç' };
const unhtml = (s) => (typeof s === 'string'
	? s.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? (m.startsWith('&#') ? String.fromCodePoint(Number(m.slice(2, -1))) : ''))
	: null);

export function parseCommons(json) {
	const pages = json?.query?.pages;
	if (!pages || typeof pages !== 'object') return null;
	const info = Object.values(pages)[0]?.imageinfo?.[0];
	const url = safeImageUrl(info?.thumburl);
	if (!url) return null;
	const md = info.extmetadata ?? {};
	return {
		url,
		w: Number.isFinite(info.thumbwidth) ? info.thumbwidth : null,
		h: Number.isFinite(info.thumbheight) ? info.thumbheight : null,
		artist: clean(unhtml(md.Artist?.value), ARTIST_MAX),
		license: clean(md.LicenseShortName?.value, 30),
	};
}
```

- [ ] **Step 4: Green** — `node tools/wikidata-model-selftest.mjs` → `wikidata-model: 8 ok`.
- [ ] **Step 5: Commit** — `Signals: the real photo and facts of a place — the Wikidata/Commons model (#185)`

---

### Task 2: The place-info client, and the CSP

**Files:** Create `src/place-info.js`, `tools/place-info-selftest.mjs`; modify `server/headers.mjs` (CSP + its comment), `tools/server-selftest.mjs` (assertions), `package.json` (chain `wikidata-model`, `place-info`, `signal-card` selftests after `signal-callout-selftest` — `signal-card` is created in Task 3; add it then).

**Interfaces — Produces:**
- `PLACE_TTL_MS = 30 days`, `PLACE_VERSION = 1`
- `createPlaceInfo({ fetch, cache = memoryCache(), now = Date.now })` → `{ info(qid): Promise<Info|null> }` where `Info = { description, year, heightM, photo: { url, w, h, artist, license } | null }`. Same qid while in flight → same promise. Cache hit (`v === PLACE_VERSION`, fresh) → no fetch. Entity fetch fails → resolves `null` (not cached). Entity OK but Commons fails → `photo: null`, cached (the facts are still worth keeping) — but NOT cached if the entity had an image and Commons failed (retry later). No image → `photo: null`, cached.
- `sharedPlaceInfo()` — one per page, IndexedDB cache `fpvtp-places` (reuse `idbCache(name)` from `src/signal-source.js` — export it if it is not), fetch with `AbortSignal.timeout(15_000)`.

Tests (write them first, fake fetch returning the Task 1 fixtures by URL origin): two concurrent `info('Q188856')` → one entity fetch + one Commons fetch, same object; a second `info` after resolution → no fetch; entity 500 → `null`, then a later call retries; entity OK + Commons throws → `photo: null` and a later call retries Commons (not cached); entity without P18 → `photo: null`, no Commons fetch, cached; stale `v` → refetch; malformed qid → `null` with no fetch.

CSP (`server/headers.mjs`): `connect-src` + `https://www.wikidata.org https://commons.wikimedia.org`; `img-src` + `https://thumb.wikimedia.org https://upload.wikimedia.org`. Update the comment block above `CSP` accordingly. `tools/server-selftest.mjs`: assert both additions next to the existing Overpass assertion.

Commit: `Signals: place info from Wikidata, cached, and the CSP that lets it in (#185)`

---

### Task 3: The card — model, icons, DOM

**Files:** Create `tools/signal-card-model.mjs`, `tools/signal-card-selftest.mjs`, `src/signal-card.js`; modify `src/pixel-icons.js`, `src/style.css`, `package.json` (chain `signal-card-selftest`).

**Interfaces — Produces:**
- `tools/signal-card-model.mjs`:
  - `CARD_S = 6`, `MAX_FACTS = 4`
  - `cardFacts(signal, info) -> Array<{ icon, text }>` in this order, only those known, at most `MAX_FACTS`: `landmark` + `signal.kind`; `calendar` + year (Wikidata `info.year`, else the OSM `BUILT` field value; negative year → `52 BC`); `height` + `${Math.round(m)} M` (Wikidata, else OSM `HEIGHT`); `heritage` + the OSM `STATUS` field value.
  - `creditLine(info) -> string|null` — `PHOTO © <ARTIST> · <LICENSE> · WIKIMEDIA COMMONS` (artist `UNKNOWN` when null), or null without a photo. The data line `DATA © OSM · WIKIDATA` is always shown separately by the DOM.
  - `class CardQueue` — `push(card)`, `update(dt) -> { current, remaining01 }`: shows each card `CARD_S` seconds (remaining01 1 → 0), then the next; a new card while one shows waits its turn; `dt <= 0` freezes.
- `src/pixel-icons.js`: add `calendar`, `height`, `heritage`, `landmark` (12×12, the grids from the validated mockup; `tools/pixel-icons-selftest.mjs` must stay green — it checks 12×12 and the lit-pixel bounds).
- `src/signal-card.js`: `class SignalCard(root)` — `render(view | null)` with `view = { signal, info, frameSrc, remaining01, index, total, distM, holdS }`; builds once, updates text/`src` only on change; `recapNode(entries) -> HTMLElement | null` (entries = the flight's uplinks `{ signal, info, frameSrc, distM, holdS }`; null when none) — a titled grid (`N SIGNALS UPLINKED`) of small cards without the timer. Every text via `textContent`; `img.src` only from `frameSrc` (a `data:image/jpeg` URL produced by our own capture — check the prefix) or `safeImageUrl(info.photo.url)`.
- `src/style.css`: layout B from the mockup (right column, ~250 px, `--green` border, 16:7 frame crop, 4:3 photo, 13 px name, 11 px description, facts row with icons, 9 px credit, 2 px timer bar) and the recap grid (3 columns, wraps). Tokens only for spacing.

Tests (`tools/signal-card-selftest.mjs`, first): `cardFacts` for the Panthéon (kind MAUSOLEUM-like from the signal, 1758, 83 M, status) — Wikidata wins over OSM for year/height; OSM fallbacks; cap at 4; BC year text; `creditLine` with/without artist and without photo; `CardQueue`: one card 6 s then empty; two pushed → second starts when the first ends; `dt 0` freezes.

Commit: `Signals: the UPLINKED card — the intercepted frame, the real place, pictogram facts (#185)`

---

### Task 4: The recap on the end-of-flight screen

**Files:** Modify `src/flight-end.js`, `tools/flight-end-selftest.mjs`, `src/fpvtp-osd.js`.

- `src/flight-end.js`: export `SIGNALS_LINE = '[SIGNALS]'`; add `[t, SIGNALS_LINE]` right after each `RANDOMART_LINE` entry in `TIMELINE`, `FENCE_TIMELINE` and `CUT_TIMELINE` (same `t` as the randomart line). `tools/flight-end-selftest.mjs`: assert the token is present once in each timeline, right after RANDOMART_LINE (adapt any test that counts lines).
- `src/fpvtp-osd.js`: `setSignalRecap(fn)` stores a provider `() => HTMLElement | null`; in `setFlightEnd`, `SIGNALS_LINE` renders `fn?.()` and falls back to an empty div (never the token), exactly like `PORTRAIT_LINE`. The recap must not be rebuilt every frame (the existing `key` check already guarantees it).

Commit: `Signals: the end of a flight recaps what the machine uplinked (#185)`

---

### Task 5: Wiring, verification, changelog

**Files:** `src/main.js`, `package.json`, `../CHANGELOG.md`.

- Construct `signalCard = new SignalCard(document.getElementById('fpvtp-osd'))` next to `signalCallout`; `const cardQueue = new CardQueue();` `let flightUplinks = [];`
- Prefetch: when `SignalCapture.out.focus` changes to a non-null id, call `sharedPlaceInfo().info(qidOf(id))` (memoised — calling it every frame is harmless but do it on change).
- `uplinkFrame(id)`: keep the `dataUrl` it already builds (`data:image/jpeg`); after the capture, `const info = await sharedPlaceInfo().info(qidOf(id)).catch(() => null)` bounded by a 2.5 s race (then `null`), push `{ signal, info, frameSrc: dataUrl, distM, holdS }` to `flightUplinks` and to `cardQueue`. If the capture itself failed (no `cap`), still push with `frameSrc: null` so the card shows.
- Per frame (when flying or not — the card may finish after a crash? No: hide it when `flightEnd.phase !== FLYING`, the recap takes over): `const q = cardQueue.update(frozen ? 0 : dt); signalCard.render(q.current ? { ...q.current, remaining01: q.remaining01, index, total: flightSignals.length } : null)`.
- `fpvtpOsd.setSignalRecap(() => signalCard.recapNode(flightUplinks))` once; `disarmSignals()` clears `flightUplinks` and the queue AFTER the end screen has consumed it — i.e. clear them in `armSignals()` (start of the next flight), not in `disarmSignals()`.
- Browser check (dev server; chrome-devtools MCP with `isolatedContext`; `navigator.getGamepads = () => []` after each navigation; the DEV `window.__signals` handle may set the pose): LIVE at Les Invalides → capture the Panthéon or the Dôme → the card shows ~6 s with both images and the credit; a second capture queues; crash → the end screen shows the recap with the captures; console: no CSP report for wikidata/commons/thumb. Screenshots to the lot's `shots/`. Stop the server.
- `package.json`: chain `wikidata-model`, `place-info`, `signal-card` selftests.
- `CHANGELOG.md` (`### Ajouté`, after the lot 2 entry):

```markdown
- **La fiche d'un lieu capturé.** Après `UPLINKED`, une fiche s'affiche
  quelques secondes dans la colonne droite : l'image interceptée, la vraie
  photo du lieu (Wikidata, Wikimedia Commons, auteur et licence crédités), une
  description courte et ses repères en pictogrammes. En fin de vol, l'écran
  récapitule les lieux transmis par la machine. Plus de lieux aussi (60 par
  tuile, 3 km autour du décollage) et une capture plus tolérante (cône de 20°,
  5 s).
```

Commit: `Signals: the card after UPLINKED and the recap, in flight (#185)`

## Out of scope

- Storing the Wikidata info in the operator state (it is re-fetchable by id and cached 30 days) — lot 3's DOSSIER will decide.
- A French description (Wikidata `fr` is often generic: "monument historique français").
