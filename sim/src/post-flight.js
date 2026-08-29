// POST-FLIGHT ANALYSIS (PHASE 15, Bible §25/§26/§29). Rapport de fin de vol :
// déduction (tools/post-flight-model.mjs), Randomart, OPERATOR NOTE, puis
// KEEP TERRAIN / REMOVE TERRAIN. Écran client pur, gabarit calqué sur
// target-scan.js (screen/button de terminal.js, promesse par étape).
//
// Uniquement pour une session LANDED : une session CRASHED n'a pas de grand
// écran (Bible §24, « pas de récompense, pas de grand écran de mort »).
import { screen, button, fetchScenes } from './terminal.js';
import { formatBytes } from '../tools/terminal-model.mjs';
import { analyzeFlight } from '../tools/post-flight-model.mjs';
import * as operatorApi from './operator.js';

function mmss(durationS) {
	const s = Math.max(0, Math.round(durationS));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function reportText(session) {
	const tel = session.flightTelemetry ?? {};
	const { profile, estimated } = analyzeFlight(tel);

	const profileLine = profile
		? `PROFILE      ${profile.label}      CONFIDENCE ${profile.confidencePct}%`
		: 'PROFILE      UNKNOWN';

	const observedLine = `OBSERVED     MAX SPEED ${(tel.maxSpeedMs ?? 0).toFixed(1)} m/s · ` +
		`MAX RATE ~${Math.round(tel.maxRateDps ?? 0)}°/s · FLIGHT TIME ${mmss(tel.durationS ?? 0)}`;

	const estimatedLine = estimated
		? `ESTIMATED    MASS ~${estimated.massG} g · FOV ~${estimated.fovDeg}° · RESPONSE ~${estimated.responseMs} ms`
		: 'ESTIMATED    UNKNOWN';

	return `POST-FLIGHT ANALYSIS

${profileLine}

${observedLine}
${estimatedLine}

UNKNOWN      CAMERA MODEL · FLIGHT CONTROLLER · MOTOR SETUP

RANDOMART
${session.randomart ?? ''}`;
}

// Rapport + OPERATOR NOTE. La note est sauvegardée seulement si elle a changé
// (jamais si le joueur n'a rien touché) — annotateSession accepte une session
// déjà LANDED, contrairement à la clôture qui exige PENDING.
function noteScreen(root, session) {
	const s = screen(root);
	s.box.innerHTML = `<pre>${reportText(session)}

OPERATOR NOTE</pre>
		<textarea id="pf-note" maxlength="400" placeholder="free text" rows="3"></textarea>`;
	const note = s.box.querySelector('#pf-note');
	note.value = session.comment ?? '';
	return new Promise((resolve) => {
		s.box.appendChild(button('CONTINUE', async () => {
			const text = note.value.trim();
			if (text !== (session.comment ?? '')) {
				try { await operatorApi.patchSessionComment(session.id, text); }
				catch (e) { console.warn('[post-flight] note non sauvegardée', e); }
			}
			s.remove();
			resolve();
		}, 'terminal-cta'));
	});
}

// KEEP TERRAIN / REMOVE TERRAIN (Bible §29). Rien à proposer si la zone n'a
// pas (ou plus) de terrain préparé sur disque : chemin dev (?scene=) ou
// terrain déjà retiré entretemps.
async function terrainScreen(root, session) {
	const scenes = await fetchScenes().catch(() => null);
	const scene = scenes?.find((sc) => sc.slug === session.area);
	if (!scene) return;

	const s = screen(root);
	s.box.innerHTML = `<pre>LOCAL TERRAIN

${scene.name}
${formatBytes(scene.bytes)}

KEEP TERRAIN DATA?</pre>`;
	return new Promise((resolve) => {
		// KEEP : rien à faire, le terrain reste tel quel sur disque.
		s.box.appendChild(button('KEEP', () => { s.remove(); resolve(); }, 'terminal-cta'));
		// REMOVE : supprime les données préparées, pas la session — « supprimer le
		// terrain ne supprime pas le souvenir ».
		s.box.appendChild(button('REMOVE', async () => {
			try { await fetch(`/__map-api/scenes/${scene.slug}`, { method: 'DELETE' }); }
			catch (e) { console.warn('[post-flight] suppression du terrain échouée', e); }
			s.remove();
			resolve();
		}, 'terminal-cta'));
	});
}

// Résout une fois la note enregistrée et la décision de terrain prise.
export async function runPostFlightAnalysis(root, session) {
	await noteScreen(root, session);
	await terrainScreen(root, session);
}
