// Selftest du modèle sonore d'interface (PHASE 18). Aucune E/S, aucun DOM,
// aucune Web Audio. Lancer : node tools/ui-audio-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
	UI_EVENTS, UI_FAMILY, BOOT_SIGNATURE,
	LINK_LOST_AT, LINK_BACK_AT, LINK_MIN_GAP_S,
	newLinkState, linkEvent,
	VOICES, PERCUSSIVE, RITUAL_SCORES, scoreFor,
	RITUAL_TENSION, ritualTensionParams,
} from './ui-audio-model.mjs';
import { HACK_TYPES } from './target-model.mjs';
import { fakeAudioContext } from './lib/fake-audio-ctx.mjs';

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

t('VOICES : blast (le souffle de l\'explosion) fait partie du vocabulaire', () => {
	assert.ok(VOICES.includes('blast'), 'blast manquant');
	assert.ok(!PERCUSSIVE.includes('blast'), 'blast doit s\'étirer avec la variante, pas rester fixe');
});

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

t('RITUAL_SCORES : montée, détonation en couches, puis des shrapnels dispersés (§36)', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		const voices = score.map((e) => e.voice);
		assert.ok(voices.includes('sweep'), `${family} : pas de montée`);
		assert.ok(voices.includes('impact'), `${family} : pas d'impact`);
		assert.ok(voices.includes('blast'), `${family} : pas de souffle`);
		const impactIdx = voices.lastIndexOf('impact');
		const blastIdx = voices.lastIndexOf('blast');
		const lastSweepIdx = voices.lastIndexOf('sweep');
		assert.ok(lastSweepIdx < impactIdx, `${family} : la montée doit précéder l'impact`);
		assert.ok(lastSweepIdx < blastIdx, `${family} : la montée doit précéder le souffle`);
		// Tout ce qui suit la détonation (impact + blast, simultanés ou non) est
		// un éclat panoramisé : c'est la partie « ça part dans tous les sens ».
		const after = score.slice(Math.max(impactIdx, blastIdx) + 1);
		assert.ok(after.length >= 2, `${family} : pas assez de shrapnels après la détonation`);
		for (const ev of after) {
			assert.ok(['click', 'glitch'].includes(ev.voice), `${family} : shrapnel inattendu ${ev.voice}`);
			assert.equal(typeof ev.pan, 'number', `${family} : shrapnel sans pan`);
		}
		const pans = after.map((e) => e.pan);
		assert.ok(pans.some((p) => p < 0) && pans.some((p) => p > 0),
			`${family} : les shrapnels ne couvrent pas tout le champ stéréo`);
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

t('scoreFor : l\'impact est ancré près de la fin, les shrapnels ferment la partition', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			const score = scoreFor(family, ms);
			const impactEvents = score.filter((e) => e.voice === 'impact');
			assert.ok(impactEvents.length > 0, `${family}/${ms} : pas d'impact`);
			const impactAt = impactEvents[impactEvents.length - 1].atMs;
			// Dans les 15 derniers pourcents : la détonation tombe avec la fin de
			// la variante, elle ne flotte pas au milieu.
			assert.ok(impactAt >= ms * 0.85, `${family}/${ms} : impact à ${impactAt}`);
			const last = score[score.length - 1];
			assert.ok(last.atMs >= ms * 0.90, `${family}/${ms} : la partition ne finit pas près de la fin`);
			assert.ok(['click', 'glitch'].includes(last.voice),
				`${family}/${ms} : ne finit pas par un shrapnel (${last.voice})`);
		}
	}
});

