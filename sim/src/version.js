// The real package version, injected at build time by vite.config.js from
// package.json (see CHANGELOG.md and tools/release.mjs) — replaces the
// lore string that used to sit on screen (#9).
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

// Pure formatting, so it can be unit-tested without Vite's define: a numeric
// version gets the customary 'v' prefix, 'dev' (built outside Vite) does not.
export function versionLineFor(v) {
	return v === 'dev' ? `FPVTP! // dev` : `FPVTP! // v${v}`;
}

export function versionLine() {
	return versionLineFor(APP_VERSION);
}

// Where the source lives, and under what terms.
//
// This is not decoration and not marketing. The AGPL's section 13 requires that
// anyone interacting with the program THROUGH A NETWORK be offered the
// corresponding source, and a hosted instance is exactly that case: a player on
// someone else's server never touches the repository, the licence file or the
// README. The offer has to be in the program.
//
// It lives here rather than in a screen because two surfaces show it (the FIELD
// footer, the settings panel) and a second copy is how they come to disagree.
export const SOURCE_URL = 'https://github.com/lionrayonnant/FPVThePlanet';
export const LICENCE = 'AGPL-3.0';

// What the footer asks for above the mark. The licence obligation is to OFFER
// the source; asking for a star is a different sentence and is allowed to sound
// like one — it is the cheapest thing a player can give back, and the tip row
// underneath says what the expensive one would be.
export const SOURCE_CALL = 'SOURCE · LEAVE A STAR ON GITHUB';
