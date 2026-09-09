// The one place that knows where flight tracks come from (issue #24).
//
// #26 (the DATA tab) reads tracks and #25 (the enriched map) will too, but
// neither owns them: the recording, the encoding and the routes belong to #24.
// This accessor exists so that both consumers speak to ONE function each, and
// so that a build where the routes are not deployed yet degrades to `NO TRACK`
// instead of throwing.
//
// Both calls swallow their failure on purpose. A missing track is a section
// that says NO TRACK; it is never a reason for a screen not to open.

import { operatorBase } from './operator.js';

async function getJson(path) {
	try {
		// The Authorization header rides along: installAuthFetch() wraps every
		// request whose URL starts with the operator base (#60).
		const r = await fetch(operatorBase() + path);
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}

// The index the graphs need: per retained track, the start point, a decimated
// polyline, the `end` event and the photo points. Never the full samples.
export async function fetchTrackIndex(operatorId) {
	if (!operatorId) return [];
	const body = await getJson(`/${operatorId}/tracks`);
	const list = Array.isArray(body) ? body : body?.tracks;
	return Array.isArray(list) ? list : [];
}

// One decoded track, samples included. Only ever fetched for the flight the
// operator is actually looking at.
export async function fetchTrack(operatorId, sessionId) {
	if (!operatorId || !sessionId) return null;
	const body = await getJson(`/${operatorId}/sessions/${sessionId}/track`);
	return body?.track ?? body ?? null;
}
