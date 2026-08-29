// Selftest du modèle de session (PHASE 06). Aucun réseau, aucun disque : le
// fetch de src/operator.js est stubbé comme dans src/operator.selftest.mjs.
// Lancer : node tools/session-selftest.mjs
import assert from 'node:assert/strict';
import {
	openSession, resumeSession, closeSession, mergeTelemetry,
	validateSession, reconcileStaleSessions, sanitizeWeatherSnapshot,
	freshTelemetry, newSessionId, SESSION_ID_RE,
	sanitizeComment, annotateSession,
	sanitizePhoto, addPhoto,
	stripPhotoData, stripOperatorPhotoData, deleteSession,
} from './session-model.mjs';
import { migrate, freshState, SCHEMA_VERSION } from './operator-store.mjs';
import { randomart, RANDOMART_DIMS } from './randomart.mjs';
import { TARGET_FAMILIES, HACK_TYPES, generateTargetScan, resolveTarget } from './target-model.mjs';
import * as op from '../src/operator.js';
import * as session from '../src/session.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const WEATHER = {
	zone: '35.68,139.65', day: '2026-08-29', source: 'open-meteo',
	days: [{ regime: 'CLEAR', confidence: 0.94, tMax: 30 }],
};

// ---------------------------------------------------------------------------
// session-model

t('newSessionId : slug de zone + 4 hex, conforme à la regex', () => {
	const id = newSessionId('Tokyo Shibuya');
	assert.match(id, SESSION_ID_RE);
	assert.match(id, /^tokyo-shibuya-[0-9a-f]{4}$/);
	assert.throws(() => newSessionId('!!!'), /AREA UNUSABLE/);
});

t('openSession : forme PENDING complète, randomart posé, télémétrie à zéro', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'tokyo-shibuya', weatherSnapshot: WEATHER });
	assert.equal(s.result, 'PENDING');
	assert.equal(s.operatorId, 'neo-3f9c');
	assert.equal(s.area, 'tokyo-shibuya');
	assert.equal(s.target, null);
	assert.deepEqual(s.photos, []);
	assert.equal(s.comment, null);
	assert.equal(s.resumeCount, 0);
	assert.equal(s.end, null);
	assert.ok(s.start);
	assert.deepEqual(s.flightTelemetry, freshTelemetry());
	assert.equal(s.weatherSnapshot.regime, 'CLEAR');
	assert.ok(s.randomart.includes('[FPV 06]'));
	assert.doesNotThrow(() => validateSession(s));
});

t('sanitizeWeatherSnapshot : ne garde que la forme connue, null licite', () => {
	assert.equal(sanitizeWeatherSnapshot(null), null);
	const clean = sanitizeWeatherSnapshot({ ...WEATHER, secret: 42 });
	assert.deepEqual(Object.keys(clean).sort(), ['confidence', 'day', 'day0', 'regime', 'source', 'zone']);
	assert.equal(clean.confidence, 0.94);
	assert.throws(() => sanitizeWeatherSnapshot({ zone: 'x' }), /sans jour/);
});

t('mergeTelemetry : max sur les pics, somme sur les cumuls, associatif', () => {
	const a = { durationS: 100, distanceM: 500, maxSpeedMs: 20, maxRateDps: 400, maxAltitudeM: 30 };
	const b = { durationS: 60, distanceM: 300, maxSpeedMs: 27, maxRateDps: 380, maxAltitudeM: 55 };
	const c = { durationS: 12, distanceM: 40, maxSpeedMs: 15, maxRateDps: 900, maxAltitudeM: 10 };
	const ab_c = mergeTelemetry(mergeTelemetry(a, b), c);
	const a_bc = mergeTelemetry(a, mergeTelemetry(b, c));
	assert.deepEqual(ab_c, a_bc);
	assert.equal(ab_c.durationS, 172);
	assert.equal(ab_c.distanceM, 840);
	assert.equal(ab_c.maxSpeedMs, 27);
	assert.equal(ab_c.maxRateDps, 900);
	assert.equal(ab_c.maxAltitudeM, 55);
});

