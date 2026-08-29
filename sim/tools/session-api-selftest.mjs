// Selftest des routes de session (PHASE 17) contre un VRAI serveur de dev.
//
// Contrairement aux autres selftests, celui-ci démarre Vite : il est lent et
// n'est donc PAS chaîné dans `npm run selftest:operator`. Lancer :
//   npm run selftest:api
//
// L'état opérateur est redirigé vers un répertoire temporaire via
// FPV_OPERATOR_DIR — lu par map-api-plugin.mjs à son chargement, d'où le
// process.env AVANT l'import de vite. Le fichier opérateur réel de
// l'utilisateur n'est ni lu ni écrit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-api-'));
process.env.FPV_OPERATOR_DIR = DIR;

const { createServer } = await import('vite');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// `strictPort: false` + port 0 : on prend n'importe quel port libre, pour ne pas
// entrer en collision avec un `npm run dev` déjà ouvert. On lit l'URL que Vite
// a RÉSOLUE plutôt que de la reconstruire : `httpServer.address()` rend le port
// mais pas l'hôte, et Vite écoute sur `localhost` — qui vaut `::1` ici, pas
// `127.0.0.1`.
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

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
		result: 'LANDED',
		telemetry: { durationS: 12, maxSpeedMs: 4, maxRateDps: 90, maxAltitudeM: 3, distanceM: 20 },
	});
	check('PATCH clôture : LANDED, réponse élidée', closed.status === 200
		&& closed.body.session.result === 'LANDED'
		&& closed.body.session.photos[0].dataUrl === undefined);

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
} finally {
	await server.close();
	fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
