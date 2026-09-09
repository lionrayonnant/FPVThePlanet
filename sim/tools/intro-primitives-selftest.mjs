// Selftest des primitives demo scene (PHASE 20). Elles ont été écrites pour le
// rituel CONTROL VECTOR, retiré du jeu (#33) ; src/intro.js les exécute encore
// à CHAQUE lancement, et ce fichier est le seul endroit où leur contrat et leur
// budget sont vérifiés. C'est la raison pour laquelle il a été renommé plutôt
// que supprimé avec le rituel.
// Lancer : node tools/intro-primitives-selftest.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { RITUAL_PRIMITIVES } from '../src/hack-grammars.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('RITUAL_PRIMITIVES : les 11 primitives documentées', () => {
	for (const name of [
		'scanBurst', 'glitchShift', 'pulseRing', 'gridSwarm',
		'waveformSpike', 'vectorSweep', 'memoryScroll', 'chromaSplit',
		'colorFlash', 'textWarp', 'bannerBurst',
	]) {
		assert.equal(typeof RITUAL_PRIMITIVES[name], 'function', `manque ${name}`);
	}
});

t('primitives : contrat (t, seed, dur) tenu de V1 à V4, sortie bornée 44×12', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		for (const dur of [1, 2, 3, 4]) {
			for (const tt of [0, dur * 0.5, dur - 0.016]) {
				const el = { textContent: '' };
				fn(el, { t: tt, seed: 0.37, dur });
				const rows = el.textContent.split('\n');
				assert.equal(rows.length, 12, `${name} dur=${dur} : 12 lignes`);
				for (const r of rows) assert.equal(r.length, 44, `${name} dur=${dur} : 44 colonnes`);
			}
		}
	}
});

t('primitives : dur absent → comportement par défaut (compat PHASE 10)', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		const el = { textContent: '' };
		fn(el, { t: 0.5, seed: 0.37 });
		assert.ok(el.textContent.length > 0, name);
	}
});

// Le cracktro de lancement (issue #106) rejoue les mêmes primitives que le
// rituel : c'est un événement au sens de la Bible §19, pas un écran quotidien.
// Le garde-fou n'avait pas été élargi quand la PR #118 a été mergée, et il
// échouait donc sur `main` avant la PHASE 19.
const EVENT_MODULES = new Set(['hack-grammars.js', 'intro.js']);

t('acceptation #57 : aucune primitive demo scene hors événement (grammars et intro seuls)', () => {
	const dir = new URL('../src/', import.meta.url);
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
		if (EVENT_MODULES.has(f)) continue;
		const src = fs.readFileSync(new URL(f, dir), 'utf8');
		assert.doesNotMatch(src, /RITUAL_PRIMITIVES|FAMILY_PRIMITIVES/,
			`${f} référence les primitives demo scene hors rituel`);
	}
});

console.log(`\n${n} tests intro-primitives OK`);
