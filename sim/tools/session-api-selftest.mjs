// Selftest des routes de session (PHASE 17) contre un VRAI serveur.
//
// Depuis l'extraction du serveur autonome (issue #259), c'est server/index.mjs
// qui est démarré ici, pas Vite : ce selftest teste ce qui est livré. Un check
// de fumée séparé (tools/vite-adapter-selftest.mjs) garde l'adaptateur Vite
// honnête.
//
// Tout l'état va dans un répertoire de données jetable — d'où le process.env
// AVANT le premier import qui remonterait à tools/lib/paths.mjs, qui lit la
// variable à son chargement. L'état opérateur réel de l'utilisateur n'est ni lu
// ni écrit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-api-'));
process.env.FPVTP_DATA_DIR = DIR;
delete process.env.FPV_OPERATOR_DIR;

const { startServer } = await import('../server/index.mjs');
const { encodeTrack, TRACK_KEEP } = await import('./track-model.mjs');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// Port 0 : n'importe quel port libre, pour ne pas entrer en collision avec un
// `npm run dev` déjà ouvert. On lit l'URL que le serveur a RÉSOLUE plutôt que de
// la reconstruire.
const started = await startServer({ dataDir: DIR, distDir: path.join(DIR, 'dist'), port: '0' });
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
	// --- un opérateur, deux sessions -----------------------------------------
	const created = await call('POST', '/__operator', { name: 'apitest' });
	check('POST /__operator crée un opérateur v2', created.status === 201
		&& created.body.operator.schemaVersion === 2
		&& created.body.operator.sessionSeq === 0
		&& !('targetLog' in created.body.operator));
	const id = created.body.operator.id;

	const s1 = await call('POST', `/__operator/${id}/sessions`, {
		area: 'tour-eiffel', weatherSnapshot: null,
		targetSeed: 'api-seed', targetCount: 4, targetIndex: 1,
	});
	check('POST sessions : première session numérotée 1 / cible 1',
		s1.status === 201 && s1.body.session.seq === 1 && s1.body.session.targetSeq === 1);
	const sid1 = s1.body.session.id;

	// Session sans TARGET SCAN (chemin dev) : elle ne consomme pas de numéro de
	// cible.
	const s2 = await call('POST', `/__operator/${id}/sessions`, { area: 'kyiv', weatherSnapshot: null });
	check('POST sessions : une session sans cible ne consomme pas de targetSeq',
		s2.status === 201 && s2.body.session.seq === 2 && s2.body.session.targetSeq == null);
	const sid2 = s2.body.session.id;

	// --- captures et élision --------------------------------------------------
	const ph = await call('POST', `/__operator/${id}/sessions/${sid1}/photos`, PHOTO);
	check('POST photos : accepté, et la réponse est déjà élidée',
		ph.status === 201 && ph.body.session.photos.length === 1
		&& ph.body.session.photos[0].dataUrl === undefined
		&& ph.body.session.photos[0].w === 480);

	const full = await call('GET', `/__operator/${id}`);
	check('GET /__operator/:id : aucune dataUrl dans la charge utile',
		full.status === 200
		&& !JSON.stringify(full.body).includes('data:image/'));

	const one = await call('GET', `/__operator/${id}/sessions/${sid1}`);
	check('GET .../sessions/:sid : la capture complète, dataUrl comprise',
		one.status === 200 && one.body.session.photos[0].dataUrl === PHOTO.dataUrl);

	const missing = await call('GET', `/__operator/${id}/sessions/nexiste-pas-0000`);
	check('GET .../sessions/:sid inconnue → 404', missing.status === 404);

	// --- suppression ----------------------------------------------------------
	const pending = await call('DELETE', `/__operator/${id}/sessions/${sid2}`);
	check('DELETE une session PENDING → 409', pending.status === 409);

	const closed = await call('PATCH', `/__operator/${id}/sessions/${sid1}`, {
		result: 'CRASHED',
		telemetry: { durationS: 12, maxSpeedMs: 4, maxRateDps: 90, maxAltitudeM: 3, distanceM: 20 },
	});
	check('PATCH clôture : CRASHED, réponse élidée', closed.status === 200
		&& closed.body.session.result === 'CRASHED'
		&& closed.body.session.photos[0].dataUrl === undefined);

	// Les fichiers écrits avant la disparition de l'atterrissage (D9,
	// 2026-09-08) portent des sessions LANDED. Aucune migration, aucun bump de
	// SCHEMA_VERSION : on écrit ce verdict directement sur le disque et l'état
	// doit continuer à se relire ET à se laisser annoter.
	const statePath = path.join(DIR, 'operator-state', `${id}.json`);
	const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8'));
	legacy.sessions.find((x) => x.id === sid1).result = 'LANDED';
	fs.writeFileSync(statePath, JSON.stringify(legacy));
	const legacyRead = await call('GET', `/__operator/${id}`);
	check('une vieille session LANDED se relit sans migration',
		legacyRead.status === 200
		&& legacyRead.body.operator.sessions.some((x) => x.id === sid1 && x.result === 'LANDED'));
	const legacyNote = await call('PATCH', `/__operator/${id}/sessions/${sid1}/comment`, { comment: 'vieux vol' });
	check('une vieille session LANDED accepte encore une note',
		legacyNote.status === 200 && legacyNote.body.session.result === 'LANDED');

	const gone = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE une session close → 200', gone.status === 200 && gone.body.removed === sid1);

	const after = await call('GET', `/__operator/${id}`);
	check('après DELETE : la session a disparu, le compteur ne recule pas',
		after.body.operator.sessions.length === 1
		&& after.body.operator.sessionSeq === 2);

	const again = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE deux fois → 404', again.status === 404);

	// Le trou : la prochaine session prend 3, pas 2.
	const s3 = await call('POST', `/__operator/${id}/sessions`, { area: 'lviv', weatherSnapshot: null });
	check('le numéro suivant est 3 : un numéro ne se recycle pas', s3.body.session.seq === 3);

	// --- clés PATCH-ables au niveau opérateur (PHASE 21, regression #dialogueMemory) ---
	// `dialogueMemory` doit être accepté et faire l'aller-retour : sans ce test,
	// une régression de OP_WRITABLE_KEYS repasse inaperçue jusqu'à un vrai
	// navigateur (c'est ainsi que le bug initial a été trouvé).
	const memory = { seen: ['line-042'], ring: ['line-041', 'line-042'] };
	const patched = await call('PATCH', `/__operator/${id}`, { key: 'dialogueMemory', value: memory });
	check('PATCH dialogueMemory : accepté et persisté',
		patched.status === 200 && patched.body.operator.dialogueMemory !== undefined);

	const reread = await call('GET', `/__operator/${id}`);
	check('dialogueMemory fait l\'aller-retour sur disque',
		JSON.stringify(reread.body.operator.dialogueMemory) === JSON.stringify(memory));

	// `coverage` (issue #245) : même contrat que dialogueMemory — acceptée,
	// persistée, et bornée côté client seulement (cap() dans src/coverage.js).
	const coverage = { v: 1, z: 20, cells: [[530971, 360731, 3], [530972, 360731, 1]] };
	const covPatched = await call('PATCH', `/__operator/${id}`, { key: 'coverage', value: coverage });
	check('PATCH coverage : acceptée et persistée',
		covPatched.status === 200 && covPatched.body.operator.coverage !== undefined);
	const covReread = await call('GET', `/__operator/${id}`);
	check('coverage fait l\'aller-retour sur disque',
		JSON.stringify(covReread.body.operator.coverage) === JSON.stringify(coverage));

	const rejected = await call('PATCH', `/__operator/${id}`, { key: 'notAKey', value: 1 });
	check('PATCH clé inconnue → 400', rejected.status === 400
		&& /clé non modifiable/.test(rejected.body.error ?? ''));

	// `coverage` reste une clé opérateur ; la PISTE, elle, n'en est PAS une
	// (issue #24) : elle a son fichier et sa route, et OP_WRITABLE_KEYS ne doit
	// jamais gagner d'entrée pour elle.
	const asKey = await call('PATCH', `/__operator/${id}`, { key: 'track', value: {} });
	check('PATCH track → 400 : la piste n\'est pas une clé opérateur', asKey.status === 400);

	// --- pistes de vol (issue #24) -------------------------------------------
	const s4 = await call('POST', `/__operator/${id}/sessions`, { area: 'paris', weatherSnapshot: null });
	const sid4 = s4.body.session.id;

	const noneYet = await call('GET', `/__operator/${id}/sessions/${sid4}/track`);
	check('GET track avant écriture → 404', noneYet.status === 404);

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
	check('PUT track → 200, la piste est acceptée telle quelle',
		put.status === 200 && put.body.n === 600 && put.body.truncated === false);

	const again2 = await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, track);
	check('PUT track est idempotent : un second envoi remplace', again2.status === 200);

	const trackFile = path.join(DIR, 'operator-state', 'tracks', id, `${sid4}.json`);
	check('la piste est un FICHIER à côté de l\'opérateur (D5), pas une clé dedans',
		fs.existsSync(trackFile)
		&& !JSON.stringify(JSON.parse(fs.readFileSync(path.join(DIR, 'operator-state', `${id}.json`), 'utf8')))
			.includes('"track"'));

	const got = await call('GET', `/__operator/${id}/sessions/${sid4}/track`);
	check('GET track : décodée, en unités réelles, événements compris',
		got.status === 200
		&& got.body.track.samples.length === 600
		&& Math.abs(got.body.track.samples[0].lat - samples[0].lat) < 1e-5
		&& got.body.track.end.result === 'CRASHED'
		&& got.body.track.photos[0].i === 0);

	const orphan = await call('PUT', `/__operator/${id}/sessions/paris-dead/track`, track);
	check('PUT track pour une session inexistante → 404', orphan.status === 404);

	const junk = await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, { v: 1, n: 'x' });
	check('PUT track malformée → 400', junk.status === 400);

	const traversal = await call('PUT', `/__operator/${id}/sessions/..%2F..%2Fevil/track`, track);
	check('PUT track : un id de session hors regex ne touche pas le disque',
		traversal.status === 400 || traversal.status === 404);

	const index = await call('GET', `/__operator/${id}/tracks`);
	const entry = index.body.tracks?.[0];
	check('GET /tracks : polyligne décimée, jamais les tableaux bruts',
		index.status === 200 && index.body.tracks.length === 1
		&& entry.sessionId === sid4
		&& entry.line.length > 2 && entry.line.length <= 100
		&& entry.start && entry.end.result === 'CRASHED' && entry.photos.length === 1
		&& entry.samples === undefined && entry.lat === undefined);

	const inBox = await call('GET', `/__operator/${id}/tracks?bbox=48.8,2.2,48.9,2.4`);
	const outBox = await call('GET', `/__operator/${id}/tracks?bbox=-10,-10,-9,-9`);
	const badBox = await call('GET', `/__operator/${id}/tracks?bbox=nope`);
	check('GET /tracks?bbox= : filtre, et refuse une bbox illisible',
		inBox.body.tracks.length === 1 && outBox.body.tracks.length === 0 && badBox.status === 400);

	const withFlag = await call('GET', `/__operator/${id}`);
	const flagged = withFlag.body.operator.sessions.find((x) => x.id === sid4);
	const unflagged = withFlag.body.operator.sessions.find((x) => x.id !== sid4);
	check('hasTrack est dérivé sur la liste des sessions',
		flagged.hasTrack === true && unflagged.hasTrack === false);
	check('hasTrack n\'est PAS stocké sur disque',
		!JSON.parse(fs.readFileSync(path.join(DIR, 'operator-state', `${id}.json`), 'utf8'))
			.sessions.some((x) => 'hasTrack' in x));

	// La rétention (D3) : au-delà de TRACK_KEEP fichiers, les plus vieux partent.
	const dir = path.dirname(trackFile);
	const tiny = JSON.stringify(encodeTrack([]));
	for (let i = 0; i < TRACK_KEEP + 10; i++) {
		const f = path.join(dir, `old-${String(i).padStart(4, '0')}-aaaa.json`);
		fs.writeFileSync(f, tiny);
		// mtimes distincts et croissants : la piste réelle doit rester la plus
		// récente, donc les fausses sont datées dans le passé.
		const t = Date.now() / 1000 - (TRACK_KEEP + 20 - i) * 60;
		fs.utimesSync(f, t, t);
	}
	await call('PUT', `/__operator/${id}/sessions/${sid4}/track`, track);
	const left = fs.readdirSync(dir);
	check('pruneTracks après écriture : au plus 200 pistes, la nouvelle survit',
		left.length === TRACK_KEEP && left.includes(`${sid4}.json`));

	// Supprimer la session emporte sa piste : pas d'orphelin sur le quota.
	await call('PATCH', `/__operator/${id}/sessions/${sid4}`, {
		result: 'CRASHED',
		telemetry: { durationS: 120, maxSpeedMs: 28, maxRateDps: 300, maxAltitudeM: 40, distanceM: 900 },
	});
	await call('DELETE', `/__operator/${id}/sessions/${sid4}`);
	check('DELETE session : la piste part avec elle', !fs.existsSync(trackFile));
} finally {
	await started.close();
	fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
