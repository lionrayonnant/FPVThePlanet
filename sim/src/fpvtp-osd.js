// PHASE 12 — the FPVTP! OSD, the local layer. Injected by our station on top
// of the received image: it does not cross the link, so nothing degrades it.
// This is the stable half of the double HUD.
//
// Always metric, even when the target displays feet: this is OUR station. The
// disagreement between the two systems is part of the point.

import { PORTRAIT_LINE, RANDOMART_LINE } from './flight-end.js';
import { randomart } from '../tools/randomart.mjs';
// The portrait of the lost machine (#264). Inline SVG: the local layer is DOM,
// it opens no rendering context.
import { dronePortrait } from './drone-portrait.js';
import { droneViewer } from './drone-viewer.js';
import { storedKeyLabel } from './key-map.js';
import { versionLine, SOURCE_URL } from './version.js';
import { iconSVG } from './pixel-icons.js';

// The repository without its scheme: the OSD is dense and 'https://' earns
// nothing there. It is not a link — the flight holds pointer lock, so a
// clickable target in the video frame would be a trap rather than a bridge.
// The terminal's footer carries the real link; this is the reminder that the
// thing you are flying has source, visible on the surface a stream or a
// screenshot actually shows. The mark is the same one the terminal footer now
// carries — one destination, one logo, or the two surfaces start disagreeing
// about what they point at.
const SOURCE_HOST = SOURCE_URL.replace(/^https?:\/\//, '');

// Where the wind pushes from, in the drone's frame: index 0 is straight ahead.
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

const clock = (s) => {
	const t = Math.max(0, Math.floor(s));
	return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// What the HUD's flight line announces. Pulled out as a PURE function because
// it is an invariant of the fiction, not of the formatting: a flight that opens
// no session must not write SESSION — the HUD would be lying about what the flight
// is doing.
//
//   BENCH   — the bench: no session, and no time to count either.
//   LIVE    — streamed terrain (#218). The flight is a session like any other —
//             target, machine, hack, ritual, entry in the log — but the
//             terrain is NOT on disk: no fence, and the relief arrives while
//             you fly. That is what the line signals.
//   SESSION — a terrain flight over an acquired area.
export function flightLabel({ bench = false, live = false, sessionSeconds = 0 } = {}) {
	if (bench) return 'BENCH';
	return `${live ? 'LIVE' : 'SESSION'} ${clock(sessionSeconds ?? 0)}`;
}

export class FpvtpOsd {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
			<div id="fpvtp-osd" hidden>
				<div class="corner tl">
					<div id="fo-ident">${versionLine()}</div>
					<div id="fo-source">${iconSVG('github', { size: 9 })} ${SOURCE_HOST}</div>
					<div id="fo-operator">OPERATOR // —</div>
					<div id="fo-session">SESSION 00:00</div>
				</div>
				<div class="corner tr">
					<div id="fo-mode">ACRO</div>
					<div id="fo-rates">—</div>
					<div id="fo-input">KEYBOARD</div>
					<button type="button" id="fo-view"></button>
					<div id="fo-fps">—</div>
				</div>
				<div class="corner bl">
					<div id="fo-env">WIND — · VIS — · LINK —</div>
					<div id="fo-photo"></div>
				</div>
				<div class="corner br">
					<div id="fo-credit"></div>
				</div>
				<div id="fo-pause" hidden>PAUSED<small></small></div>
				<div id="fo-status" hidden></div>
				<div id="fo-turtle" hidden></div>
				<div id="fo-cut" hidden><span id="fo-cut-text"></span><i id="fo-cut-bar"></i></div>
				<div id="fo-hint" hidden></div>
				<div id="flight-end" hidden></div>
			</div>`);

		const q = (s) => root.querySelector(s);
		this.el = {
			root: q('#fpvtp-osd'),
			operator: q('#fo-operator'),
			session: q('#fo-session'),
			mode: q('#fo-mode'),
			rates: q('#fo-rates'),
			input: q('#fo-input'),
			view: q('#fo-view'),
			fps: q('#fo-fps'),
			env: q('#fo-env'),
			photo: q('#fo-photo'),
			credit: q('#fo-credit'),
			pause: q('#fo-pause'),
			status: q('#fo-status'),
			cut: q('#fo-cut'),
			turtle: q('#fo-turtle'),
			hint: q('#fo-hint'),
			cutText: q('#fo-cut-text'),
			cutBar: q('#fo-cut-bar'),
			flightEnd: q('#flight-end'),
		};
		this._frames = 0;
		this._fpsAt = performance.now();
		this._fps = 0;
		this._endLines = '';
		// The two central states occupy the same place. They do not exclude each
		// other in the world — you can be paused on a destroyed drone — so both
		// are held here, and only one is painted.
		this._paused = false;
		this._status = null;
		// PHASE 16: capture availability, counter, and a brief flash on click.
		this._photoReady = false;
		this._photoCount = 0;
		this._flashUntil = 0;
		// #216: the last painted label, so the DOM is not rewritten at 60 Hz.
		this._cutText = '';
		// #105: same rule for the turtle line.
		this._turtleText = '';
		// D16: the first-flight line, same rule — what it says is decided
		// elsewhere (tools/briefing-model.mjs); this layer only paints it.
		this._hintText = '';
		// #264: the machine in flight, and its drawing once the link is lost. The
		// drawing is only built at the moment the line appears — a flight that
		// ends well never builds one.
		this._target = null;
		this._portrait = null;
		this._randomart = null;
		// D11: the current view, and the only clickable element of the layer —
		// the OSD is pointer-events: none, this one takes them back.
		this._view = 'fpv';
		this._viewToggle = null;
		this._endUp = false;
		this.el.view.addEventListener('click', () => this._viewToggle?.());
		this._paintView();
		this._paintPause();
	}

	// The FPV / CHASE toggle (D11). The label names the key: without it the
	// view exists and nobody finds it — the same rule as [HOLD K] below.
	// `onToggle` is re-registered on every call: main.js is its source.
	//
	// The key is READ, never written here (#105's rule, applied to the two
	// hints that had escaped it): `view` and `pause` are remappable in
	// SETTINGS, and `[V]` / `PRESS SPACE` were hardcoded, so a player who had
	// rebound them was told to press a key that does nothing.
	setView(mode, onToggle) {
		this._view = mode === 'chase' ? 'chase' : 'fpv';
		if (onToggle !== undefined) this._viewToggle = onToggle;
		this._paintView();
	}

	_paintView() {
		const key = storedKeyLabel('view');
		const text = `[${key}] ${this._view === 'chase' ? 'CHASE' : 'FPV'}`;
		if (this.el.view.textContent !== text) this.el.view.textContent = text;
		// The flight is over: there is no view left to choose, and the end
		// screen holds the screen on its own.
		this.el.view.hidden = this._endUp;
	}

	// The machine the station follows (#264): `family` and `buildSeed`, the two
	// fields the portrait is derived from. Without them — dev paths, NOMINAL
	// override — the portrait line stays blank, never its token.
	//
	// `cameraSeed` (D12) is the SESSION seed, the one main.js draws the
	// target's camera from — and therefore the pod the machine wears in
	// flight. The wireframe portrait ignores it; the 3D view, which shows the
	// real mesh, would otherwise fit a different pod than the one that flew.
	setTarget(target) {
		const family = target?.family ?? null;
		const buildSeed = target?.buildSeed ?? null;
		const cameraSeed = target?.cameraSeed ?? null;
		if (this._target?.family === family && this._target?.buildSeed === buildSeed
			&& this._target?.cameraSeed === cameraSeed) return;
		this._dropPortrait();
		this._randomart = null;
		this._target = (family && buildSeed) ? { family, buildSeed, cameraSeed } : null;
	}

	// The portrait node, built once only: the end sequence rebuilds its lines
	// every time a line appears, and a portrait rebuilt each time would restart
	// from its first angle.
	//
	// D12: the REAL machine first, in 3D and turnable — we are inside the sim,
	// the mesh and its shaders are already loaded. The SVG wireframe stays the
	// fallback, for a WebGL context that is missing or has been lost; it also
	// stays what the archive shows, which does not have Three.
	_portraitNode() {
		if (!this._portrait && this._target) {
			this._portrait = droneViewer(this._target) ?? dronePortrait(this._target);
		}
		return this._portrait?.el ?? null;
	}

	_dropPortrait() {
		this._portrait?.stop();
		this._portrait = null;
		this._randomart = null;
	}

	// The fingerprint of the lost machine (#57). Built once only, like the
	// portrait: the end sequence rebuilds its lines every time a line appears.
	// With no known machine the line falls back to a blank — never to its
	// token, which is not made to be read.
	//
	// The frame's title is `TGT ??` and not a number: `targetSeq` is assigned by
	// the server and the client does not know it here. The number is what the
	// archive knows, not what the operator knows in flight.
	_randomartNode() {
		if (!this._randomart && this._target?.buildSeed) {
			const pre = document.createElement('pre');
			pre.className = 'flight-end-art';
			pre.setAttribute('aria-hidden', 'true');
			pre.textContent = randomart(this._target.buildSeed, {
				title: 'TGT ??', tag: this._target.buildSeed,
			});
			this._randomart = pre;
		}
		return this._randomart ?? null;
	}

	show() { this.el.root.hidden = false; }
	setPaused(paused) { this._paused = !!paused; this._refreshCentre(); }

	// Provider credit. Discreet and permanent: Google requires the copyrights of
	// rendered tiles to be displayed, and the same rule is applied to every
	// provider. On the FPVTP! layer, never on the drone OSD — it is the station
	// that credits, not the aircraft (issue #18).
	setCredit(text) {
		this.el.credit.textContent = text ?? '';
	}

	// Capture availability (PHASE 16): true only when what is on screen really
	// is the target's feed (in flight, armed, not in CHASE view, not during the
	// link's death throes).
	setPhotoReady(ready) { this._photoReady = !!ready; this._renderPhoto(); }

	// `count` is the one the server returned — it is authoritative, not an
	// optimistic client counter that could drift on a silent network failure.
	//
	// `null` means "nothing was counted": that is the bench (PHASE 26), where
	// the image goes to the operator's disk without anything recording it. So
	// there is no total to show, and inventing one would lie about what the
	// mode promises.
	flashCaptured(count) {
		this._photoCount = count;
		this._flashUntil = performance.now() + 900;
		this._renderPhoto();
	}

	_renderPhoto() {
		const e = this.el.photo;
		if (performance.now() < this._flashUntil) {
			e.textContent = this._photoCount === null
				? 'FRAME DUMPED'
				: `CAPTURED · CAPTURES ${this._photoCount}`;
			e.dataset.flash = '1';
			return;
		}
		delete e.dataset.flash;
		e.textContent = this._photoReady
			? `PHOTO READY${this._photoCount ? ` · CAPTURES ${this._photoCount}` : ''}`
			: '';
	}

	// End-of-session verdict (PHASE 06). kind: 'lost' | null.
	setSessionStatus(text, kind = null) {
		this._status = text ? { text, kind } : null;
		this._refreshCentre();
	}

	// Explicit priority: session verdict > pause. Only one is visible, otherwise
	// the two overlap letter on letter in the same place.
	_refreshCentre() {
		const e = this.el.status;
		if (this._status) {
			e.innerHTML = this._status.text;
			if (this._status.kind) e.dataset.kind = this._status.kind;
			else delete e.dataset.kind;
		}
		e.hidden = !this._status;
		this._paintPause();
		this.el.pause.hidden = !!this._status || !this._paused;
	}

	// `[SPACE] RESUME`, in the same `[KEY] VERB` form as every other key hint in
	// the game (terminal.js keyHints, `[HOLD K] CUT LINK` below) — it used to be
	// the prose `PRESS SPACE`, with the key written in. Repainted here rather
	// than once at construction, so a rebind made mid-session is reflected the
	// next time the pause comes up.
	_paintPause() {
		const small = this.el.pause.querySelector('small');
		if (!small) return;
		const text = `[${storedKeyLabel('pause')}] RESUME`;
		if (small.textContent !== text) small.textContent = text;
	}

	// Cutting the link (#216). Two things in the same place, and never at the
	// same time: the REMINDER that it exists, when the machine looks stuck, and
	// the GAUGE of the hold in progress. The reminder is conditional; the
	// gesture is always available — which is what makes a missed reminder harmless, and
	// why nothing here decides anything: flight-end.js has already ruled, we
	// paint.
	//
	// Naming the key on screen is the very subject of the issue: without it the
	// gesture exists and nobody finds it.
	// `key` is the key ACTUALLY bound to the cut (#105): it used to be hardcoded
	// here, which lied to anyone who had remapped it — naming the key on screen
	// is only worth anything if it is the right one.
	setCut({ stuck = false, cutProgress = 0 } = {}, key = 'K') {
		const e = this.el.cut;
		const cutting = cutProgress > 0;
		if (!cutting && !stuck) {
			if (!e.hidden) { e.hidden = true; this._cutText = ''; }
			return;
		}
		e.hidden = false;
		const text = cutting ? 'CUTTING LINK' : `[HOLD ${String(key).toUpperCase()}] CUT LINK`;
		if (text !== this._cutText) {
			this._cutText = text;
			this.el.cutText.textContent = text;
		}
		// The bar only lives during the hold: outside it, the reminder is a
		// sentence, not a gauge at zero that would suggest something is already
		// happening.
		this.el.cutBar.hidden = !cutting;
		this.el.cutBar.style.width = `${Math.round(cutProgress * 100)}%`;
	}

	// The turtle (#105). Just above the cut reminder, and for the same reason: a machine on its back has two ways out, and the one that gives
	// the machine back reads before the one that loses it. Like #fo-cut, nothing
	// is decided here — turtle.js has already ruled, we paint.
	setTurtle({ eligible = false } = {}, key = 'T') {
		const text = eligible ? `[${String(key).toUpperCase()}] TURTLE` : '';
		if (text === this._turtleText) return;
		this._turtleText = text;
		this.el.turtle.textContent = text;
		this.el.turtle.hidden = !text;
	}

	// The first-flight line (D16). Like #fo-cut: what it says is decided
	// elsewhere — main.js calls flightHint() every frame — and this layer only
	// paints it. `null` turns it off. The DOM is touched only when the text
	// changes: this is called sixty times a second.
	//
	// Three lines, once in an operator's life: this is not permanent help, it
	// is a briefing that ends.
	setHint(text) {
		const next = text || '';
		if (next === this._hintText) return;
		this._hintText = next;
		this.el.hint.textContent = next;
		this.el.hint.hidden = !next;
	}

	// The end-of-flight screen (PHASE 14). It does not announce a defeat: it
	// shows a link going out. `blackout` is the opacity of the black covering the
	// last image, `lines` what is written on it, one line at a time.
	// Carried over as-is from the old hud.js — it is the local layer that holds
	// this staging, it does not cross the link.
	setFlightEnd({ lines, blackout }) {
		const e = this.el.flightEnd;
		if (this._endUp !== (lines.length > 0 || blackout > 0)) {
			this._endUp = lines.length > 0 || blackout > 0;
			this._paintView();
		}
		if (!lines.length && blackout <= 0) {
			if (!e.hidden) {
				e.hidden = true; e.textContent = ''; this._endLines = '';
				// The screen is cleared: the portrait has no reason to keep spinning.
				this._dropPortrait();
			}
			return;
		}
		e.hidden = false;
		e.style.background = `rgba(10, 9, 8, ${blackout})`; // --black (issue #224)
		// The DOM is rebuilt only when the text changes: this runs at display
		// frequency for the whole sequence.
		const key = lines.join('\n');
		if (key !== this._endLines) {
			this._endLines = key;
			e.replaceChildren(...lines.map((text) => {
				// Neither the portrait nor the fingerprint is text: they are two
				// drawings of the machine. With no known machine, the line falls
				// back to a blank — never to its token, which is not made to be
				// read.
				if (text === PORTRAIT_LINE) {
					const node = this._portraitNode();
					if (node) return node;
				}
				if (text === RANDOMART_LINE) {
					const node = this._randomartNode();
					if (node) return node;
				}
				const d = document.createElement('div');
				d.textContent = (text === PORTRAIT_LINE || text === RANDOMART_LINE) ? '' : text;
				return d;
			}));
		}
	}

	get fps() { return this._fps; }

	update({ mode, rates, usingGamepad, windMs, windRelRad, visibilityM,
	         rssiDbm, operator, sessionSeconds, propwash, bench = false, live = false }) {
		this.el.mode.textContent = String(mode).toUpperCase();
		if (rates) this.el.rates.textContent = rates;
		this.el.input.textContent = usingGamepad ? 'GAMEPAD' : 'KEYBOARD';
		this.el.operator.textContent = `OPERATOR // ${operator ?? '—'}`;
		// At the bench there is no session: the line says what it is rather than
		// counting the time of something that does not exist. It is the only
		// place in the HUD where the bench announces itself, and it is enough.
		//
		// A recon flight (#206) does not open one either — nothing is written, so
		// writing SESSION would be the HUD lying about what the flight is doing.
		// It keeps its clock: flight time is read even when it is recorded
		// nowhere.
		this.el.session.textContent = flightLabel({ bench, live, sessionSeconds });

		// A single environment line: three numbers the operator reads at a
		// glance, not three blocks fighting over one corner.
		const parts = [];
		if (Number.isFinite(windMs) && windMs >= 0.5) {
			const i = ((Math.round(((windRelRad ?? 0) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
			parts.push(`WIND ${windMs.toFixed(1)} m/s ${ARROWS[i]}`);
		} else {
			parts.push('WIND CALM');
		}
		if (Number.isFinite(visibilityM)) parts.push(`VIS ${(visibilityM / 1000).toFixed(1)} km`);
		// LOOPBACK rather than an RSSI: showing −41 dBm where the feed crosses
		// nothing would be an invented figure, and this HUD only shows what it
		// knows (Bible §2, "Information, not assistance").
		if (bench) parts.push('LINK LOOPBACK');
		else if (Number.isFinite(rssiDbm)) parts.push(`LINK ${Math.round(rssiDbm)} dBm`);
		this.el.env.textContent = parts.join(' · ');
		// Refreshed here too so that the capture flash (PHASE 16) goes out by
		// itself, without a separate timer: this function already runs at 60 Hz.
		this._renderPhoto();

		this._frames++;
		const now = performance.now();
		if (now - this._fpsAt > 500) {
			this._fps = Math.round(this._frames * 1000 / (now - this._fpsAt));
			this.el.fps.textContent = `${this._fps} fps`;
			this._frames = 0;
			this._fpsAt = now;
		}
	}
}
