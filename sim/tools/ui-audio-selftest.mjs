// Selftest du modèle sonore d'interface (PHASE 18). Aucune E/S, aucun DOM,
// aucune Web Audio. Lancer : node tools/ui-audio-selftest.mjs
import assert from 'node:assert/strict';
import {
	UI_EVENTS, UI_FAMILY, BOOT_SIGNATURE,
	LINK_LOST_AT, LINK_BACK_AT, LINK_MIN_GAP_S,
	newLinkState, linkEvent,
	VOICES, PERCUSSIVE, RITUAL_SCORES, scoreFor,
} from './ui-audio-model.mjs';
import { HACK_TYPES } from './target-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- vocabulaire clos ------------------------------------------------------

t('UI_EVENTS : exactement les sept événements de la spec', () => {
	assert.deepEqual(UI_EVENTS, [
		'BOOT', 'TERRAIN_READY', 'TARGET_FOUND', 'ERROR',
		'LINK_LOST', 'LINK_RESTORED', 'RITUAL',
	]);
});

t('UI_FAMILY : chaque événement a une famille, et seulement les trois de §34', () => {
	assert.deepEqual(Object.keys(UI_FAMILY).sort(), [...UI_EVENTS].sort());
	for (const e of UI_EVENTS) {
		assert.ok(['SYSTEM', 'LINK', 'RITUAL'].includes(UI_FAMILY[e]), e);
	}
	assert.equal(UI_FAMILY.LINK_LOST, 'LINK');
	assert.equal(UI_FAMILY.LINK_RESTORED, 'LINK');
	assert.equal(UI_FAMILY.RITUAL, 'RITUAL');
});

// --- signature de boot -----------------------------------------------------

t('BOOT_SIGNATURE : cinq notes, tututuuut tuuuuu-tuu', () => {
	assert.equal(BOOT_SIGNATURE.length, 5);
	for (const note of BOOT_SIGNATURE) {
		assert.ok(note.freq > 200 && note.freq < 5000, `hors bande ESC : ${note.freq}`);
		assert.ok(note.durS > 0.02 && note.durS < 0.6, `durée invraisemblable : ${note.durS}`);
	}
});

t('BOOT_SIGNATURE : deux groupes séparés par un seul vrai silence', () => {
	const gaps = [];
	for (let i = 1; i < BOOT_SIGNATURE.length; i++) {
		const prev = BOOT_SIGNATURE[i - 1];
		gaps.push(BOOT_SIGNATURE[i].atMs - (prev.atMs + prev.durS * 1000));
	}
	// Un unique écart > 150 ms : c'est lui qui sépare `tututuuut` de `tuuuuu-tuu`.
	assert.equal(gaps.filter((g) => g > 150).length, 1);
	assert.ok(gaps.every((g) => g >= 0), 'les notes ne se chevauchent pas');
});

t('BOOT_SIGNATURE : rythme court/court/tenu · tenu/court', () => {
	const [a, b, c, d, e] = BOOT_SIGNATURE.map((x) => x.durS);
	assert.ok(c > a * 2 && c > b * 2, 'la 3e note est tenue');
	assert.ok(d > e * 2, 'la 4e est tenue, la 5e est courte');
});

t('BOOT_SIGNATURE : le triolet monte', () => {
	assert.ok(BOOT_SIGNATURE[0].freq < BOOT_SIGNATURE[1].freq);
	assert.ok(BOOT_SIGNATURE[1].freq < BOOT_SIGNATURE[2].freq);
});

// --- hystérésis du lien ----------------------------------------------------

// Fait passer une trace de qualités dans linkEvent et rend la liste des
// annonces. dtS fixe = une frame à 60 Hz sauf indication contraire.
const run = (qualities, dtS = 1 / 60) => {
	const st = newLinkState();
	const out = [];
	for (const q of qualities) {
		const e = linkEvent(q, dtS, st);
		if (e) out.push(e);
	}
	return out;
};

t('linkEvent : seuils repris de link.js, pas re-choisis', () => {
	assert.equal(LINK_LOST_AT, 0.10);
	assert.equal(LINK_BACK_AT, 0.30);
});

t('linkEvent : un lien plein ne dit rien', () => {
	assert.deepEqual(run(Array(600).fill(1)), []);
});

t('linkEvent : une chute franche annonce LINK_LOST une seule fois', () => {
	const trace = [...Array(60).fill(1), ...Array(300).fill(0.02)];
	assert.deepEqual(run(trace), ['LINK_LOST']);
});

t('linkEvent : perte puis retour annonce les deux, dans l\'ordre', () => {
	const trace = [
		...Array(60).fill(1),
		...Array(300).fill(0.02),   // 5 s perdu : le temps de garde est passé
		...Array(300).fill(0.9),
	];
	assert.deepEqual(run(trace), ['LINK_LOST', 'LINK_RESTORED']);
});

t('linkEvent : pas de LINK_RESTORED sans LINK_LOST avant lui', () => {
	// Descend jusque dans la bande morte SANS franchir LINK_LOST_AT, puis remonte.
	const trace = [...Array(60).fill(1), ...Array(120).fill(0.15), ...Array(120).fill(0.9)];
	assert.deepEqual(run(trace), []);
});

t('linkEvent : un plateau tenu sur la frontière ne bégaie pas', () => {
	// Oscille entre les deux seuils sans jamais les franchir.
	const trace = [];
	for (let i = 0; i < 900; i++) trace.push(0.20 + 0.08 * Math.sin(i / 3));
	assert.deepEqual(run(trace), []);
});

