// Selftest de la timeline pure de l'intro (issue #106). Aucune E/S, aucun DOM,
// aucune Web Audio. Lancer : node tools/intro-selftest.mjs
import assert from 'node:assert/strict';
import {
	INTRO_PHASES, INTRO_TOTAL_MS, RESOLUTION_AT_MS,
	phaseAt, skipPhase, SKIP_WRAP_MS,
} from './intro-model.mjs';
import { INTRO_SCORE_MS } from './ui-audio-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- timeline ---------------------------------------------------------------

t('INTRO_PHASES : trois mouvements nommés, dans l\'ordre, durées positives', () => {
	assert.deepEqual(INTRO_PHASES.map((p) => p.name), ['reveal', 'plasma', 'resolution']);
	for (const p of INTRO_PHASES) assert.ok(p.durMs > 0, `${p.name} : durée non positive`);
});

t('INTRO_TOTAL_MS : environ 7 secondes', () => {
	assert.equal(INTRO_TOTAL_MS, 7000);
	assert.equal(INTRO_TOTAL_MS, INTRO_PHASES.reduce((s, p) => s + p.durMs, 0));
});

t('RESOLUTION_AT_MS : reveal + plasma, s\'accorde avec la durée d\'INTRO_SCORE', () => {
	assert.equal(RESOLUTION_AT_MS, INTRO_PHASES[0].durMs + INTRO_PHASES[1].durMs);
	// Les deux modèles (timeline visuelle, partition audio) restent indépendants
	// — pas d'import croisé — mais DOIVENT tomber d'accord : c'est ce qui fait
	// que la coupure vers BOOT_SIGNATURE tombe pile quand l'écran entre en
	// résolution, jamais avant ni après.
	assert.equal(RESOLUTION_AT_MS, INTRO_SCORE_MS,
		'la partition doit se résoudre exactement quand la phase plasma se termine');
});

// --- phaseAt -----------------------------------------------------------------

t('phaseAt : reveal, puis plasma, puis resolution, dans l\'ordre', () => {
	const revealMs = INTRO_PHASES[0].durMs;
	assert.equal(phaseAt(0), 'reveal');
	assert.equal(phaseAt(revealMs - 1), 'reveal');
	assert.equal(phaseAt(revealMs), 'plasma');
	assert.equal(phaseAt(RESOLUTION_AT_MS - 1), 'plasma');
	assert.equal(phaseAt(RESOLUTION_AT_MS), 'resolution');
	assert.equal(phaseAt(INTRO_TOTAL_MS - 1), 'resolution');
});

t('phaseAt : clampé aux bords plutôt que de rendre undefined', () => {
	assert.equal(phaseAt(-500), 'reveal');
	assert.equal(phaseAt(INTRO_TOTAL_MS), 'resolution');
	assert.equal(phaseAt(INTRO_TOTAL_MS + 10000), 'resolution');
});

t('phaseAt : couvre chaque milliseconde de la timeline sans trou', () => {
	// Balayage grossier (pas de 50 ms) : chaque échantillon doit rendre un nom
	// de phase connu, jamais undefined ni une chaîne vide.
	const names = new Set(INTRO_PHASES.map((p) => p.name));
	for (let tMs = 0; tMs < INTRO_TOTAL_MS; tMs += 50) {
		assert.ok(names.has(phaseAt(tMs)), `phase inconnue à ${tMs}ms`);
	}
});

// --- skip ---------------------------------------------------------------------

t('skipPhase : atterrit toujours sur resolution, la même destination qu\'un déroulement complet', () => {
	assert.equal(skipPhase(), 'resolution');
	assert.equal(skipPhase(), phaseAt(INTRO_TOTAL_MS - 1));
});

t('SKIP_WRAP_MS : plus court que la résolution jouée en entier — un skip coupe, il ne rejoue pas la coda', () => {
	const resolution = INTRO_PHASES.find((p) => p.name === 'resolution');
	assert.ok(SKIP_WRAP_MS > 0);
	assert.ok(SKIP_WRAP_MS < resolution.durMs);
});

console.log(`\n${n} tests OK`);