t('closeSession : pose end + result, fusionne la télémétrie', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	s.flightTelemetry = { durationS: 40, distanceM: 100, maxSpeedMs: 12, maxRateDps: 200, maxAltitudeM: 8 };
	const done = closeSession(s, {
		result: 'LANDED',
		telemetry: { durationS: 10, distanceM: 20, maxSpeedMs: 30, maxRateDps: 100, maxAltitudeM: 40 },
	});
	assert.equal(done.result, 'LANDED');
	assert.ok(done.end);
	assert.equal(done.flightTelemetry.durationS, 50);
	assert.equal(done.flightTelemetry.maxSpeedMs, 30);
	assert.equal(done.flightTelemetry.maxAltitudeM, 40);
	assert.throws(() => closeSession(s, { result: 'PENDING' }), /verdict invalide/);
});

t('resumeSession : LANDED seulement, garde identité, incrémente resumeCount', () => {
	const s = closeSession(
		openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER }),
		{ result: 'LANDED', telemetry: freshTelemetry() },
	);
	const again = resumeSession(s);
	assert.equal(again.result, 'PENDING');
	assert.equal(again.end, null);
	assert.equal(again.resumeCount, 1);
	assert.equal(again.id, s.id);
	assert.equal(again.start, s.start);
	assert.equal(again.randomart, s.randomart);
	assert.throws(() => resumeSession(again), /NOT RESUMABLE/); // again est déjà PENDING
	const crashed = closeSession(s, { result: 'CRASHED', telemetry: freshTelemetry() });
	assert.throws(() => resumeSession(crashed), /NOT RESUMABLE/);
});

t('validateSession : rejette id, result, weatherSnapshot, télémétrie non valides', () => {
	const good = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(() => validateSession({ ...good, id: 'PAS BON' }), /id de session invalide/);
	assert.throws(() => validateSession({ ...good, result: 'MEH' }), /result inconnu/);
	assert.throws(() => validateSession({ ...good, weatherSnapshot: { zone: 'x' } }), /sans jour/);
	assert.throws(() => validateSession({ ...good, flightTelemetry: { ...good.flightTelemetry, maxSpeedMs: -1 } }), /invalide/);
	assert.throws(() => validateSession({ ...good, result: 'LANDED', end: null }), /sans end/);
});

t('reconcileStaleSessions : PENDING ancien → CRASHED, terminal intact', () => {
	const old = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	old.start = new Date(Date.now() - 45 * 60 * 1000).toISOString();
	const fresh = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	const landed = closeSession(
		openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER }),
		{ result: 'LANDED', telemetry: freshTelemetry() },
	);
	const { state, changed } = reconcileStaleSessions({ sessions: [old, fresh, landed] });
	assert.equal(changed, true);
	assert.equal(state.sessions[0].result, 'CRASHED');
	assert.ok(state.sessions[0].end);
	assert.equal(state.sessions[1].result, 'PENDING'); // trop récente
	assert.equal(state.sessions[2].result, 'LANDED');

	const stable = reconcileStaleSessions({ sessions: [fresh, landed] });
	assert.equal(stable.changed, false);
});

const GOOD_TARGET = {
	family: TARGET_FAMILIES[0],
	classHint: '5"',
	hackType: HACK_TYPES[0],
	signal: { rssiDbm: -59, mode: 'ANALOG' },
	scannedAt: new Date().toISOString(),
	intel: { location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL', video: 'KNOWN', control: 'UNKNOWN', flightState: 'UNKNOWN' },
};

t('openSession : porte une cible validée, conservée au resume, null si absente', () => {
	const s = openSession({ seq: 1, targetSeq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null, target: GOOD_TARGET });
	assert.equal(s.target.family, GOOD_TARGET.family);
	assert.equal(s.target.hackType, HACK_TYPES[0]);
	assert.equal(validateSession(s), s);
	const landed = closeSession(s, { result: 'LANDED', telemetry: freshTelemetry() });
	const resumed = resumeSession(landed);
	assert.equal(resumed.target.family, GOOD_TARGET.family);

	const noTarget = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null });
	assert.equal(noTarget.target, null);
});

