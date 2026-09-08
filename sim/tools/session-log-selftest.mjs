// Selftest du modèle Session Log / Target Log (PHASE 17). Aucune E/S.
// Lancer : node tools/session-log-selftest.mjs
import assert from 'node:assert/strict';
import {
	SESSION_FILTERS, filterSessions, sessionRow, sessionDetail,
	targetLogEntries, targetRow, areaLabel, stamp, duration, pad, fit, liveAreaId,
} from './session-log-model.mjs';
import { terminalModel } from './terminal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const TARGET = {
	family: 'heavy5', classHint: null, hackType: 'FIRMWARE OVERRIDE',
	signal: { rssiDbm: -71, mode: 'ANALOG' }, scannedAt: null, intel: {},
};

const WEATHER = {
	zone: '48.86,2.29', day: '2026-08-28', source: 'open-meteo',
	regime: 'CLEAR', confidence: 0.94,
	day0: { regime: 'CLEAR', windSpeed: 2.4, windDir: 210, windGust: 3.6, rateMmH: 0, visibilityM: 14200, cloudPct: 10 },
};

const mk = (over = {}) => ({
	id: 'tour-eiffel-a3f2', operatorId: 'neo-0000', area: 'tour-eiffel',
	seq: 421, targetSeq: 42, target: TARGET, weatherSnapshot: WEATHER,
	start: '2026-08-28T21:42:10.000Z', end: '2026-08-28T22:00:52.000Z',
	result: 'CRASHED',
	flightTelemetry: { durationS: 1122, maxSpeedMs: 19.4, maxRateDps: 640, maxAltitudeM: 87, distanceM: 4210 },
	randomart: '+--[ART]--+', photos: [], comment: null, resumeCount: 0,
	...over,
});

// --- formateurs -------------------------------------------------------------

t('pad : largeur fixe, zéros à gauche, plancher à 0', () => {
	assert.equal(pad(421), '00421');
	assert.equal(pad(42, 3), '042');
	assert.equal(pad(0, 2), '00');
	assert.equal(pad(undefined), '00000');
	assert.equal(pad(-3, 2), '00');
});

t('areaLabel : le libellé vient du slug, pas de scenes.json', () => {
	assert.equal(areaLabel('tour-eiffel'), 'TOUR EIFFEL');
	assert.equal(areaLabel('ile-de-la-cite-et-ile-saint-louis'), 'ILE DE LA CITE ET ILE SAINT LOUIS');
	assert.equal(areaLabel(''), 'UNKNOWN AREA');
	assert.equal(areaLabel(null), 'UNKNOWN AREA');
});

t('duration : minutes + secondes, secondes seules sous la minute', () => {
	assert.equal(duration(1122), '18m 42s');
	assert.equal(duration(42), '42s');
	assert.equal(duration(60), '1m 00s');
	assert.equal(duration(0), '0s');
	assert.equal(duration(undefined), '0s');
	assert.equal(duration(-5), '0s');
});

