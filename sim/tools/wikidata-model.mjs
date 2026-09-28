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
	const p = new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'claims|descriptions', languages: 'en', languagefallback: '1', format: 'json', origin: '*' });
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
	? s.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (m) => {
		const lower = m.toLowerCase();
		if (ENTITIES[lower]) return ENTITIES[lower];
		if (m.startsWith('&#x')) {
			const n = Number.parseInt(m.slice(3, -1), 16);
			if (n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF)) return String.fromCodePoint(n);
			return '';
		}
		if (m.startsWith('&#')) {
			const n = Number(m.slice(2, -1));
			if (n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF)) return String.fromCodePoint(n);
			return '';
		}
		return '';
	})
	: null);

export function parseCommons(json) {
	const pages = json?.query?.pages;
	if (!pages || typeof pages !== 'object') return null;
	const info = Object.values(pages)[0]?.imageinfo?.[0];
	const url = safeImageUrl(info?.thumburl);
	if (!url) return null;
	const md = info.extmetadata ?? {};
	const descUrl = info?.descriptionurl;
	const page = (typeof descUrl === 'string' && descUrl.startsWith('https://commons.wikimedia.org/wiki/File:'))
		? descUrl
		: null;
	return {
		url,
		w: Number.isFinite(info.thumbwidth) ? info.thumbwidth : null,
		h: Number.isFinite(info.thumbheight) ? info.thumbheight : null,
		artist: clean(unhtml(md.Artist?.value), ARTIST_MAX),
		license: clean(md.LicenseShortName?.value, 30),
		page,
	};
}