t('sanitizeTarget : rejette famille inconnue et rssi positif ; validateSession re-vérifie', () => {
	assert.throws(() => openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { family: 'not-a-family', signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} },
	}), /famille de cible inconnue/);
	const bad = {
		...openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null }),
		target: { family: TARGET_FAMILIES[0], signal: { rssiDbm: 5, mode: 'ANALOG' }, intel: {} },
	};
	assert.throws(() => validateSession(bad), /rssiDbm invalide/);
});

t('sanitizeTarget : hackType — valide conservé, inconnu rejeté, absent toléré', () => {
	const base = { family: TARGET_FAMILIES[0], signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} };

	const withHack = openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'GNSS SPOOF' },
	});
	assert.equal(withHack.target.hackType, 'GNSS SPOOF');

	const noHack = openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base },
	});
	assert.equal(noHack.target.hackType, null);

	assert.throws(() => openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'NOPE' },
	}), /hackType de cible inconnu/);
});

t('sanitizeComment : vide/blanc -> null, coupe les espaces, plafonne la longueur', () => {
	assert.equal(sanitizeComment(null), null);
	assert.equal(sanitizeComment(''), null);
	assert.equal(sanitizeComment('   '), null);
	assert.equal(sanitizeComment('  ras, cible calme  '), 'ras, cible calme');
	assert.throws(() => sanitizeComment('x'.repeat(401)), /COMMENT TOO LONG/);
	assert.throws(() => sanitizeComment(42), /comment invalide/);
});

t('annotateSession : peut annoter une session déjà LANDED (pas de restriction PENDING)', () => {
	const opened = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null });
	const closed = closeSession(opened, { result: 'LANDED', telemetry: freshTelemetry() });
	const noted = annotateSession(closed, 'cible posée sans encombre');
	assert.equal(noted.comment, 'cible posée sans encombre');
	assert.equal(noted.result, 'LANDED'); // pas touché
	assert.doesNotThrow(() => validateSession(noted));
});

const GOOD_PHOTO = { dataUrl: 'data:image/jpeg;base64,/9j/AAA=', w: 480, h: 360 };

t('sanitizePhoto : forme connue gardée, ts posé par le serveur (ignore celui du client)', () => {
	const p = sanitizePhoto({ ...GOOD_PHOTO, ts: '2000-01-01T00:00:00.000Z', extra: 'x' });
	assert.equal(p.dataUrl, GOOD_PHOTO.dataUrl);
	assert.equal(p.w, 480);
	assert.equal(p.h, 360);
	assert.notEqual(p.ts, '2000-01-01T00:00:00.000Z');
	assert.ok(new Date(p.ts).toISOString() === p.ts);
});

t('sanitizePhoto : rejette dataUrl absente/non-image, w/h non entiers ou <= 0', () => {
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, dataUrl: undefined }), /dataUrl invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, dataUrl: 'not-a-data-url' }), /dataUrl invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, w: 0 }), /w invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, w: 4.5 }), /w invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, h: -1 }), /h invalide/);
});

t('addPhoto : ajoute au tableau existant sans le muter, plusieurs captures par session', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	const s1 = addPhoto(s, GOOD_PHOTO);
	assert.deepEqual(s.photos, []); // pas de mutation de l'original
	assert.equal(s1.photos.length, 1);
	const s2 = addPhoto(s1, { ...GOOD_PHOTO, w: 640, h: 480 });
	assert.equal(s2.photos.length, 2);
	assert.equal(s2.photos[0].w, 480);
	assert.equal(s2.photos[1].w, 640);
	assert.doesNotThrow(() => validateSession(s2));
});

t('validateSession : rejette une session dont un élément de photos[] est malformé', () => {
	const good = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(
		() => validateSession({ ...good, photos: [{ w: 480, h: 360 }] }),
		/photo/,
	);
	assert.throws(
		() => validateSession({ ...good, photos: 'nope' }),
		/photos/,
	);
});

