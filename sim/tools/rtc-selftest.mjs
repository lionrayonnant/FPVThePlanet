// Selftest des logs RTC décoratifs (PHASE 05). Aucune E/S, aucun DOM.
// Lancer : node tools/rtc-selftest.mjs
import assert from 'node:assert/strict';
import { rtcScript, CREW } from './rtc-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('rtcScript : déterministe', () => {
	const a = rtcScript({ name: 'Tokyo', tiles: 6512 });
	const b = rtcScript({ name: 'Tokyo', tiles: 6512 });
	assert.deepEqual(a, b);
	assert.ok(a.length > 5, 'un vrai script, pas une ligne');
});

t('rtcScript : chaque locuteur fait partie du crew', () => {
	const lines = rtcScript({ name: 'Reims', tiles: 40 });
	for (const { speaker } of lines) assert.ok(CREW.includes(speaker), `locuteur inconnu : ${speaker}`);
});

t('rtcScript : les emplacements sont bien remplis', () => {
	const lines = rtcScript({ name: 'Tokyo', tiles: 6512 });
	const joined = lines.map((l) => l.line).join(' ');
	assert.match(joined, /TOKYO/);
	assert.match(joined, /~6512/);
	assert.doesNotMatch(joined, /\{name\}|\{tiles\}/);
});

t('rtcScript : jamais planté sans nom / sans compte de tuiles', () => {
	const lines = rtcScript({});
	assert.doesNotMatch(lines.map((l) => l.line).join(' '), /\{name\}|\{tiles\}/);
});

console.log(`\n${n} vérifications, tout passe.`);
