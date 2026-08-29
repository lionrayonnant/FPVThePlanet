// Logique pure du GLOBAL SCANNER (PHASE 03). Aucune E/S, aucun DOM, aucune
// dépendance Node : importable par src/scanner.js (navigateur) et par le
// selftest. Tout le texte rendu ici part à l'écran, donc en anglais (D5).

import {
	latticeEdges, intersectBox, tileGrid, boxDimensions, tileSizeMeters,
	polygonGrid, maskOutline, polygonBounds, polygonArea, polygonProbePoint,
} from './lib/tiles.mjs';

export {
	latticeEdges, intersectBox, tileGrid, boxDimensions, tileSizeMeters,
	polygonGrid, maskOutline, polygonBounds, polygonArea, polygonProbePoint,
};

// ---------------------------------------------------------------- formats

const NF = new Intl.NumberFormat('en-US');
export const num = (n) => NF.format(Math.round(n));

// Décimal (1 GB = 1e9), comme tools/terminal-model.mjs : c'est la même Home.
export function bytes(n) {
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
	if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
	return `${Math.round(n)} B`;
}

// Ordre de grandeur volontairement grossier : les fourchettes de tuiles vont du
// simple au triple, annoncer « 12 min 34 s » serait mentir.
export function duration(s) {
	if (!Number.isFinite(s) || s < 0) return '—';
	if (s < 45) return '< 1 MIN';
	if (s < 3600) return `~${Math.round(s / 60)} MIN`;
	const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
	return m ? `~${h} H ${m} MIN` : `~${h} H`;
}

