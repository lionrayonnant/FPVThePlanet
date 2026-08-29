// Selftest du modèle de session (PHASE 06). Aucun réseau, aucun disque : le
// fetch de src/operator.js est stubbé comme dans src/operator.selftest.mjs.
// Lancer : node tools/session-selftest.mjs
import assert from 'node:assert/strict';
import {
	openSession, resumeSession, closeSession, mergeTelemetry,
	validateSession, reconcileStaleSessions, sanitizeWeatherSnapshot,
	freshTelemetry, newSessionId, SESSION_ID_RE,
} from './session-model.mjs';
import { randomart, RANDOMART_DIMS } from './randomart.mjs';
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
	const s = openSession({ operatorId: 'neo-3f9c', area: 'tokyo-shibuya', weatherSnapshot: WEATHER });
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
	const s = openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
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
		openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER }),
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
	const good = openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(() => validateSession({ ...good, id: 'PAS BON' }), /id de session invalide/);
	assert.throws(() => validateSession({ ...good, result: 'MEH' }), /result inconnu/);
	assert.throws(() => validateSession({ ...good, weatherSnapshot: { zone: 'x' } }), /sans jour/);
	assert.throws(() => validateSession({ ...good, flightTelemetry: { ...good.flightTelemetry, maxSpeedMs: -1 } }), /invalide/);
	assert.throws(() => validateSession({ ...good, result: 'LANDED', end: null }), /sans end/);
});

t('reconcileStaleSessions : PENDING ancien → CRASHED, terminal intact', () => {
	const old = openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	old.start = new Date(Date.now() - 45 * 60 * 1000).toISOString();
	const fresh = openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	const landed = closeSession(
		openSession({ operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER }),
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
	// désarmé : pas de durée ni de distance, mais les maxima montent
	session.feed({ speed: 5, horizontalSpeed: 4, rateDps: 100, altitudeAboveSpawn: 2, dt: 1, armed: false });
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

console.log(`\n${n} tests session OK`);
