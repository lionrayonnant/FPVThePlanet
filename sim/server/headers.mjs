// Security response headers, in one place (issue: pre-1.0.0 audit, M3).
//
// The server answered with no Content-Security-Policy, no nosniff, no
// frame-ancestors and no referrer policy. That matters more here than on a
// static site: the page keeps an operator bearer key in `localStorage`
// (src/operator.js), so anything that gets to run script in this origin gets
// the key, and with it the account on a `shared` instance.
//
// Applied centrally in server/index.mjs, before the API and the file server
// see the request, so no route can forget them. `res.setHeader()` survives the
// later `res.writeHead(code, {...})` both of them use: Node merges the two,
// with writeHead winning on a genuine conflict — and there is none here, since
// nothing else sets these names.
//
// NOT applied under `npm run dev`: Vite serves the files there, with its own
// inline bootstrap and its HMR websocket. Hardening the dev server would only
// teach us to work around the policy.

// --- what is enforced -------------------------------------------------------
//
// These four are safe to enforce outright: none of them can break a page that
// was not already doing something it should not.
//
//   nosniff          unknown extensions fall through to
//                    application/octet-stream (static.mjs), and a scene
//                    directory can hold an .html served as text/html. Without
//                    nosniff a browser may sniff either into script.
//   X-Frame-Options  the belt to frame-ancestors' braces, for the CSP-less
//                    case and for older browsers. The game is never framed.
//   Referrer-Policy  a scene URL carries ?scene=<slug> and sometimes a build
//                    seed; none of that needs to reach a tile CDN. But
//                    `no-referrer` was too blunt and broke the map: the
//                    OpenStreetMap tile policy requires a Referer or a
//                    User-Agent that identifies the application, and a browser
//                    sends a generic UA — so stripping the Referer made every
//                    tile request anonymous and their servers answered 403
//                    "Access blocked" (osm.wiki/Blocked). It did not show in
//                    dev, because Vite serves none of these headers.
//                    `strict-origin-when-cross-origin` keeps the intent: the
//                    full URL stays same-origin, a cross-origin request carries
//                    the bare origin, and a downgrade to HTTP carries nothing.
//                    The slug and the seed still never leave.
//   COOP             keeps a popup from reaching back into this origin.
export const BASELINE = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'cross-origin-opener-policy': 'same-origin',
};

// --- the content policy, and why it is Report-Only --------------------------
//
// Derived from what the app actually loads, not from a template:
//
//   script-src   'self', plus 'wasm-unsafe-eval' — Rapier is WASM
//                (src/physics.js imports @dimforge/rapier3d-compat) and
//                instantiating a module needs it. AND 'unsafe-inline',
//                because index.html carries one deliberate inline classic
//                script: the WebGL2 probe, which exists precisely to put words
//                on screen when the bundle cannot load. A hash would be the
//                right answer, but Vite rewrites index.html at build time, so
//                a hash pinned here would be wrong the first time the build
//                changed and would break the page rather than a rule.
//   style-src    'unsafe-inline' for the same probe (its styles are inline for
//                the same reason) and for the inline styles the UI sets.
//   img-src      the three basemaps of src/map-layers.js, plus data: and blob:
//                (canvas captures, src/main.js createObjectURL).
//   connect-src  kh.google.com (the terrain, tools/lib/rocktree/url.mjs) and
//                Nominatim (search, src/scanner.js). Open-Meteo is NOT here:
//                the client asks /__operator/:id/weather and the server does
//                that call. VITE_ROCKTREE_BASE can point the terrain at a
//                local relay, which is dev-only and not served by this server.
//   worker-src   the three module workers (loader.js, rocktree-*.js).
//
// SHIPPED AS Content-Security-Policy-Report-Only, deliberately. A CSP can only
// be validated in a browser, driving the real game — loading a scene, opening
// the scanner, flying — and this change was made without one. Enforcing a
// policy that has never been exercised risks a black screen on launch day,
// which is a worse outcome than the attack it prevents. Report-Only gives the
// violation reports that turn this into an enforced policy, at no risk.
//
// TO ENFORCE IT: run the game in a browser, open the console, and exercise
// terminal → scanner (all three basemaps, a search, a probe) → a flight →
// a capture. If nothing is reported, rename the header to
// `content-security-policy`. Tighten script-src to a hash or a nonce at the
// same time, which is the directive actually worth having.
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.opentopomap.org https://server.arcgisonline.com",
	"font-src 'self'",
	"connect-src 'self' https://kh.google.com https://nominatim.openstreetmap.org",
	"worker-src 'self' blob:",
	"media-src 'self' blob:",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"object-src 'none'",
	"form-action 'none'",
].join('; ');

// The document policy belongs on documents. Sending it with every tile and
// chunk would add ~400 bytes to responses a scene fetches by the thousand, and
// buy nothing: a .bin is not a browsing context.
export function securityHeaders(contentType = '') {
	if (!/^text\/html/.test(contentType)) return BASELINE;
	return { ...BASELINE, 'content-security-policy-report-only': CSP };
}

// Sets the always-on headers on a response, before anything writes to it.
export function applyBaseline(res) {
	for (const [k, v] of Object.entries(BASELINE)) res.setHeader(k, v);
}

export { CSP as _CSP };