// --- PHASE 17 : numéros d'affichage, élision des captures, suppression ------

t('openSession : pose seq et targetSeq tels que le serveur les attribue', () => {
	const s = openSession({
		operatorId: 'neo-3f9c', area: 'tokyo', weatherSnapshot: null,
		target: null, seq: 421, targetSeq: null,
	});
	assert.equal(s.seq, 421);
	assert.equal(s.targetSeq, null);
	validateSession(s);
});

t('validateSession : exige un seq entier >= 1', () => {
	const good = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	assert.throws(() => validateSession({ ...good, seq: 0 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: 1.5 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: undefined }), /seq/);
});

t('validateSession : targetSeq obligatoire avec une cible, absent sans', () => {
	const scan = generateTargetScan({ seed: 'seq-seed', count: 3 });
	const target = resolveTarget(scan, 1);
	const withT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, target, seq: 2, targetSeq: 7 });
	assert.equal(withT.targetSeq, 7);
	validateSession(withT);
	assert.throws(() => validateSession({ ...withT, targetSeq: null }), /targetSeq/);
	const noT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 3 });
	assert.throws(() => validateSession({ ...noT, targetSeq: 4 }), /targetSeq/);
});

t('resumeSession : les deux numeros survivent — c est la meme session', () => {
	const s = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 9 });
	const landed = closeSession(s, { result: 'LANDED' });
	const again = resumeSession(landed);
	assert.equal(again.seq, 9);
	assert.equal(again.resumeCount, 1);
});

t('stripPhotoData : retire dataUrl, garde w/h/ts, ne mute pas l original', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/jpeg;base64,AAA=', w: 480, h: 360 },
	);
	const light = stripPhotoData(s);
	assert.equal(light.photos[0].dataUrl, undefined);
	assert.equal(light.photos[0].w, 480);
	assert.equal(light.photos[0].h, 360);
	assert.equal(typeof light.photos[0].ts, 'string');
	assert.equal(s.photos[0].dataUrl, 'data:image/jpeg;base64,AAA=');
	// Une session elidee est un FORMAT DE FIL, pas un etat persistable : elle ne
	// repasse jamais par validateSession, qui exige a raison une dataUrl sur
	// chaque capture. L'elision n'a lieu que dans les `json(res, ...)`, apres
	// `_writeOperator` — jamais avant une ecriture disque. On asserte donc
	// l'echec, pour que ce sens de lecture reste ecrit quelque part.
	assert.throws(() => validateSession(light), /dataUrl/);
});

t('stripOperatorPhotoData : elide toutes les sessions d un etat', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/png;base64,BBB=', w: 8, h: 8 },
	);
	const light = stripOperatorPhotoData({ id: 'op', sessions: [s] });
	assert.equal(light.sessions[0].photos[0].dataUrl, undefined);
	assert.equal(s.photos[0].dataUrl, 'data:image/png;base64,BBB=');
});

t('deleteSession : retire l entree, ne touche a rien d autre', () => {
	const a = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const b = openSession({ operatorId: 'op', area: 'lviv', weatherSnapshot: null, seq: 2 });
	const state = {
		id: 'op', sessionSeq: 2, targetSeq: 0,
		sessions: [closeSession(a, { result: 'LANDED' }), closeSession(b, { result: 'CRASHED' })],
	};
	const out = deleteSession(state, state.sessions[0].id);
	assert.equal(out.sessions.length, 1);
	assert.equal(out.sessions[0].area, 'lviv');
	// Les compteurs ne reculent pas : un numero ne se recycle pas (spec D2).
	assert.equal(out.sessionSeq, 2);
	assert.equal(state.sessions.length, 2); // pas de mutation
});

t('deleteSession : 404 sur inconnue, 409 sur une session encore PENDING', () => {
	const p = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const state = { id: 'op', sessions: [p] };
	assert.throws(() => deleteSession(state, 'nexiste-pas-0000'), (e) => e.status === 404);
	assert.throws(() => deleteSession(state, p.id), (e) => e.status === 409);
});

