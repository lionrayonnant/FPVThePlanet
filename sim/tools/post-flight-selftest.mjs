// Selftest de la logique pure du POST-FLIGHT ANALYSIS (PHASE 15).
// Lancer : node tools/post-flight-selftest.mjs
import assert from 'node:assert/strict';
import { analyzeFlight, POST_FLIGHT_THRESHOLDS } from './post-flight-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('vol trop bref : tout reste UNKNOWN', () => {
	const r = analyzeFlight({ maxSpeedMs: 40, maxRateDps: 800, durationS: 1 });
	assert.equal(r.profile, null);
	assert.equal(r.estimated, null);
});

t('vol suffisant pour un PROFILE mais pas pour ESTIMATED (règle #52 : 20 s n\'estime pas la masse)', () => {
	const r = analyzeFlight({ maxSpeedMs: 40, maxRateDps: 800, durationS: 20 });
	assert.ok(r.profile, 'un PROFILE doit être deviné');
	assert.equal(r.estimated, null);
	assert.ok(20 < POST_FLIGHT_THRESHOLDS.MIN_ESTIMATE_S);
});

t('vol long : PROFILE + ESTIMATED présents', () => {
	const r = analyzeFlight({ maxSpeedMs: 40, maxRateDps: 800, durationS: 60 });
	assert.ok(r.profile);
	assert.ok(r.estimated);
	assert.ok(Number.isFinite(r.estimated.massG) && r.estimated.massG > 0);
	assert.ok(Number.isFinite(r.estimated.fovDeg) && r.estimated.fovDeg > 0);
	assert.ok(Number.isFinite(r.estimated.responseMs) && r.estimated.responseMs > 0);
	assert.ok(r.profile.confidencePct >= 0 && r.profile.confidencePct <= 100);
});

t('un pic de rate proche du plafond freestyle devine freestyle5', () => {
	const r = analyzeFlight({ maxSpeedMs: 40, maxRateDps: 800, durationS: 60 });
	assert.equal(r.profile.family, 'freestyle5');
});

t('un pic de rate impossible pour toute famille sauf race5 isole race5 à 100 %', () => {
	const r = analyzeFlight({ maxSpeedMs: 90, maxRateDps: 1050, durationS: 60 });
	assert.equal(r.profile.family, 'race5');
	assert.equal(r.profile.confidencePct, 100);
});

t('un pic de rate faible (longrange/cinematic/micro seuls plausibles) exclut freestyle5/race5', () => {
	const r = analyzeFlight({ maxSpeedMs: 10, maxRateDps: 300, durationS: 60 });
	assert.ok(['longrange', 'cinewhoop', 'heavy5', 'toothpick'].includes(r.profile.family));
});

t('déterministe : mêmes entrées, même sortie', () => {
	const a = analyzeFlight({ maxSpeedMs: 55.5, maxRateDps: 710, durationS: 120 });
	const b = analyzeFlight({ maxSpeedMs: 55.5, maxRateDps: 710, durationS: 120 });
	assert.deepEqual(a, b);
});

t('rate observé au-delà de tout plafond (télémétrie incohérente) : PROFILE UNKNOWN plutôt qu\'un mensonge', () => {
	const r = analyzeFlight({ maxSpeedMs: 10, maxRateDps: 5000, durationS: 60 });
	assert.equal(r.profile, null);
});

console.log(`\n${n} ok`);
process.exit(0);
