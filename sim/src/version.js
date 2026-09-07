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