// --- migration v1 -> v2 -----------------------------------------------------

t('SCHEMA_VERSION vaut 2', () => {
	assert.equal(SCHEMA_VERSION, 2);
});

t('freshState : deux compteurs a zero, plus de cle targetLog', () => {
	const s = freshState({ id: 'neo-0000', name: 'neo' });
	assert.equal(s.sessionSeq, 0);
	assert.equal(s.targetSeq, 0);
	assert.equal('targetLog' in s, false);
});

t('migrate v1 -> v2 : backfill des numeros dans l ordre, targetLog retire', () => {
	const scan = generateTargetScan({ seed: 'mig-seed', count: 3 });
	const withTarget = resolveTarget(scan, 0);
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {},
		targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null },
			{ id: 'b-0002', area: 'b', result: 'CRASHED', target: withTarget },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: withTarget },
		],
	};
	const m = migrate(v1);
	assert.equal(m.schemaVersion, 2);
	assert.equal('targetLog' in m, false);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 2, 3]);
	// Seules les sessions avec cible consomment un numero de cible.
	assert.equal(m.sessions[0].targetSeq, undefined);
	assert.equal(m.sessions[1].targetSeq, 1);
	assert.equal(m.sessions[2].targetSeq, 2);
	assert.equal(m.sessionSeq, 3);
	assert.equal(m.targetSeq, 2);
});

t('migrate : idempotent — repasser un etat v2 ne renumerote rien', () => {
	const scan = generateTargetScan({ seed: 'mig-seed-2', count: 3 });
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {}, targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: resolveTarget(scan, 0) },
			{ id: 'b-0002', area: 'b', result: 'LANDED', target: null },
		],
	};
	const once = migrate(v1);
	const twice = migrate(once);
	assert.deepEqual(twice.sessions.map((s) => s.seq), once.sessions.map((s) => s.seq));
	assert.deepEqual(twice.sessions.map((s) => s.targetSeq), once.sessions.map((s) => s.targetSeq));
	assert.equal(twice.sessionSeq, once.sessionSeq);
	assert.equal(twice.targetSeq, once.targetSeq);
});

t('migrate : un trou de numerotation survit a la relecture', () => {
	// Ce que devient un fichier v2 apres DELETE de la session 2 : les numeros
	// restants ne bougent pas, et les compteurs ne reculent pas.
	const v2 = {
		schemaVersion: 2, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {},
		sessionSeq: 3, targetSeq: 0,
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null, seq: 1 },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: null, seq: 3 },
		],
	};
	const m = migrate(v2);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 3]);
	assert.equal(m.sessionSeq, 3);
});

// ---------------------------------------------------------------------------
// randomart

t('randomart : déterministe, dimensions et cadre corrects', () => {
	const a = randomart('tokyo-shibuya-a1b2', { tag: 'a1b2' });
	const b = randomart('tokyo-shibuya-a1b2', { tag: 'a1b2' });
	assert.equal(a, b);
	assert.notEqual(a, randomart('tokyo-shibuya-c3d4', { tag: 'c3d4' }));
	const lines = a.split('\n');
	assert.equal(lines.length, RANDOMART_DIMS.LINES);
	assert.ok(lines.every((l) => l.length === RANDOMART_DIMS.WIDTH + 2));
	assert.ok(a.includes('S') && a.includes('E'));
	assert.ok(lines[lines.length - 1].includes('a1b2'));
});

// ---------------------------------------------------------------------------
// src/session.js — agrégateur client, fetch stubbé

