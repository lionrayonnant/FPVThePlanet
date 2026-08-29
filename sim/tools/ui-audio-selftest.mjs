// Selftest du modèle sonore d'interface (PHASE 18). Aucune E/S, aucun DOM,
// aucune Web Audio. Lancer : node tools/ui-audio-selftest.mjs
import assert from 'node:assert/strict';
import {
	UI_EVENTS, UI_FAMILY, BOOT_SIGNATURE,
	LINK_LOST_AT, LINK_BACK_AT, LINK_MIN_GAP_S,
	newLinkState, linkEvent,
} from './ui-audio-model.mjs';

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

console.log(`\n${n} tests OK`);
