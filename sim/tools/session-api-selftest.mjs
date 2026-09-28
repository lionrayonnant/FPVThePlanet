// Selftest of the session routes (PHASE 17) against a REAL server.
//
// Since the standalone server was extracted (issue #259), it is
// server/index.mjs that is started here, not Vite: this selftest tests what
// is shipped. A separate smoke check (tools/vite-adapter-selftest.mjs) keeps
// the Vite adapter honest.
//
// All the state goes into a disposable data directory — hence process.env
// BEFORE the first import, which would reach up to tools/lib/paths.mjs, which
// reads the variable at load time. The user's real operator state is neither
// read nor written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-api-'));
process.env.FPVTP_DATA_DIR = DIR;
delete process.env.FPV_OPERATOR_DIR;

const { startServer } = await import('../server/index.mjs');
const { encodeTrack, TRACK_KEEP } = await import('./track-model.mjs');
const { familiesFor } = await import('./signal-clearance-model.mjs');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// Port 0: any free port, so as not to collide with an already-open `npm run
// dev`. The URL the server actually RESOLVED is read back rather than
// reconstructed.
let started = await startServer({ dataDir: DIR, distDir: path.join(DIR, 'dist'), port: '0' });
const base = started.url.replace(/\/$/, '');

const call = async (method, p, body) => {
	const r = await fetch(base + p, body === undefined ? { method } : {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: r.status, body: await r.json().catch(() => ({})) };
};

const PHOTO = { dataUrl: 'data:image/jpeg;base64,/9j/AAA=', w: 480, h: 360 };

try {
	// --- one operator, two sessions -------------------------------------------
	const created = await call('POST', '/__operator', { name: 'apitest' });
	check('POST /__operator creates a v3 operator', created.status === 201
		&& created.body.operator.schemaVersion === 3
		&& created.body.operator.sessionSeq === 0
		&& !('targetLog' in created.body.operator));
	const id = created.body.operator.id;

	const s1 = await call('POST', `/__operator/${id}/sessions`, {
		area: 'tour-eiffel', weatherSnapshot: null,
		targetSeed: 'api-seed', targetCount: 4, targetIndex: 1,
	});
	check('POST sessions: first session numbered 1 / target 1',
		s1.status === 201 && s1.body.session.seq === 1 && s1.body.session.targetSeq === 1);
	const sid1 = s1.body.session.id;

	// A session with no TARGET SCAN (dev path): it does not consume a target
	// number.
	const s2 = await call('POST', `/__operator/${id}/sessions`, { area: 'kyiv', weatherSnapshot: null });
	check('POST sessions: a session with no target does not consume a targetSeq',
		s2.status === 201 && s2.body.session.seq === 2 && s2.body.session.targetSeq == null);
	const sid2 = s2.body.session.id;

	{
		// --- the swarm (issue #29) -------------------------------------------------
		// On its OWN operator: `id`'s session counters are checked exactly,
		// further down, session by session.
		// The server regenerates the scan with the chance the client gives it:
		// without it, it would not find back the cluster the player saw.
		const swarmOp = await call('POST', '/__operator', { name: 'apiswarm' });
		const id = swarmOp.body.operator.id;
		// clearance: 3 (issue #185, Signals lot 3) — the swarm only draws from
		// CLEARANCE 3 now; without it swarmChance would be gated to 0 server-side
		// and this witness would stop meaning anything.
		const sSwarm = await call('POST', `/__operator/${id}/sessions`, {
			area: 'kyiv', weatherSnapshot: null,
			targetSeed: 'api-swarm', targetCount: 4, targetIndex: 0, swarmChance: 1, clearance: 3,
		});
		check('POST sessions: swarmChance 1 -> cluster target persisted',
			sSwarm.status === 201
			&& sSwarm.body.session.target.family === 'swarmNode'
			&& sSwarm.body.session.target.hackType === 'NETWORK TAKEOVER'
			&& sSwarm.body.session.target.classHint === 'MESH'
			&& sSwarm.body.session.target.swarm.size >= 6
			&& sSwarm.body.session.target.swarm.size <= 12
			&& sSwarm.body.session.target.scan.swarmAt === 0
			&& sSwarm.body.session.target.scan.swarmChance === 1,
			JSON.stringify(sSwarm.body.session?.target));
		check('POST sessions: the session carries the v3 schema',
			sSwarm.body.session.schemaVersion === 3);

		const sNoSwarm = await call('POST', `/__operator/${id}/sessions`, {
			area: 'kyiv', weatherSnapshot: null,
			targetSeed: 'api-swarm', targetCount: 4, targetIndex: 0, swarmChance: 0,
		});
		check('POST sessions: swarmChance 0 -> no trace of a swarm',
			sNoSwarm.status === 201
			&& sNoSwarm.body.session.target.family !== 'swarmNode'
			&& sNoSwarm.body.session.target.swarm === null
			&& sNoSwarm.body.session.target.scan.swarmAt === null);

		for (const bad of [-0.5, 1.5, 'x']) {
			const r = await call('POST', `/__operator/${id}/sessions`, {
				area: 'kyiv', weatherSnapshot: null,
				targetSeed: 'api-swarm', targetCount: 4, targetIndex: 0, swarmChance: bad,
			});
			check(`POST sessions: swarmChance ${bad} -> 400`, r.status === 400, `${r.status}`);
		}
	}

	{
		// --- clearance drives the draw pool (issue #185, Signals lot 3) ----------
		// On its OWN operator, like the swarm block above: `created`'s sessionSeq
		// is checked exactly, further down, and must not move.
		const clrOp = await call('POST', '/__operator', { name: 'apiclearance' });
		const id = clrOp.body.operator.id;
		const FREESTYLE_ONLY = ['freestyle5'];
		// clearance: 0 -> every index of a scan resolves to a freestyle5, over
		// several indices, not just the first candidate.
		for (const targetIndex of [0, 1, 2]) {
			const r = await call('POST', `/__operator/${id}/sessions`, {
				area: 'kyiv', weatherSnapshot: null,
				targetSeed: 'clr-0', targetCount: 4, targetIndex, clearance: 0,
			});
			check(`POST sessions: clearance 0, index ${targetIndex} -> family in level-0 pool`,
				r.status === 201 && FREESTYLE_ONLY.includes(r.body.session.target.family),
				r.body.session?.target?.family);
		}

		// A client and the server regenerating with the same body must resolve
		// the SAME family for a candidate index the client picked off its own
		// (identically-computed) scan.
		const rParity = await call('POST', `/__operator/${id}/sessions`, {
			area: 'kyiv', weatherSnapshot: null,
			targetSeed: 'clr-parity', targetCount: 4, targetIndex: 1, clearance: 0,
		});
		check('POST sessions: server family within the same pool a client-side scan would use',
			rParity.status === 201 && FREESTYLE_ONLY.includes(rParity.body.session.target.family),
			rParity.body.session?.target?.family);

		// Missing or invalid clearance: the full pool (an older client), and no
		// 400 — this must keep working forever.
		for (const bad of [undefined, -1, 99, 1.5]) {
			const body = { area: 'kyiv', weatherSnapshot: null, targetSeed: 'clr-bad', targetCount: 4, targetIndex: 0 };
			if (bad !== undefined) body.clearance = bad;
			const r = await call('POST', `/__operator/${id}/sessions`, body);
			check(`POST sessions: clearance ${bad} -> 201, full pool, no throw`, r.status === 201, `${r.status}`);
		}

		// Back-compat (fix round 1): missing/invalid clearance must ALSO leave
		// swarmChance untouched — a stale client (pre-#185) that showed a swarm
		// must still resolve one. Same body as the swarm witness above, minus
		// `clearance`: the same swarm resolution as before this task existed.
		for (const bad of [undefined, -1, 99, 1.5]) {
			const body = {
				area: 'kyiv', weatherSnapshot: null,
				targetSeed: 'api-swarm-legacy', targetCount: 4, targetIndex: 0, swarmChance: 1,
			};
			if (bad !== undefined) body.clearance = bad;
			const r = await call('POST', `/__operator/${id}/sessions`, body);
			check(`POST sessions: clearance ${bad}, swarmChance 1 -> swarm still resolves (back-compat)`,
				r.status === 201 && r.body.session.target.family === 'swarmNode'
				&& r.body.session.target.scan.swarmAt === 0
				&& r.body.session.target.scan.swarmChance === 1,
				JSON.stringify(r.body.session?.target));
		}

		// The clearance pool is STORED with the scan (issue #185): an ambient
		// regeneration of this session draws from the pool the flight drew
		// from, not from the operator's clearance on the day of the replay.
		for (const level of [1, 2, 3]) {
			const r = await call('POST', `/__operator/${id}/sessions`, {
				area: 'kyiv', weatherSnapshot: null,
				targetSeed: `api-pool-${level}`, targetCount: 4, targetIndex: 0, swarmChance: 0, clearance: level,
			});
			check(`POST sessions: clearance ${level} -> stored target.scan.families = familiesFor(${level})`,
				r.status === 201
				&& JSON.stringify(r.body.session.target.scan.families) === JSON.stringify(familiesFor(level)),
				JSON.stringify(r.body.session?.target?.scan));
		}
	}

	// --- captures and elision --------------------------------------------------
	const ph = await call('POST', `/__operator/${id}/sessions/${sid1}/photos`, PHOTO);
	check('POST photos: accepted, and the response is already elided',
		ph.status === 201 && ph.body.session.photos.length === 1
		&& ph.body.session.photos[0].dataUrl === undefined
		&& ph.body.session.photos[0].w === 480);

	const full = await call('GET', `/__operator/${id}`);
	check('GET /__operator/:id: no dataUrl in the payload',
		full.status === 200
		&& !JSON.stringify(full.body).includes('data:image/'));

	const one = await call('GET', `/__operator/${id}/sessions/${sid1}`);
	check('GET .../sessions/:sid: the full capture, dataUrl included',
		one.status === 200 && one.body.session.photos[0].dataUrl === PHOTO.dataUrl);

	const missing = await call('GET', `/__operator/${id}/sessions/nexiste-pas-0000`);
	check('GET .../sessions/:sid unknown -> 404', missing.status === 404);

	// --- one photo, as bytes (issue #185, task 7) -------------------------------
	const photoRes = await fetch(`${base}/__operator/${id}/sessions/${sid1}/photos/0`);
	const photoBytes = Buffer.from(await photoRes.arrayBuffer());
	const expectedBytes = Buffer.from(PHOTO.dataUrl.split(',')[1], 'base64');
	check('GET .../photos/:i: 200, image/jpeg, bytes equal the decoded base64',
		photoRes.status === 200
		&& photoRes.headers.get('content-type') === 'image/jpeg'
		&& photoBytes.equals(expectedBytes));
	check('GET .../photos/:i: cache-control is private and immutable',
		photoRes.headers.get('cache-control') === 'private, max-age=31536000, immutable');

	const photoBadSid = await fetch(`${base}/__operator/${id}/sessions/not-a-real-sid/photos/0`);
	check('GET .../photos/:i: bad sid -> 404', photoBadSid.status === 404);

	const photoOutOfRange = await fetch(`${base}/__operator/${id}/sessions/${sid1}/photos/9`);
	check('GET .../photos/:i: out-of-range index -> 404', photoOutOfRange.status === 404);

	const photoOp2 = await call('POST', '/__operator', { name: 'apiphoto2' });
	const photoOtherId = photoOp2.body.operator.id;
	const photoCrossOperator = await fetch(`${base}/__operator/${photoOtherId}/sessions/${sid1}/photos/0`);
	check("GET .../photos/:i: another operator's session -> 404", photoCrossOperator.status === 404);

	// --- deletion ----------------------------------------------------------
	const pending = await call('DELETE', `/__operator/${id}/sessions/${sid2}`);
	check('DELETE a PENDING session -> 409', pending.status === 409);

	const closed = await call('PATCH', `/__operator/${id}/sessions/${sid1}`, {
		result: 'CRASHED',
		telemetry: { durationS: 12, maxSpeedMs: 4, maxRateDps: 90, maxAltitudeM: 3, distanceM: 20 },
	});
	check('PATCH close: CRASHED, elided response', closed.status === 200
		&& closed.body.session.result === 'CRASHED'
		&& closed.body.session.photos[0].dataUrl === undefined);

	// Files written before landing disappeared (D9, 2026-09-08) carry LANDED
	// sessions. No migration, no SCHEMA_VERSION bump: this writes that verdict
	// directly to disk and the state must keep reading back AND accepting an
	// annotation.
	const statePath = path.join(DIR, 'operator-state', `${id}.json`);
	const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8'));
	legacy.sessions.find((x) => x.id === sid1).result = 'LANDED';
	fs.writeFileSync(statePath, JSON.stringify(legacy));
	const legacyRead = await call('GET', `/__operator/${id}`);
	check('an old LANDED session reads back with no migration',
		legacyRead.status === 200
		&& legacyRead.body.operator.sessions.some((x) => x.id === sid1 && x.result === 'LANDED'));
	const legacyNote = await call('PATCH', `/__operator/${id}/sessions/${sid1}/comment`, { comment: 'old flight' });
	check('an old LANDED session still accepts a note',
		legacyNote.status === 200 && legacyNote.body.session.result === 'LANDED');

	const gone = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE a closed session -> 200', gone.status === 200 && gone.body.removed === sid1);

	const after = await call('GET', `/__operator/${id}`);
	check('after DELETE: the session is gone, the counter does not move back',
		after.body.operator.sessions.length === 1
		&& after.body.operator.sessionSeq === 2);

	const again = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE twice -> 404', again.status === 404);

	// The gap: the next session takes 3, not 2.
	const s3 = await call('POST', `/__operator/${id}/sessions`, { area: 'lviv', weatherSnapshot: null });
	check('the next number is 3: a number is never recycled', s3.body.session.seq === 3);

	// --- operator-level PATCH-able keys (PHASE 21, regression #dialogueMemory) ---
	// `dialogueMemory` must be accepted and round-trip: without this test, a
	// regression in OP_WRITABLE_KEYS would go unnoticed until a real browser
	// (which is how the original bug was found).
	const memory = { seen: ['line-042'], ring: ['line-041', 'line-042'] };
	const patched = await call('PATCH', `/__operator/${id}`, { key: 'dialogueMemory', value: memory });
	check('PATCH dialogueMemory: accepted and persisted',
		patched.status === 200 && patched.body.operator.dialogueMemory !== undefined);

	const reread = await call('GET', `/__operator/${id}`);
	check('dialogueMemory round-trips to disk',
		JSON.stringify(reread.body.operator.dialogueMemory) === JSON.stringify(memory));

	// `coverage` (issue #245): same contract as dialogueMemory — accepted,
	// persisted, and bounded client-side only (cap() in src/coverage.js).
	const coverage = { v: 1, z: 20, cells: [[530971, 360731, 3], [530972, 360731, 1]] };
	const covPatched = await call('PATCH', `/__operator/${id}`, { key: 'coverage', value: coverage });
	check('PATCH coverage: accepted and persisted',
		covPatched.status === 200 && covPatched.body.operator.coverage !== undefined);
	const covReread = await call('GET', `/__operator/${id}`);
	check('coverage round-trips to disk',
		JSON.stringify(covReread.body.operator.coverage) === JSON.stringify(coverage));

	// `signals` (issue #185): same contract as coverage — accepted, persisted,
	// bounded client-side only (tools/signal-store-model.mjs).
	const signals = { resolved: {} };
	const sigPatched = await call('PATCH', `/__operator/${id}`, { key: 'signals', value: signals });
	check('PATCH signals: accepted and persisted',
		sigPatched.status === 200 && sigPatched.body.operator.signals !== undefined);
	const sigReread = await call('GET', `/__operator/${id}`);
	check('signals round-trips to disk',
		JSON.stringify(sigReread.body.operator.signals) === JSON.stringify(signals));

	const rejected = await call('PATCH', `/__operator/${id}`, { key: 'notAKey', value: 1 });
	check('PATCH unknown key -> 400', rejected.status === 400
		&& /key is not writable/.test(rejected.body.error ?? ''));

	// `coverage` stays an operator key; the TRACK, though, is NOT one (issue
	// #24): it has its own file and its own route, and OP_WRITABLE_KEYS must
	// never gain an entry for it.
	const asKey = await call('PATCH', `/__operator/${id}`, { key: 'track', value: {} });
	check('PATCH track -> 400: the track is not an operator key', asKey.status === 400);

	// --- flight tracks (issue #24) -------------------------------------------
	const s4 = await call('POST', `/__operator/${id}/sessions`, { area: 'paris', weatherSnapshot: null });
	const sid4 = s4.body.session.id;

	const noneYet = await call('GET', `/__operator/${id}/sessions/${sid4}/track`);
	check('GET track before it is written -> 404', noneYet.status === 404);

	const samples = Array.from({ length: 600 }, (_, i) => ({
		t: i * 0.2,
		lat: 48.8584 + Math.sin(i / 31) * 0.002,
		lon: 2.2945 + Math.cos(i / 37) * 0.003,
		alt: 20 + 10 * Math.sin(i / 19),
		spd: 12 + 5 * Math.cos(i / 13),
		thr: 0.6, rate: 90,
	}));
	const track = encodeTrack(samples, {
		start: { lat: 48.8584, lon: 2.2945 },
		end: { lat: 48.8600, lon: 2.2970, alt: 11.5, spd: 28.4, result: 'CRASHED' },
		photos: [{ i: 0, lat: 48.859, lon: 2.295, heading: 271 }],
	});

	const put = await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, track);
	check('PUT track -> 200, the track is accepted as-is',
		put.status === 200 && put.body.n === 600 && put.body.truncated === false);

	const again2 = await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, track);
	check('PUT track is idempotent: a second send replaces it', again2.status === 200);

	const trackFile = path.join(DIR, 'operator-state', 'tracks', id, `${sid4}.json`);
	check('the track is a FILE next to the operator (D5), not a key inside it',
		fs.existsSync(trackFile)
		&& !JSON.stringify(JSON.parse(fs.readFileSync(path.join(DIR, 'operator-state', `${id}.json`), 'utf8')))
			.includes('"track"'));

	const got = await call('GET', `/__operator/${id}/sessions/${sid4}/track`);
	check('GET track: decoded, in real units, events included',
		got.status === 200
		&& got.body.track.samples.length === 600
		&& Math.abs(got.body.track.samples[0].lat - samples[0].lat) < 1e-5
		&& got.body.track.end.result === 'CRASHED'
		&& got.body.track.photos[0].i === 0);

	const orphan = await call('PUT', `/__operator/${id}/sessions/paris-dead/track`, track);
	check('PUT track for a nonexistent session -> 404', orphan.status === 404);

	const junk = await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, { v: 1, n: 'x' });
	check('PUT malformed track -> 400', junk.status === 400);

	const traversal = await call('PUT', `/__operator/${id}/sessions/..%2F..%2Fevil/track`, track);
	check('PUT track: a session id outside the regex never touches disk',
		traversal.status === 400 || traversal.status === 404);

	const index = await call('GET', `/__operator/${id}/tracks`);
	const entry = index.body.tracks?.[0];
	check('GET /tracks: a decimated polyline, never the raw arrays',
		index.status === 200 && index.body.tracks.length === 1
		&& entry.sessionId === sid4
		&& entry.line.length > 2 && entry.line.length <= 100
		&& entry.start && entry.end.result === 'CRASHED' && entry.photos.length === 1
		&& entry.samples === undefined && entry.lat === undefined);

	const inBox = await call('GET', `/__operator/${id}/tracks?bbox=48.8,2.2,48.9,2.4`);
	const outBox = await call('GET', `/__operator/${id}/tracks?bbox=-10,-10,-9,-9`);
	const badBox = await call('GET', `/__operator/${id}/tracks?bbox=nope`);
	check('GET /tracks?bbox=: filters, and refuses an unreadable bbox',
		inBox.body.tracks.length === 1 && outBox.body.tracks.length === 0 && badBox.status === 400);

	const withFlag = await call('GET', `/__operator/${id}`);
	const flagged = withFlag.body.operator.sessions.find((x) => x.id === sid4);
	const unflagged = withFlag.body.operator.sessions.find((x) => x.id !== sid4);
	check('hasTrack is derived on the session list',
		flagged.hasTrack === true && unflagged.hasTrack === false);
	check('hasTrack is NOT stored on disk',
		!JSON.parse(fs.readFileSync(path.join(DIR, 'operator-state', `${id}.json`), 'utf8'))
			.sessions.some((x) => 'hasTrack' in x));

	// Retention (D3): past TRACK_KEEP files, the oldest ones leave.
	const dir = path.dirname(trackFile);
	const tiny = JSON.stringify(encodeTrack([]));
	for (let i = 0; i < TRACK_KEEP + 10; i++) {
		const f = path.join(dir, `old-${String(i).padStart(4, '0')}-aaaa.json`);
		fs.writeFileSync(f, tiny);
		// Distinct and increasing mtimes: the real track must stay the most
		// recent, so the fake ones are dated in the past.
		const t = Date.now() / 1000 - (TRACK_KEEP + 20 - i) * 60;
		fs.utimesSync(f, t, t);
	}
	await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, track);
	const left = fs.readdirSync(dir);
	check('pruneTracks after a write: at most 200 tracks, the new one survives',
		left.length === TRACK_KEEP && left.includes(`${sid4}.json`));

	// Deleting the session takes its track with it: no orphan against the quota.
	await call('PATCH', `/__operator/${id}/sessions/${sid4}`, {
		result: 'CRASHED',
		telemetry: { durationS: 120, maxSpeedMs: 28, maxRateDps: 300, maxAltitudeM: 40, distanceM: 900 },
	});
	await call('DELETE', `/__operator/${id}/sessions/${sid4}`);
	check('DELETE session: its track leaves with it', !fs.existsSync(trackFile));

	// --- shared mode: the photo route asks for the key ------------------------
	// A SECOND server: api.mjs holds its mode as module state, one server per
	// process (tools/server-selftest.mjs does the same).
	const sPhoto = await call('POST', `/__operator/${id}/sessions`, { area: 'kyiv', weatherSnapshot: null });
	await call('POST', `/__operator/${id}/sessions/${sPhoto.body.session.id}/photos`, PHOTO);
	await started.close();
	started = await startServer({ dataDir: DIR, distDir: path.join(DIR, 'dist'), port: '0', mode: 'shared' });
	const sbase = started.url.replace(/\/$/, '');
	const photoUrl = `${sbase}/__operator/${id}/sessions/${sPhoto.body.session.id}/photos/0`;
	const noKey = await fetch(photoUrl);
	check('shared: GET .../photos/:i without a key -> 401', noKey.status === 401, `${noKey.status}`);
	const withKey = await fetch(photoUrl, { headers: { authorization: `Bearer ${created.body.key}` } });
	check('shared: GET .../photos/:i with the key -> 200', withKey.status === 200, `${withKey.status}`);
} finally {
	await started.close();
	fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