t('linkEvent : jamais deux annonces identiques consécutives', () => {
	// Traversées franches et répétées de toute la bande, façon slalom.
	const trace = [];
	for (let k = 0; k < 12; k++) {
		for (let i = 0; i < 30; i++) trace.push(0.02);
		for (let i = 0; i < 30; i++) trace.push(0.95);
	}
	const events = run(trace);
	for (let i = 1; i < events.length; i++) {
		assert.notEqual(events[i], events[i - 1], `doublon à l'index ${i}`);
	}
});

t('linkEvent : le temps de garde étouffe une mitraillette', () => {
	// Même slalom : 12 allers-retours en 12 s, mais LINK_MIN_GAP_S vaut 3 s,
	// donc il ne peut pas en sortir 24 annonces.
	const trace = [];
	for (let k = 0; k < 12; k++) {
		for (let i = 0; i < 30; i++) trace.push(0.02);
		for (let i = 0; i < 30; i++) trace.push(0.95);
	}
	const events = run(trace);
	const spanS = trace.length / 60;
	assert.ok(events.length <= Math.ceil(spanS / LINK_MIN_GAP_S) + 1,
		`${events.length} annonces en ${spanS.toFixed(1)} s`);
});

t('linkEvent : ne garde aucun état de module — deux runs identiques', () => {
	const trace = [...Array(60).fill(1), ...Array(300).fill(0.02), ...Array(300).fill(0.9)];
	assert.deepEqual(run(trace), run(trace));
});

// --- partitions de rituel ---------------------------------------------------

const VARIANT_MS = [1000, 2000, 3000, 4000]; // V1..V4, cf. tools/ritual-model.mjs

t('RITUAL_SCORES : une partition par famille de HACK_TYPES, et rien d\'autre', () => {
	assert.deepEqual(Object.keys(RITUAL_SCORES).sort(), [...HACK_TYPES].sort());
});

t('RITUAL_SCORES : chaque événement nomme une voix connue', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		for (const ev of score) {
			assert.ok(VOICES.includes(ev.voice), `${family} : voix inconnue ${ev.voice}`);
		}
	}
});

t('RITUAL_SCORES : temps normalisé croissant, dans [0,1]', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		for (let i = 0; i < score.length; i++) {
			assert.ok(score[i].at >= 0 && score[i].at <= 1, `${family} : at hors [0,1]`);
			if (i) assert.ok(score[i].at >= score[i - 1].at, `${family} : at non croissant`);
		}
	}
});

t('RITUAL_SCORES : les six sont réellement distinctes', () => {
	// La décision « six identités écrites à la main » est vérifiée, pas
	// seulement déclarée : deux familles ne peuvent pas rendre la même suite
	// de voix.
	const shapes = Object.entries(RITUAL_SCORES)
		.map(([f, s]) => [f, s.map((e) => e.voice).join('>')]);
	for (let i = 0; i < shapes.length; i++) {
		for (let j = i + 1; j < shapes.length; j++) {
			assert.notEqual(shapes[i][1], shapes[j][1], `${shapes[i][0]} == ${shapes[j][0]}`);
		}
	}
});

t('RITUAL_SCORES : chacune finit par une montée puis l\'impact final (§36)', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		const voices = score.map((e) => e.voice);
		assert.equal(voices[voices.length - 1], 'impact', `${family} : pas d'impact final`);
		assert.ok(voices.includes('sweep'), `${family} : pas de montée`);
		assert.ok(voices.lastIndexOf('sweep') < voices.length - 1, `${family} : montée après l'impact`);
	}
});

t('scoreFor : rend une partition non vide pour les 6 familles × les 4 variantes', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			assert.ok(scoreFor(family, ms).length > 0, `${family} / ${ms}ms`);
		}
	}
});

t('scoreFor : rien ne dépasse la durée de la variante', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			for (const ev of scoreFor(family, ms)) {
				assert.ok(ev.atMs >= 0 && ev.atMs <= ms, `${family}/${ms} : atMs=${ev.atMs}`);
			}
		}
	}
});

t('scoreFor : l\'impact final est ancré à la fin, quelle que soit la variante', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			const score = scoreFor(family, ms);
			const last = score[score.length - 1];
			assert.equal(last.voice, 'impact', `${family}/${ms}`);
			// Dans les 10 derniers pourcents : la culmination tombe avec la fin
			// de la variante, elle ne flotte pas au milieu.
			assert.ok(last.atMs >= ms * 0.90, `${family}/${ms} : impact à ${last.atMs}`);
		}
	}
});

t('scoreFor : la variante change la durée, pas la construction', () => {
	for (const family of HACK_TYPES) {
		const shapes = VARIANT_MS.map((ms) => scoreFor(family, ms).map((e) => e.voice).join('>'));
		assert.equal(new Set(shapes).size, 1, `${family} : la suite de voix change avec la variante`);
	}
	// Mais l'étalement, lui, change bien.
	const spans = VARIANT_MS.map((ms) => {
		const s = scoreFor('LINK HIJACK', ms);
		return s[s.length - 1].atMs;
	});
	for (let i = 1; i < spans.length; i++) assert.ok(spans[i] > spans[i - 1]);
});

t('scoreFor : les voix percussives gardent leur durée propre, les tenues s\'étirent', () => {
	const short = scoreFor('FIRMWARE OVERRIDE', 1000);
	const long = scoreFor('FIRMWARE OVERRIDE', 4000);
	for (let i = 0; i < short.length; i++) {
		if (PERCUSSIVE.includes(short[i].voice)) {
			assert.equal(short[i].durS, long[i].durS, 'un glitch dure autant à V1 qu\'à V4');
		} else {
			assert.ok(long[i].durS > short[i].durS, `${short[i].voice} devrait s'étirer`);
		}
	}
});

t('scoreFor : famille inconnue → partition vide plutôt qu\'un plantage', () => {
	assert.deepEqual(scoreFor('PAS UNE FAMILLE', 2000), []);
});

console.log(`\n${n} tests OK`);