function stubOperator(calls) {
	op._setStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
	op._setFetch(async (url, init = {}) => {
		const method = init.method ?? 'GET';
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		if (method === 'POST' && /\/__operator$/.test(url)) {
			return json({ operator: { id: 'neo-0000', name: 'neo', createdAt: 'x', sessions: [], terrainCache: [], targetLog: [], settings: {}, controlVector: [], worldState: {} } });
		}
		if (method === 'POST' && /\/sessions$/.test(url)) {
			const s = body.resume
				? { id: body.resume, result: 'PENDING', resumeCount: 1 }
				: { id: 'paris-0000', result: 'PENDING', resumeCount: 0 };
			return json({ session: s });
		}
		if (/\/sessions\/[^/]+\/photos$/.test(url)) {
			calls._photos = (calls._photos ?? 0) + 1;
			return json({ session: { id: 'paris-0000', result: 'PENDING', photos: Array(calls._photos).fill({}) } });
		}
		if (/\/sessions\/[^/]+$/.test(url)) {
			return json({ session: { id: 'paris-0000', result: body.result, flightTelemetry: body.telemetry } });
		}
		throw new Error(`fetch non stubbé : ${method} ${url}`);
	});
}
const json = (obj) => ({ ok: true, status: 200, json: async () => obj });

await ta('feed n\'accumule durée/distance que si armed ; open+end = 1 POST + 1 PATCH', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();

	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	// désarmé : rien ne compte, pas même les pics (rebond au sol de la sphère)
	session.feed({ speed: 999, horizontalSpeed: 999, rateDps: 9999, altitudeAboveSpawn: 999, dt: 1, armed: false });
	// armé : tout compte
	session.feed({ speed: 20, horizontalSpeed: 15, rateDps: 300, altitudeAboveSpawn: 40, dt: 2, armed: true });
	session.feed({ speed: 12, horizontalSpeed: 10, rateDps: 250, altitudeAboveSpawn: 18, dt: 1, armed: true });

	await session.end('LANDED');

	const posts = calls.filter((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	const patches = calls.filter((c) => c.method === 'PATCH' && /\/sessions\//.test(c.url));
	assert.equal(posts.length, 1);
	assert.equal(patches.length, 1);
	const tel = patches[0].body.telemetry;
	assert.equal(patches[0].body.result, 'LANDED');
	assert.equal(tel.durationS, 3);           // 2 + 1, pas le pas désarmé
	assert.equal(tel.distanceM, 40);          // 15*2 + 10*1
	assert.equal(tel.maxSpeedMs, 20);
	assert.equal(tel.maxRateDps, 300);
	assert.equal(tel.maxAltitudeM, 40);

	// end est idempotent : un second verdict ne repart pas sur le réseau
	await session.end('CRASHED');
	assert.equal(calls.filter((c) => /\/sessions\//.test(c.url)).length, 1);
});

await ta('open({ resume }) envoie { resume } et rien d\'autre', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ resume: 'paris-abcd' });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.deepEqual(post.body, { resume: 'paris-abcd' });
});

await ta('open({ area, target }) envoie targetSeed/targetCount/targetIndex, pas de resume', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'kyiv', target: { seed: 's', count: 4, index: 1 } });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.equal(post.body.area, 'kyiv');
	assert.equal(post.body.targetSeed, 's');
	assert.equal(post.body.targetCount, 4);
	assert.equal(post.body.targetIndex, 1);
	assert.ok(!('resume' in post.body));
});

await ta('capturePhoto : POST .../sessions/:sid/photos, incrémente le compteur local', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	assert.equal(session.photoCount(), 0);

	const n1 = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AAA=', w: 480, h: 360 });
	assert.equal(n1, 1);
	assert.equal(session.photoCount(), 1);
	const post = calls.find((c) => c.method === 'POST' && /\/photos$/.test(c.url));
	assert.ok(post);
	assert.equal(post.body.dataUrl, 'data:image/jpeg;base64,AAA=');
	assert.equal(post.body.w, 480);

	const n2 = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,BBB=', w: 480, h: 360 });
	assert.equal(n2, 2);
});

await ta('capturePhoto : sans session ouverte, ne fait rien et rend 0', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	const n = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AAA=', w: 1, h: 1 });
	assert.equal(n, 0);
	assert.equal(calls.filter((c) => /\/photos$/.test(c.url)).length, 0);
});

console.log(`\n${n} tests session OK`);