t('stamp : JJ.MM.AA / HH:MM, tiret sur une date illisible', () => {
	// Heure LOCALE : on compare à ce que Date rend sur cette machine, pas à une
	// chaîne figée — sinon le test casse selon le fuseau du runner.
	const d = new Date('2026-08-28T21:42:10.000Z');
	const p = (x) => String(x).padStart(2, '0');
	const want = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)} / ${p(d.getHours())}:${p(d.getMinutes())}`;
	assert.equal(stamp('2026-08-28T21:42:10.000Z'), want);
	assert.equal(stamp('pas une date'), '—');
	assert.equal(stamp(null), '—');
});

// --- filtres ----------------------------------------------------------------

t('SESSION_FILTERS : les trois filtres restants, dans l’ordre', () => {
	// LANDED est parti avec l'atterrissage (D9, 2026-09-08) : un vol se termine
	// par un crash, une sortie de zone ou une coupure — tous CRASHED.
	assert.deepEqual(SESSION_FILTERS, ['ALL', 'CRASHED', 'WITH PHOTOS']);
});

t('filterSessions : chaque filtre ne garde que ce qu’il annonce', () => {
	const list = [
		mk({ id: 'a', result: 'CRASHED', photos: [{ w: 1, h: 1, ts: 'x' }] }),
		mk({ id: 'b', result: 'CRASHED', photos: [] }),
		mk({ id: 'c', result: 'PENDING', photos: [] }),
	];
	assert.deepEqual(filterSessions(list, 'ALL').map((s) => s.id), ['a', 'b', 'c']);
	assert.deepEqual(filterSessions(list, 'CRASHED').map((s) => s.id), ['a', 'b']);
	assert.deepEqual(filterSessions(list, 'WITH PHOTOS').map((s) => s.id), ['a']);
});

t('filterSessions : filtre inconnu ou entrée non-tableau → repli sûr', () => {
	const list = [mk()];
	assert.equal(filterSessions(list, 'NOPE').length, 1);
	assert.deepEqual(filterSessions(null, 'ALL'), []);
	assert.deepEqual(filterSessions(undefined, 'CRASHED'), []);
});

t('filterSessions : ne mute jamais le tableau reçu', () => {
	const list = [mk()];
	const out = filterSessions(list, 'ALL');
	out.push(mk({ id: 'z' }));
	assert.equal(list.length, 1);
});

// --- ligne de liste ---------------------------------------------------------

t('sessionRow : numéro, zone, cible, verdict, durée', () => {
	const row = sessionRow(mk());
	assert.match(row, /SESSION 00421/);
	assert.match(row, /TOUR EIFFEL/);
	assert.match(row, /TARGET 042/);
	assert.match(row, /CRASHED/);
	assert.match(row, /18m 42s/);
});

// Les fichiers opérateur écrits avant la disparition de l'atterrissage (D9,
// 2026-09-08) contiennent des sessions LANDED. Aucune migration, aucun bump de
// SCHEMA_VERSION : elles se relisent et s'affichent telles quelles.
t('sessionRow : une vieille session LANDED s’affiche encore, telle quelle', () => {
	const row = sessionRow(mk({ result: 'LANDED' }));
	assert.match(row, /LANDED/);
	assert.equal(row.length, sessionRow(mk()).length);
	assert.deepEqual(filterSessions([mk({ id: 'old', result: 'LANDED' })], 'ALL').map((s) => s.id), ['old']);
	assert.match(targetRow(targetLogEntries([mk({ result: 'LANDED' })])[0]), /LANDED/);
});

t('sessionRow : une session sans cible le dit, elle ne ment pas', () => {
	const row = sessionRow(mk({ target: null, targetSeq: undefined }));
	assert.match(row, /NO TARGET/);
	assert.doesNotMatch(row, /TARGET 0/);
});

// --- détail -----------------------------------------------------------------

t('sessionDetail : tous les blocs de la Bible §28 quand la donnée est là', () => {
	const d = sessionDetail(mk({ photos: [{ w: 1, h: 1, ts: 'x' }], comment: 'best signal so far' }));
	assert.match(d, /SESSION 00421/);
	assert.match(d, /TOUR EIFFEL/);
	assert.match(d, /TARGET 042/);
	assert.match(d, /HEAVY 5"/);          // le label de PROFILES, pas le slug de famille
	assert.match(d, /-71 dBm ANALOG/);
	assert.match(d, /FIRMWARE OVERRIDE/);
	assert.match(d, /RANDOMART/);
	assert.match(d, /WEATHER/);
	assert.match(d, /CLEAR/);
	assert.match(d, /WIND 2\.4 m\/s/);
	assert.match(d, /VIS 14 km/);
	assert.match(d, /FLIGHT/);
	assert.match(d, /18m 42s/);
	assert.match(d, /CAPTURES\n01/);
	assert.match(d, /OPERATOR NOTE\n"best signal so far"/);
});

t('sessionDetail : les blocs absents sont omis, pas inventés', () => {
	const d = sessionDetail(mk({
		target: null, targetSeq: undefined, weatherSnapshot: null,
		randomart: null, comment: null, photos: [],
	}));
	assert.doesNotMatch(d, /TARGET 0/);
	assert.doesNotMatch(d, /WEATHER/);
	assert.doesNotMatch(d, /RANDOMART/);
	assert.doesNotMatch(d, /OPERATOR NOTE/);
	assert.match(d, /CAPTURES\n00/);   // zéro capture reste affiché : c'est une info
	assert.match(d, /FLIGHT/);
});

t('sessionDetail : la pluie n’apparaît que s’il pleut', () => {
	const dry = sessionDetail(mk());
	assert.doesNotMatch(dry, /RAIN/);
	const wet = sessionDetail(mk({
		weatherSnapshot: { ...WEATHER, day0: { ...WEATHER.day0, rateMmH: 0.66 } },
	}));
	assert.match(wet, /RAIN 0\.7 mm\/h/);
});

// --- Target Log (dérivé) ----------------------------------------------------

t('targetLogEntries : dérivé des sessions, plus récent d’abord', () => {
	const list = [
		mk({ id: 'a', seq: 1, targetSeq: 1 }),
		mk({ id: 'b', seq: 2, targetSeq: 2, result: 'CRASHED' }),
		mk({ id: 'c', seq: 3, targetSeq: 3 }),
	];
	const e = targetLogEntries(list);
	assert.deepEqual(e.map((x) => x.targetSeq), [3, 2, 1]);
	assert.equal(e[1].result, 'CRASHED');
	assert.equal(e[0].sessionId, 'c');
	assert.equal(e[0].label, 'HEAVY 5"');
	assert.equal(e[0].hackType, 'FIRMWARE OVERRIDE');
});

t('targetLogEntries : une session sans cible n’entre pas au log', () => {
	const list = [mk({ id: 'a', seq: 1, targetSeq: 1 }), mk({ id: 'b', seq: 2, target: null, targetSeq: undefined })];
	const e = targetLogEntries(list);
	assert.equal(e.length, 1);
	assert.equal(e[0].sessionId, 'a');
});

t('targetLogEntries : entrée non-tableau → liste vide', () => {
	assert.deepEqual(targetLogEntries(null), []);
	assert.deepEqual(targetLogEntries(undefined), []);
});

t('targetRow : numéro, famille, signal, zone, date, verdict', () => {
	const row = targetRow(targetLogEntries([mk()])[0]);
	assert.match(row, /TARGET 042/);
	assert.match(row, /HEAVY 5"/);
	assert.match(row, /-71 dBm ANALOG/);
	assert.match(row, /TOUR EIFFEL/);
	assert.match(row, /CRASHED/);
});

t('sessionRow : une zone longue est coupée, elle ne pousse pas les colonnes', () => {
	const court = sessionRow(mk());
	const long = sessionRow(mk({ area: 'conservatoire-national-des-arts-et-metiers' }));
	// Le décalage d'une colonne, c'est la fin de la table : chaque ligne doit
	// avoir exactement la même longueur, quelle que soit la longueur du nom.
	assert.equal(long.length, court.length);
	assert.match(long, /CONSERVATOIRE/);
	assert.match(long, /CRASHED/);         // le verdict survit à la coupe
	assert.match(long, /…/);               // et la coupe se voit
});

t('targetRow : une zone longue est coupée, elle ne pousse pas les colonnes', () => {
	const court = targetRow(targetLogEntries([mk()])[0]);
	const long = targetRow(targetLogEntries([mk({ area: 'conservatoire-national-des-arts-et-metiers' })])[0]);
	assert.equal(long.length, court.length);
	assert.match(long, /CRASHED/);
});

t('fit : complète à droite, coupe avec une ellipse, ne rend jamais plus long', () => {
	assert.equal(fit('AB', 5), 'AB   ');
	assert.equal(fit('ABCDE', 5), 'ABCDE');
	assert.equal(fit('ABCDEF', 5), 'ABCD…');
	assert.equal(fit('', 3), '   ');
	assert.equal(fit('ABCDEF', 1), '…');
});

t('liveAreaId : préfixé, pour ne jamais se confondre avec une zone acquise', () => {
	// REVISIT est conditionné à `model.areas.some(a => a.slug === area)` : sans
	// préfixe, un vol en direct au-dessus d'un quartier homonyme d'une zone
	// acquise proposerait de revisiter le mauvais terrain.
	assert.equal(liveAreaId('Odeon', 48.8499, 2.3419), 'live-Odeon');
	assert.match(liveAreaId('paristest', 48.85, 2.34), /^live-/);
	assert.notEqual(liveAreaId('paristest', 48.85, 2.34), 'paristest');
});

t('liveAreaId : sans nom, les coordonnées — deux vols au même endroit se rejoignent', () => {
	assert.equal(liveAreaId(null, 48.8499, 2.3419), 'live-48.8499-2.3419');
	assert.equal(liveAreaId('   ', 48.8499, 2.3419), liveAreaId(null, 48.8499, 2.3419));
	// Rien d'exploitable : on ne fabrique pas de coordonnées, on met zéro.
	assert.equal(liveAreaId(null, NaN, undefined), 'live-0-0');
});

t('liveAreaId : le libellé du journal reste lisible', () => {
	assert.equal(areaLabel(liveAreaId('Odeon', 48.85, 2.34)), 'LIVE ODEON');
});

// --- LIVE flights fill the archives (D7, #8) --------------------------------
// A LIVE flight has no scene on disk: its area is a `live-` id (liveAreaId),
// never a slug from scenes.json. It must still land in every archive a
// terrain-backed flight lands in, exactly the same way.

t('un vol LIVE apparaît au SESSION LOG et au TARGET LOG, et il est compté par le modèle OPERATOR', () => {
	const liveArea = liveAreaId('Paris', 48.85, 2.35);
	const live = mk({
		id: 'live-0001', area: liveArea, result: 'CRASHED', targetSeq: 99,
		target: { family: 'racer3', classHint: null, hackType: null, signal: { rssiDbm: -80, mode: 'DIGITAL' }, scannedAt: null, intel: {} },
	});
	const sessions = [mk(), live];

	// SESSION LOG : la ligne existe et porte le bon libellé de zone.
	assert.deepEqual(filterSessions(sessions, 'ALL').map((s) => s.id), ['tour-eiffel-a3f2', 'live-0001']);
	const row = sessionRow(live);
	assert.match(row, /LIVE PARIS/);
	assert.match(row, /CRASHED/);

	// TARGET LOG : dérivé des sessions (spec D1), donc la cible du vol LIVE y
	// est aussi, avec le même libellé de zone.
	const entries = targetLogEntries(sessions);
	const liveEntry = entries.find((e) => e.sessionId === 'live-0001');
	assert.ok(liveEntry, 'le vol LIVE doit apparaître au Target Log');
	assert.equal(liveEntry.area, liveArea);
	assert.match(targetRow(liveEntry), /LIVE PARIS/);

	// La ligne archivée ne porte aucune décision d'action : REVISIT et RESUME
	// sont un gate du rendu (`areas.some(...)`, terminal.js/session-log.js),
	// jamais une donnée de l'archive elle-même.
	assert.ok(!('revisit' in liveEntry) && !('resume' in liveEntry));

	// OPERATOR : compté comme n'importe quelle autre session. C'est le compteur
	// de l'écran ARCHIVE › OPERATOR (terminal.js), le seul endroit où les
	// compteurs vivent depuis D1 — le pied de FIELD ne compte plus rien.
	const model = terminalModel({ operator: { name: 'neo', sessions }, scenes: [] });
	assert.equal(sessions.length, 2, 'le vol LIVE compte comme une session');
	assert.equal(targetLogEntries(sessions).length, 2, 'et sa cible compte comme une cible');
	assert.equal(model.operatorName, 'NEO');
});

t('un vol LIVE n\'est jamais revisitable : sa zone live- ne correspond à aucune zone connue', () => {
	const liveArea = liveAreaId('Paris', 48.85, 2.35);
	// C'est exactement le test que fait session-log.js/terminal.js avant
	// d'afficher REVISIT AREA : `areas.some((a) => a.slug === area)`.
	const model = terminalModel({ operator: { name: 'neo', sessions: [] }, scenes: [] });
	assert.ok(!model.areas.some((a) => a.slug === liveArea));
});

console.log(`\n${n} ok`);