// Chronomètre d'acquisition : lui est exact, c'est une mesure.
export function elapsed(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} S` : `${Math.floor(s / 60)} MIN ${String(s % 60).padStart(2, '0')} S`;
}

export function bar(level, width = 12) {
	const n = Math.max(0, Math.min(width, Math.round(level * width)));
	return '█'.repeat(n) + '░'.repeat(width - n);
}

// ---------------------------------------------------------------- AREA ANALYSIS
//
// Le bloc §8 de la Bible, rempli avec la réponse de /__map-api/describe — donc
// avec la vraie grille et les vraies estimations, jamais avec un chiffre inventé.
export function areaAnalysis(d) {
	if (!d) return null;
	const { grid, estimate: e, dimensions, tileMeters } = d;
	return {
		// Sur un tracé libre, « cols × rows » serait l'emprise, pas ce qu'on
		// balaie : on annoncerait 1 350 tuiles là où on n'en demande que 732, et
		// l'économie — toute la raison d'être du polygone — resterait invisible.
		tiles: grid.masked
			? `${num(grid.columns)} / ${num(grid.cols * grid.rows)}`
			: `${grid.cols} × ${grid.rows}`,
		columns: num(grid.columns),
		requests: num(e.probes),
		surface: `${(dimensions.area / 1e6).toFixed(2)} km²`,
		span: `${num(dimensions.width)} × ${num(dimensions.height)} m`,
		tileSide: `${tileMeters.toFixed(0)} m`,
		data: bytes(e.prepBytes),
		dataRange: `${bytes(e.prepBytesRange[0])} – ${bytes(e.prepBytesRange[1])}`,
		download: bytes(e.rawBytes),
		time: duration(e.totalSeconds),
		heavy: e.warn === true,
	};
}

// ---------------------------------------------------------------- SIGNAL DENSITY
//
// §6 : la carte ne montre pas des drones, elle montre de l'activité radio
// estimée. L'estimation n'est pas un tirage aléatoire déguisé — elle part de ce
// qu'OSM dit réellement du centre de la zone (Nominatim reverse),
// multiplié par la surface réelle de la zone. Deux opérateurs qui sondent la
// même zone lisent donc le même chiffre, et Tokyo ne rend pas la même chose
// qu'un plateau agricole.
//
// Les densités au km² sont de la fiction assumée (aucune donnée publique ne
// donne « des drones au km² ») ; leur ORDRE relatif, lui, suit la densité de
// bâti réelle des catégories OSM. La génération de cibles reste PHASE 7 : ici
// on n'affiche qu'une fourchette.
// Densités de drones au km², par catégorie OSM. Ces valeurs sont de la fiction
// assumée — aucune donnée publique ne donne « des drones au km² ». Leur ORDRE,
// lui, suit la densité de bâti réelle des catégories : une métropole au-dessus
// d'un bourg, un bourg au-dessus d'un champ.
const DENSITY = {
	city: 60, borough: 45, suburb: 34, quarter: 30, town: 30, neighbourhood: 26,
	village: 12, hamlet: 5, isolated_dwelling: 3, farm: 3, allotments: 6,
	residential: 28, commercial: 24, retail: 24, industrial: 20,
	building: 34, house: 30, apartments: 34, amenity: 22, tourism: 20, historic: 20, leisure: 14,
	road: 18, highway: 18, railway: 14, aeroway: 8, aerodrome: 8, harbour: 10,
	city_district: 34, district: 26, municipality: 24, locality: 10, island: 6, islet: 3,
	administrative: 10, boundary: 10, postcode: 14,
	farmland: 2, meadow: 2, forest: 1, wood: 1, natural: 2, peak: 2,
	water: 1, waterway: 1, bay: 1, beach: 3, sea: 1,
};

const UNKNOWN_DENSITY = 8;   // « on ne sait pas » : ni désert, ni métropole.
const FULL_SCALE = 70;       // densité au-delà de laquelle la barre est pleine.

// Nominatim rend `addresstype` (« city », « neighbourhood », « building »…),
// `type` et `category` — et `format=jsonv2` nomme `category` ce que `format=json`
// appelait `class`. On essaie les jetons du plus spécifique au plus vague : c'est
// `addresstype` qui distingue Tokyo d'un hameau, `category` rend « boundary »
// pour les deux.
function densityOf(place) {
	for (const token of [place?.addresstype, place?.type, place?.category, place?.class]) {
		const k = String(token ?? '').toLowerCase();
		if (k && DENSITY[k] !== undefined) return { perKm2: DENSITY[k], token: k };
	}
	return { perKm2: UNKNOWN_DENSITY, token: null };
}

// `place` : une réponse Nominatim (search ou reverse), ou null quand la
// recherche est indisponible — auquel cas on le dit (`known: false`) plutôt que
// d'afficher un chiffre qui aurait l'air sûr.
export function signalDensity({ place, areaKm2 }) {
	const { perKm2, token } = densityOf(place);
	const known = token !== null;
	const source = known ? token.replace(/_/g, ' ').toUpperCase() : 'UNSURVEYED';

	const area = Number.isFinite(areaKm2) && areaKm2 > 0 ? areaKm2 : 0;
	// Sans zone il n'y a rien à estimer : une barre pleine « MODERATE » avant
	// même d'avoir dessiné serait un chiffre sorti de nulle part.
	if (area === 0) {
		return { known, perKm2, level: 0, label: '—', bar: bar(0, 10), range: [0, 0], targets: '—', source };
	}

	const mid = perKm2 * area;
	// Fourchette large assumée : ce sont des estimations, pas des vérités
	// omniscientes (§6). Plancher à 0 pour ne jamais annoncer « ~-2 ».
	const lo = Math.max(0, Math.floor(mid * 0.65));
	const hi = Math.max(lo, Math.ceil(mid * 1.4));

	// Échelle log : entre 1 et 70 drones/km² il y a un facteur 70, une échelle
	// linéaire collerait tout le monde à gauche.
	const level = Math.max(0, Math.min(1, Math.log(perKm2) / Math.log(FULL_SCALE)));

	return {
		known, perKm2, level,
		label: level < .34 ? 'LOW' : level < .67 ? 'MODERATE' : 'HIGH',
		bar: bar(level, 10),
		range: [lo, hi],
		targets: lo === hi ? `~${lo}` : `~${lo}–${hi}`,
		source,
	};
}

// ---------------------------------------------------------------- couverture
//
// Verdict de couverture Flyover en langage du jeu. `plan` vient de
// /__map-api/plan, `probe` de /__map-api/probe.
export function coverageLine({ plan, probe }) {
	if (probe) {
		const label = { ok: 'PHOTOGRAMMETRY CONFIRMED', undecodable: 'COVERED / UNREADABLE', none: 'NO COVERAGE' }[probe.status] ?? 'UNKNOWN';
		// Le message du serveur est en français : il sert la GUI d'extraction, pas
		// le jeu. On reformule à partir des compteurs, qui eux sont des mesures.
		const detail = {
			ok: `${num(probe.exported ?? 0)} tiles came back at the centre of the area. Flyover has real photogrammetry here.`,
			undecodable: `${num(probe.undecodable ?? 0)} tiles came back but the C3M parser cannot decode them. Covered, unusable.`,
			none: 'Nothing came back at the centre of the area. Flyover most likely has no photogrammetry here.',
		}[probe.status] ?? probe.message;
		return { status: probe.status, label, detail };
	}
	if (plan) {
		if (plan.columns === 0) {
			return {
				status: 'none', label: 'OUTSIDE REGION',
				detail: `Region "${plan.trigger}" declares no coverage here: all ${num(plan.pruned)} columns fall outside it.`,
			};
		}
		const detail = plan.pruned > 0
			? `Region "${plan.trigger}" — ${num(plan.columns)} columns inside its extent, ${num(plan.pruned)} pruned.`
			: `Region "${plan.trigger}" — ${num(plan.columns)} columns inside its extent.`;
		return { status: 'planned', label: 'REGION FOUND', detail };
	}
	return { status: 'unprobed', label: 'UNPROBED', detail: 'Flyover only serves photogrammetry over a list of cities. Probe before acquiring.' };
}

// La part de la zone scannée que la région Flyover déclare NE PAS couvrir.
// Emprise de région = rectangle en coordonnées de tuiles (cf. printPlan dans
// cmd/export-obj/main.go), donc l'élagage est une intersection de rectangles :
// rien à inventer. `null` quand il n'y a rien à griser ou rien à en dire.
export function prunedBands(plan) {
	if (!plan?.coverage?.ok || !plan.scan) return null;
	const scan = plan.scan, cov = plan.coverage;
	const keep = intersectBox(scan, cov);
	if (!keep) return { full: true, bands: [scan] };
	const bands = [];
	if (keep.north < scan.north) bands.push({ south: keep.north, north: scan.north, west: scan.west, east: scan.east });
	if (keep.south > scan.south) bands.push({ south: scan.south, north: keep.south, west: scan.west, east: scan.east });
	if (keep.west > scan.west) bands.push({ south: keep.south, north: keep.north, west: scan.west, east: keep.west });
	if (keep.east < scan.east) bands.push({ south: keep.south, north: keep.north, west: keep.east, east: scan.east });
	return bands.length ? { full: false, bands } : null;
}

// ---------------------------------------------------------------- désignation
//
// Doit rester en phase avec slugify() de tools/lib/add-map-core.mjs : c'est cet
// identifiant que le scanner annonce avant d'acquérir. Le selftest compare les
// deux implémentations plutôt que de faire confiance à ce commentaire.
const LIGATURES = { œ: 'oe', Œ: 'oe', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o', ß: 'ss', đ: 'd', ł: 'l', Ł: 'l', ð: 'd', þ: 'th' };
export function slugify(n) {
	return String(n).replace(/[œŒæÆøØßđłŁðþ]/g, (c) => LIGATURES[c])
		.normalize('NFD').replace(/[̀-ͯ]/g, '')
		.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Nom par défaut d'une zone à partir d'un résultat Nominatim : « TOKYO », pas
// « Tokyo, Japan, 100-0001 ».
export function designationFrom(hit) {
	const raw = hit?.name || String(hit?.display_name ?? '').split(',')[0] || '';
	return raw.trim();
}

// ---------------------------------------------------------------- acquisition

// `prep` reste accepté pour compatibilité (anciens jobs déjà en vol avant le
// découpage decode/rebuild), mais addMap() n'émet plus que decode/rebuild.
const PHASE_LABEL = { download: 'FETCH', decode: 'DECODE', rebuild: 'REBUILD', prep: 'REBUILD' };
export const phaseLabel = (p) => PHASE_LABEL[p] ?? String(p ?? '').toUpperCase();

// Avancement de l'acquisition. Pendant le téléchargement on connaît le compteur
// de tuiles et une estimation de la cible : le rapport est honnête tant qu'on ne
// dépasse pas 99 %. Pendant la conversion, le pipeline ne rend pas de compteur —
// la barre passe indéterminée plutôt que de mentir.
function fetchRatio(hits, expected) {
	const e = Number(expected) > 0 ? Number(expected) : 0;
	const h = Number(hits) || 0;
	return { indeterminate: e === 0, ratio: e ? Math.min(.99, h / e) : 0 };
}

export function acquisitionProgress({ phase, hits, expected }) {
	if (phase === 'prep') return { indeterminate: true, ratio: 1, text: `${num(hits ?? 0)} TILES` };
	const { indeterminate, ratio } = fetchRatio(hits, expected);
	const e = Number(expected) > 0 ? Number(expected) : 0;
	const h = Number(hits) || 0;
	return { indeterminate, ratio, text: e ? `${num(h)} / ~${num(e)} TILES` : `${num(h)} TILES` };
}

// ------------------------------------------------- barres FETCH/DECODE/REBUILD
//
// Les trois étapes réellement émises par addMap() (voir parsePrepLine dans
// lib/add-map-core.mjs). FETCH a un vrai compteur de tuiles ; REBUILD a un vrai
// compteur de chunks (chaque chunk loggue sa fin) ; DECODE, lui, n'a aucun
// signal intermédiaire dans le flux actuel de prep.mjs — une seule passe de
// lecture, sans jalon avant la fin — donc sa barre reste honnêtement
// indéterminée, comme le fait déjà acquisitionProgress pour la conversion.
const STAGES = ['download', 'decode', 'rebuild'];

function stageBar(name, phase, pipeline) {
	const i = STAGES.indexOf(name), at = STAGES.indexOf(phase);
	if (at < 0) return { indeterminate: false, ratio: 0 };
	if (i < at) return { indeterminate: false, ratio: 1 };     // étape passée
	if (i > at) return { indeterminate: false, ratio: 0 };     // pas commencée
	if (name === 'download') return fetchRatio(pipeline?.hits, pipeline?.expected);
	if (name === 'rebuild') {
		const planned = pipeline?.chunksPlanned ?? 0;
		return planned ? { indeterminate: false, ratio: Math.min(.99, (pipeline?.chunksDone ?? 0) / planned) } : { indeterminate: true, ratio: 0 };
	}
	return { indeterminate: true, ratio: 0 };                  // decode : pas de jalon intermédiaire
}

// `pipeline` : accumulateur serveur (voir mergeStat dans map-api-plugin.mjs) —
// chunksPlanned/chunksDone/etc. `hits`/`expected` restent séparés car ils
// viennent du flux `progress`, pas de `stat`.
export function pipelineBars({ phase, hits, expected, pipeline }) {
	const p = { ...pipeline, hits, expected };
	const fetch = stageBar('download', phase, p);
	const decode = stageBar('decode', phase, p);
	const rebuild = stageBar('rebuild', phase, p);
	const at = STAGES.indexOf(phase);
	// TERRAIN : composite honnête — une étape franchie compte pour 1, l'étape en
	// cours compte pour sa propre fraction connue (ou une balayante indéterminée).
	const active = at < 0 ? null : [fetch, decode, rebuild][at];
	const terrain = at < 0
		? { indeterminate: true, ratio: 0 }
		: { indeterminate: false, ratio: Math.min(.99, (at + (active.indeterminate ? .5 : active.ratio)) / STAGES.length) };
	return { terrain, fetch, decode, rebuild };
}

// ------------------------------------------------------------ statistiques
//
// Chiffres réels tirés du stdout de prep.mjs (voir parsePrepLine) : géométrie,
// textures, collision. N'affiche que ce qui est déjà connu — rien n'est
// pré-rempli à zéro tant que la ligne correspondante n'est pas encore sortie.
export function pipelineStats(pipeline) {
	const p = pipeline ?? {};
	const lines = [];
	if (p.materials != null) {
		lines.push(['MATERIALS', p.materialsNoTexture ? `${num(p.materials)} (${num(p.materialsNoTexture)} untextured)` : num(p.materials)]);
	}
	if (p.vertices != null) lines.push(['GEOMETRY', `${num(p.vertices)} verts, ${num(p.triangles)} tris`]);
	if (p.chunksPlanned != null) lines.push(['CHUNKS', `${num(p.chunksDone ?? 0)} / ${num(p.chunksPlanned)}`]);
	if (p.textureBytes != null) lines.push(['TEXTURES', `${num(p.textureSheets ?? 0)} sheets, ${bytes(p.textureBytes)}`]);
	if (p.collisionBytes != null) lines.push(['COLLISION', `${num(p.collisionTris ?? 0)} tris, ${bytes(p.collisionBytes)}`]);
	return lines;
}