t('scoreFor : transporte le pan des shrapnels', () => {
	for (const family of HACK_TYPES) {
		const raw = RITUAL_SCORES[family];
		assert.ok(raw.some((e) => typeof e.pan === 'number'), `${family} : aucun événement panoramisé`);
		const rendered = scoreFor(family, 2000);
		for (let i = 0; i < raw.length; i++) {
			if (typeof raw[i].pan === 'number') {
				assert.equal(rendered[i].pan, raw[i].pan, `${family}[${i}] : pan non transporté`);
			} else {
				assert.equal(rendered[i].pan, undefined, `${family}[${i}] : pan fantôme`);
			}
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

// --- tension du rituel -------------------------------------------------------

t('ritualTensionParams : mapping monotone croissant en k', () => {
	const ks = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
	let prev = ritualTensionParams(0);
	for (const k of ks.slice(1)) {
		const cur = ritualTensionParams(k);
		assert.ok(cur.freq >= prev.freq, `freq non monotone à k=${k}`);
		assert.ok(cur.rate >= prev.rate, `rate non monotone à k=${k}`);
		assert.ok(cur.gain >= prev.gain, `gain non monotone à k=${k}`);
		prev = cur;
	}
	assert.equal(ritualTensionParams(0).gain, 0, 'k=0 doit être silencieux');
	assert.equal(ritualTensionParams(1).freq, RITUAL_TENSION.fMax);
	assert.equal(ritualTensionParams(1).rate, RITUAL_TENSION.rateMax);
	assert.equal(ritualTensionParams(1).gain, RITUAL_TENSION.gain);
});

t('ritualTensionParams : k hors [0,1] est clampé', () => {
	assert.deepEqual(ritualTensionParams(-1), ritualTensionParams(0));
	assert.deepEqual(ritualTensionParams(2), ritualTensionParams(1));
});

t('RITUAL_TENSION : la chute est plus lente que la montée (retombée audible, pas un mute sec)', () => {
	assert.ok(RITUAL_TENSION.fallTau > RITUAL_TENSION.tau);
	// 3τ est le temps usuel pour qu'une exponentielle se juge « arrivée » :
	// on veut une retombée dans les 150-300 ms demandés, pas un mute en un tick.
	const fallMs = RITUAL_TENSION.fallTau * 3 * 1000;
	assert.ok(fallMs >= 150 && fallMs <= 300, `retombée hors fenêtre : ${fallMs} ms`);
});

// --- faux AudioContext ------------------------------------------------------

t('fakeAudioContext : les nœuds créés sont recensés et connectables', () => {
	const ctx = fakeAudioContext();
	const g = ctx.createGain();
	const o = ctx.createOscillator();
	o.connect(g).connect(ctx.destination);
	assert.equal(ctx._nodes.length, 3); // destination + gain + oscillateur
	assert.ok(ctx._conns.some(([from, to]) => from === o.id && to === g.id));
	assert.ok(ctx._conns.some(([from, to]) => from === g.id && to === ctx.destination.id));
});

t('fakeAudioContext : les AudioParam enregistrent leurs automations', () => {
	const ctx = fakeAudioContext();
	const g = ctx.createGain();
	g.gain.setValueAtTime(0, 0);
	g.gain.linearRampToValueAtTime(1, 0.5);
	assert.equal(g.gain.calls.length, 2);
	assert.equal(g.gain.calls[1][0], 'linearRampToValueAtTime');
});

t('fakeAudioContext : start/stop d\'une source sont horodatés', () => {
	const ctx = fakeAudioContext();
	const src = ctx.createBufferSource();
	src.start(1.25);
	src.stop(1.75);
	assert.equal(src.started, 1.25);
	assert.equal(src.stopped, 1.75);
});

t('fakeAudioContext : on peut connecter vers un AudioParam', () => {
	const ctx = fakeAudioContext();
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.connect(g.gain);
	assert.ok(ctx._conns.some(([from, to]) => from === o.id && to === 'param:gain'));
});

// --- « le système ne bipe pas à chaque clic » -------------------------------

t('aucun appel play() hors du vocabulaire clos dans src/', () => {
	// La forme exécutable de Bible §34. Ajouter un son demande d'ajouter une
	// entrée à UI_EVENTS — ce qui est exactement la friction voulue.
	const dir = new URL('../src/', import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
	const bad = [];
	for (const f of files) {
		const text = readFileSync(new URL(f, dir), 'utf8');
		for (const m of text.matchAll(/uiAudio\.play\(\s*(['"`])([^'"`]*)\1/g)) {
			if (!UI_EVENTS.includes(m[2])) bad.push(`${f} : ${m[2]}`);
		}
	}
	assert.deepEqual(bad, [], `appels hors vocabulaire :\n${bad.join('\n')}`);
});

t('aucun play() dynamique dans src/ : le vocabulaire doit rester vérifiable', () => {
	// uiAudio.play(someVariable) échapperait au test ci-dessus. Interdit : les
	// sept événements sont écrits en toutes lettres sur le site d'appel.
	const dir = new URL('../src/', import.meta.url);
	const bad = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
		const text = readFileSync(new URL(f, dir), 'utf8');
		for (const m of text.matchAll(/uiAudio\.play\(\s*([^'"`\s)])/g)) {
			bad.push(`${f} : play(${m[1]}…)`);
		}
	}
	assert.deepEqual(bad, [], `appels dynamiques :\n${bad.join('\n')}`);
});

console.log(`\n${n} tests OK`);
