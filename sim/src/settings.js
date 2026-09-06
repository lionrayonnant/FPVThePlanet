import { CHANNELS, padKind, padListEntries, PAD_LIST_EMPTY } from './input.js';
import { beginCalibration, feedSample, calibrationResult, calProgress, calSummaryLines, padSignals, signalLabel } from './calibration.js';
import { calibrationDrone } from './calibration-drone.js';
import { armConfirm } from './confirm-button.js';
import { menuNav } from './menu-nav.js';

const VOLUME_KEY = 'fpvmaps.audioVolume';
const BRIGHTNESS_KEY = 'fpvmaps.audioBrightness';
const MUSIC_KEY = 'fpvmaps.musicVolume';
const LENS_KEY = 'fpvmaps.lens';
const VIGNETTE_KEY = 'fpvmaps.lensVignette';
const SHUTTER_KEY = 'fpvmaps.lensShutter';
const LENS_ON_KEY = 'fpvmaps.lensOn';
const LINK_KEY = 'fpvmaps.link';
const LINK_MODE_KEY = 'fpvmaps.linkMode';
const VIEW_RANGE_KEY = 'fpvmaps.viewRange';

// Audio settings survive reloads. Anything unparseable falls back to the
// default rather than throwing: a corrupt key must not stop the sim booting.
// Note the null check — Number(null) is 0, which would silently turn a first
// run into a muted one.
function loadPercent(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved / 100;
	} catch { }
	return fallback;
}

export const loadVolume = () => loadPercent(VOLUME_KEY, 0.6);
export const loadBrightness = () => loadPercent(BRIGHTNESS_KEY, 0.5);
// Ce défaut EST la balance musique/moteur, et c'est le seul endroit où elle
// vit : audio-bus.js n'applique plus de trim par-dessus (il en avait un, à 0.7
// lui aussi, ce qui atténuait deux fois — corrigé). 0.7 est la valeur mesurée à
// la première écoute en vol.
//
// Réglage SÉPARÉ du volume global, pour qu'on puisse baisser la musique sans
// baisser le moteur : le vol reste un exercice d'écoute de la machine.
export const loadMusicVolume = () => loadPercent(MUSIC_KEY, 0.7);

// Distance d'affichage du mode ?live= (#182), en MÈTRES — pas un pourcentage,
// donc pas loadPercent(). Bornes du curseur : 100-600 m. Le coût est
// QUADRATIQUE en rayon (nœuds ∝ r², mesuré : 200 m ≈ 1032 meshes) — 600 m
// ≈ ×9, c'est le GPU et kh.google.com de l'utilisateur, son choix. Défaut
// 300 m : choisi par l'utilisateur à la première écoute du curseur.
export const VIEW_RANGE_MIN_M = 100;
export const VIEW_RANGE_MAX_M = 600;
export function loadViewRange() {
	try {
		const raw = localStorage.getItem(VIEW_RANGE_KEY);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= VIEW_RANGE_MIN_M && saved <= VIEW_RANGE_MAX_M) return saved;
	} catch { }
	return 300;
}

// The FPV look is on by default — a clean rectilinear camera is the thing this
// is here to stop looking like. Every part of it is a slider away from off, and
// the master checkbox is one click away, which is what makes A/B comparison
// possible at all.
export function loadLens() {
	let on = true;
	try { on = localStorage.getItem(LENS_ON_KEY) !== '0'; } catch { }
	return {
		on,
		lens: loadPercent(LENS_KEY, 0.6),
		vignette: loadPercent(VIGNETTE_KEY, 0.5),
		// 8 ms is 1/125 s: a plausible daylight shutter on an FPV camera, and long
		// enough that a fast roll visibly smears.
		shutter: loadPercent(SHUTTER_KEY, 0.4) * 20,
	};
}

// La météo n'est plus ici (PHASE 04, Bible §31). Le vent, la pluie et le
// brouillard appartiennent au monde et à la session : ils viennent du world
// state de l'opérateur via src/weather.js, et aucun réglage utilisateur ne
// permet plus de choisir le temps qu'il fait. Les modèles wind.js / rain.js /
// fog.js n'ont pas bougé — seule la main qui écrit leurs paramètres a changé.
// window.__sim.setWeather / setRain / setFog restent l'accès de debug.

// The link degradation is on at full strength by default: the point of the
// feature is that going behind a building costs you the picture, and a version
// that never quite breaks would not be that. The slider is what makes it an
// argument rather than a decree — 0 % turns the whole thing off.
export function loadLink() {
	let mode = 'analog';
	try {
		const saved = localStorage.getItem(LINK_MODE_KEY);
		if (saved === 'analog' || saved === 'digital') mode = saved;
	} catch { }
	return { mode, severity: loadPercent(LINK_KEY, 1) };
}

// The Tab panel: input detection/binding, controls reminder, audio. It owns
// #settings and nothing else — l'OSD de vol s'est scindé en deux couches
// (drone-osd.js et fpvtp-osd.js), le terminal opérateur est dans terminal.js.
// Issue #120 : caméra, objectif et lien vidéo n'étaient pas des réglages
// destinés au joueur — ils restent pilotés par leurs valeurs stockées
// (loadLens/loadLink, cf. main.js) mais ont quitté ce panneau.
export class Settings {
	constructor(root, input) {
		this.input = input;
		const el = document.createElement('div');
		el.id = 'settings';
		el.hidden = true;
		el.innerHTML = `
			<div class="panel">
				<h2>Controller</h2>
				<p id="pad-name">no controller detected</p>
				<!-- Ce que le NAVIGATEUR voit, et le choix quand il en voit
				     plusieurs (issue #162). Sans cette liste, une radio mal
				     classée — ou simplement absente de l'énumération — laissait
				     le pilote sans aucun recours : il ne pouvait ni constater ce
				     qui était détecté, ni désigner le bon périphérique. -->
				<div id="pad-list" class="spec"></div>
				<!-- Calibrage mesuré (issue #277). Le bouton est toujours là ;
				     la note à côté ne parle que d'un périphérique JAMAIS
				     calibré — proposer, pas imposer. -->
				<div id="cal-row">
					<button id="calibrate" type="button">Calibrate</button>
					<span id="cal-note" class="spec"></span>
				</div>
				<div id="cal-screen" hidden>
					<p id="cal-step" class="spec"></p>
					<p id="cal-prompt"></p>
					<p id="cal-hint" class="spec"></p>
					<p id="cal-message" class="spec"></p>
					<div class="axisbar"><i id="cal-bar"></i></div>
				</div>
				<!-- La machine qui réagit au manche (#281). Hors de #cal-screen
				     à dessein : une fois la mesure finie elle reste, et suit les
				     quatre manches calibrés — le banc d'essai vient gratuitement.
				     C'est aussi pourquoi CANCEL est descendu sous elle : sinon
				     la machine apparaît SOUS un bouton d'abandon, alors qu'elle
				     illustre la consigne écrite au-dessus. -->
				<div id="cal-drone" hidden></div>
				<div id="cal-cancel-row" hidden>
					<button id="cal-cancel" type="button">Cancel</button>
				</div>
				<div id="cal-summary" class="spec" hidden></div>
				<table id="pad-map"></table>
				<h2>Controls</h2>
				<div id="keymap" class="spec">
					<b>W/S</b> throttle · <b>A/D</b> yaw · <b>arrows</b>/mouse roll-pitch<br>
					<b>J</b> disarm · <b>K</b> (hold) cut link, field · <b>M</b> mode (acro/angle/altitude) · <b>P</b> rates (cinéma/freestyle/race/long range/micro)<br>
					<b>C</b> free camera · <b>F</b> capture · <b>Space</b> pause · <b>Tab</b> settings · <b>R</b> respawn, bench
				</div>
				<h2>Sound</h2>
				<label>Volume <input id="vol" type="range" min="0" max="100" step="1"> <span id="vol-val"></span> %</label>
				<label>Tone <input id="tone" type="range" min="0" max="100" step="1"> <span id="tone-val"></span></label>
				<label>Music <input id="music" type="range" min="0" max="100" step="1"> <span id="music-val"></span> %</label>
				<div id="viewrange-row" hidden>
					<h2>View</h2>
					<label>Range <input id="viewrange" type="range" min="${VIEW_RANGE_MIN_M}" max="${VIEW_RANGE_MAX_M}" step="50"> <span id="viewrange-val"></span> m</label>
				</div>
				<button id="reset-settings">Reset settings</button>
				<button id="close-settings">Close (Tab)</button>
			</div>`;
		root.appendChild(el);

		this.el = {
			settings: el,
			vol: el.querySelector('#vol'),
			volVal: el.querySelector('#vol-val'),
			tone: el.querySelector('#tone'),
			toneVal: el.querySelector('#tone-val'),
			music: el.querySelector('#music'),
			musicVal: el.querySelector('#music-val'),
			viewRangeRow: el.querySelector('#viewrange-row'),
			viewRange: el.querySelector('#viewrange'),
			viewRangeVal: el.querySelector('#viewrange-val'),
			padName: el.querySelector('#pad-name'),
			padList: el.querySelector('#pad-list'),
			padMap: el.querySelector('#pad-map'),
			calRow: el.querySelector('#cal-row'),
			calButton: el.querySelector('#calibrate'),
			calNote: el.querySelector('#cal-note'),
			calScreen: el.querySelector('#cal-screen'),
			calStep: el.querySelector('#cal-step'),
			calPrompt: el.querySelector('#cal-prompt'),
			calHint: el.querySelector('#cal-hint'),
			calMessage: el.querySelector('#cal-message'),
			calBar: el.querySelector('#cal-bar'),
			calDrone: el.querySelector('#cal-drone'),
			calCancelRow: el.querySelector('#cal-cancel-row'),
			calSummary: el.querySelector('#cal-summary'),
		};
		// État de l'assistant de calibrage, ou null. C'est la seule chose qui
		// distingue le panneau ouvert du panneau en train de mesurer.
		this._cal = null;
		this._calPadId = null;
		this._calLast = 0;
		this._calRaf = null;
		this.el.calButton.onclick = () => this.startCalibration();
		this.el.calScreen.querySelector('#cal-cancel').onclick = () => this.cancelCalibration();
		// Posé à vrai par main.js quand un vol démarre : le panneau ouvert en vol
		// n'écoute pas la manette (les sticks pilotent le drone — issue #123).
		this.flightActive = false;
		el.querySelector('#close-settings').onclick = () => this.toggleSettings(false);
		// Pas de confirm() de navigateur (§44, issue #213) : le bouton se
		// réétiquette et la DEUXIÈME pression est la confirmation.
		armConfirm(el.querySelector('#reset-settings'), () => {
			try {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('fpvmaps.')) localStorage.removeItem(key);
				}
			} catch { }
			location.reload();
		});
		this._axisRows = [];
		// Populate every control from storage now, with inert callbacks, so the
		// panel reads correctly when opened from the terminal before boot(). boot()
		// calls the same setters again with live callbacks — every setter re-reads
		// and re-emits, so the second pass is idempotent.
		this.hydrate();
	}

	hydrate() {
		const noop = () => { };
		this.setAudio(loadVolume(), loadBrightness(), loadMusicVolume(), noop);
	}

	// All three audio settings are worth remembering across reloads: nobody
	// wants the sim to come back at full blast every time, where "bright enough
	// but not tiring" sits depends on the headphones, and how much music you
	// want under the motors is a matter of taste. Same localStorage shape as
	// the gamepad map in input.js.
	setAudio(volume, brightness, musicVolume, onChange) {
		const emit = () => {
			const vol = Number(this.el.vol.value);
			const tone = Number(this.el.tone.value);
			const mus = Number(this.el.music.value);
			this.el.volVal.textContent = vol;
			// Signed, because what the slider does is move away from the tuning
			// the spectrum was measured at, in both directions.
			this.el.toneVal.textContent = tone === 50 ? 'neutre' : (tone > 50 ? '+' : '') + (tone - 50);
			this.el.musicVal.textContent = mus;
			try {
				localStorage.setItem(VOLUME_KEY, String(vol));
				localStorage.setItem(BRIGHTNESS_KEY, String(tone));
				localStorage.setItem(MUSIC_KEY, String(mus));
			} catch { }
			onChange(vol / 100, tone / 100, mus / 100);
		};
		this.el.vol.value = Math.round(volume * 100);
		this.el.tone.value = Math.round(brightness * 100);
		this.el.music.value = Math.round(musicVolume * 100);
		this.el.vol.oninput = emit;
		this.el.tone.oninput = emit;
		this.el.music.oninput = emit;
		emit();
	}

	// Curseur de distance d'affichage du mode ?live= (#182). La ligne reste
	// cachée hors mode live (le rayon de fenêtre n'existe pas pour une scène
	// pré-cuite) : c'est CET appel, fait par bootLive(), qui la révèle.
	// L'affichage suit le doigt (oninput) mais le callback ne part qu'au
	// relâchement (onchange) : chaque cran déclenche traverse() + une vague de
	// fetchs vers kh.google.com — pas pendant un glissement.
	setViewRange(meters, onChange) {
		this.el.viewRangeRow.hidden = false;
		const show = () => { this.el.viewRangeVal.textContent = this.el.viewRange.value; };
		const commit = () => {
			const m = Number(this.el.viewRange.value);
			show();
			try { localStorage.setItem(VIEW_RANGE_KEY, String(m)); } catch { }
			onChange(m);
		};
		this.el.viewRange.value = meters;
		this.el.viewRange.oninput = show;
		this.el.viewRange.onchange = commit;
		commit();
	}

	toggleSettings(force) {
		const show = force ?? this.el.settings.hidden;
		this.el.settings.hidden = !show;
		// Fermer le panneau abandonne une mesure en cours, et rien n'est écrit :
		// un calibrage à moitié fait ne doit pas survivre à un panneau fermé, et
		// sa boucle rAF ne doit pas continuer à tourner derrière.
		//
		// Échap ferme donc le panneau, comme partout ailleurs — il n'annule pas
		// « juste l'assistant ». C'est aussi ce qui arrivait de fait : Échap est
		// traité DEUX fois (main.js et le `back` de menu-nav), et une garde qui
		// annulait au premier passage laissait le second fermer quand même.
		if (!show && this._cal) this.cancelCalibration();
		if (show) {
			this.buildAxisRows();
			// Navigation clavier + manette (issue #123) : ↑/↓ circule entre les
			// lignes, ←/→ règle le contrôle focalisé (menu-nav.js sait lesquels
			// sont réglables), Échap / B referme. Attaché à l'ouverture seulement :
			// en vol, panneau fermé, les flèches restent des commandes.
			this._nav ??= menuNav(this.el.settings, {
				back: () => this.toggleSettings(false),
				gamepad: !this.flightActive,
			});
		} else {
			this._nav?.detach();
			this._nav = null;
			// Panneau fermé : la boucle de la machine s'arrête avec lui, comme
			// celle de l'assistant.
			this.unmountCalDrone();
		}
	}

	get settingsOpen() { return !this.el.settings.hidden; }

	// One row per channel: pick which axis drives it and whether to invert.
	// Live bars next to each let you see which physical stick is which.
	// Ce que le navigateur énumère, tel quel : identifiant, nombre d'axes,
	// nombre de boutons, et la classe que padKind() en déduit — c'est elle qui
	// décide du mappage par défaut, donc c'est elle qu'il faut pouvoir LIRE
	// quand « ça ne marche pas » (issue #162). Un clic désigne le périphérique
	// actif, ce qui compte dès qu'il y en a deux branchés.
	//
	// Rappel utile au diagnostic : l'API Gamepad n'expose un périphérique
	// qu'après une action de l'utilisateur DESSUS. Une liste vide ne veut donc
	// pas dire « non reconnu », elle peut vouloir dire « pas encore touché » —
	// et le texte le dit, plutôt que de laisser conclure.
	// ---------------------------------------------------------------------------
	// ASSISTANT DE CALIBRAGE (issue #277)
	//
	// Le panneau ne décide de rien : src/calibration.js tient la machine à états
	// et dit quelle consigne afficher. Ici on lui donne une trame et un dt, et on
	// peint ce qu'elle rend.
	// ---------------------------------------------------------------------------

	startCalibration() {
		const pad = this.input.getGamepad();
		if (!pad) return;
		this._calPadId = pad.id;
		// Axes ET boutons : sur une radio que le navigateur mappe en
		// « standard », le gaz sort sur une gâchette (#279).
		this._cal = beginCalibration(padSignals(pad).length, pad.axes.length);
		this._calLast = performance.now();
		this.el.calSummary.hidden = true;
		this.renderCalibration(pad);

		// L'assistant tourne sur SA PROPRE boucle, pas sur celle du vol :
		// renderer.setAnimationLoop(frame) ne démarre qu'au décollage, et le
		// panneau Tab s'ouvre aussi depuis le terminal, avant boot(). Sans
		// cette boucle, l'assistant y resterait figé sur sa première consigne —
		// c'est-à-dire cassé, exactement là où un pilote dont « ça ne marche
		// pas » va le chercher.
		const tick = () => {
			if (!this._cal) { this._calRaf = null; return; }
			this._calRaf = requestAnimationFrame(tick);
			const p = this.input.getGamepad();
			if (p) this.stepCalibration(p);
		};
		this._calRaf = requestAnimationFrame(tick);
	}

	cancelCalibration() {
		// Rien n'est écrit : un calibrage abandonné laisse le périphérique
		// exactement comme il était.
		this.stopCalibration();
		this.renderCalibration(this.input.getGamepad());
	}

	stopCalibration() {
		if (this._calRaf !== null) cancelAnimationFrame(this._calRaf);
		this._calRaf = null;
		this._cal = null;
		this._calPadId = null;
	}

	// ---------------------------------------------------------------------------
	// LA MACHINE QUI RÉAGIT AU MANCHE (issue #281)
	//
	// Le calibrage mesurait juste et ne montrait rien : le pilote poussait un
	// manche et ne voyait qu'une barre. Elle vit tant que le panneau est
	// ouvert et qu'il y a quelque chose à montrer — une mesure en cours, ou un
	// périphérique déjà calibré, et c'est alors un banc d'essai.
	// ---------------------------------------------------------------------------

	// Ce que la machine doit refléter à cette frame, ou null pour la pose de
	// repos. Aucune horloge ici : calibration-drone.js tient la sienne.
	calDroneSample() {
		const pad = this.input.getGamepad();
		if (!pad) return null;
		const signals = padSignals(pad);
		if (this._cal) return { state: this._cal, signals };

		// Mesure finie : la pose vient du calibrage écrit, par le même chemin
		// que le vol. `phase: 'done'` est tout ce que calibrationPose() lit.
		const cal = this.input.calibration;
		if (!cal) return null;
		return { state: { phase: 'done', channels: cal.channels, deadband: cal.deadband }, signals };
	}

	syncCalDrone() {
		const show = this.settingsOpen
			&& this.input.gamepadIndex !== null
			&& (this._cal !== null || this.input.isCalibrated());
		if (show) this.mountCalDrone(); else this.unmountCalDrone();
	}

	mountCalDrone() {
		if (this._calDrone) return;
		this._calDrone = calibrationDrone({ sample: () => this.calDroneSample() });
		this.el.calDrone.appendChild(this._calDrone.el);
		this.el.calDrone.hidden = false;
	}

	unmountCalDrone() {
		if (!this._calDrone) return;
		this._calDrone.stop();
		this._calDrone.el.remove();
		this._calDrone = null;
		this.el.calDrone.hidden = true;
	}

	// Une trame de mesure. Le dt vient d'ici et non de main.js : la machine
	// raisonne en millisecondes réelles, et updateAxisBars() n'en reçoit pas.
	stepCalibration(pad) {
		const now = performance.now();
		// Un onglet en arrière-plan rend un dt énorme au retour ; le borner
		// évite de valider une consigne que personne n'a tenue.
		const dt = Math.min(100, now - this._calLast);
		this._calLast = now;

		this._cal = feedSample(this._cal, padSignals(pad), dt);

		const result = calibrationResult(this._cal);
		if (result) {
			this.input.setCalibration(this._calPadId, result);
			// stopCalibration() efface _calPadId : la persistance passe AVANT.
			this.el.calSummary.textContent = '';
			for (const line of calSummaryLines(result)) {
				const div = document.createElement('div');
				div.textContent = line;
				this.el.calSummary.appendChild(div);
			}
			this.el.calSummary.hidden = false;
			this.stopCalibration();
			// Le mappage vient de changer sous les lignes d'axes : elles se
			// reconstruisent, elles ne se rafraîchissent pas.
			this._axisRows = [];
		}
		this.renderCalibration(pad);
	}

	renderCalibration(pad) {
		const running = this._cal !== null;
		this.syncCalDrone();
		this.el.calScreen.hidden = !running;
		this.el.calCancelRow.hidden = !running;
		this.el.calRow.hidden = running;
		this.el.padMap.hidden = running;
		this.el.padList.hidden = running;

		if (!running) {
			// La consigne ne doit pas survivre à la mesure : sinon rouvrir le
			// panneau ferait clignoter la dernière consigne d'un calibrage fini.
			this.el.calStep.textContent = '';
			this.el.calPrompt.textContent = '';
			this.el.calHint.textContent = '';
			this.el.calMessage.textContent = '';
			const calibrated = this.input.isCalibrated();
			this.el.calButton.disabled = this.input.gamepadIndex === null;
			this.el.calNote.textContent = this.el.calButton.disabled ? ''
				: calibrated ? 'this device is calibrated'
					: 'never calibrated — measured neutral, travel and throttle mode, about 20 s';
			return;
		}

		const { step, total } = calProgress(this._cal);
		this.el.calStep.textContent = `STEP ${step}/${total}`;
		this.el.calPrompt.textContent = this._cal.prompt;
		this.el.calHint.textContent = this._cal.hint;
		this.el.calMessage.textContent = this._cal.message ?? '';

		// La barre suit l'axe le plus écarté de son neutre : pendant une
		// consigne, c'est celui que le pilote est en train de pousser. Tant que
		// le neutre n'est pas mesuré, elle suit l'axe le plus écarté de zéro.
		const signals = pad ? padSignals(pad) : [];
		const centers = this._cal.centers;
		let best = 0;
		for (let i = 0; i < signals.length; i++) {
			const d = Math.abs(signals[i] - (centers?.[i] ?? 0));
			if (d > Math.abs(signals[best] - (centers?.[best] ?? 0))) best = i;
		}
		this.el.calBar.style.left = `${(((signals[best] ?? 0) + 1) / 2) * 100}%`;
	}

	buildPadList() {
		const pads = this.input.listGamepads();
		const box = this.el.padList;
		// updateAxisBars() rappelle buildAxisRows() à chaque frame tant qu'aucune
		// ligne n'a pu être construite (manette pas encore annoncée). Sans cette
		// signature, la liste se reconstruirait 60 fois par seconde et un clic
		// tomberait sur un bouton déjà remplacé.
		const sig = `${this.input.gamepadIndex}|${pads.map((g) => `${g.index}:${g.id}:${g.axes}:${g.buttons}`).join('|')}`;
		if (sig === this._padListSig) return;
		this._padListSig = sig;
		box.replaceChildren();
		// Ce qu'on montre est décidé par padListEntries() (input.js, pur et
		// testé) ; ici on ne fait que le peindre et le rendre cliquable.
		const entries = padListEntries(pads, this.input.gamepadIndex);
		if (!entries.length) {
			const p = document.createElement('p');
			p.textContent = PAD_LIST_EMPTY;
			box.appendChild(p);
			return;
		}
		for (const g of entries) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pad-entry';
			if (g.active) b.dataset.active = '1';
			b.textContent = g.label;
			b.onclick = () => {
				this.input.selectGamepad(g.index);
				// Le mappage par défaut change avec la classe du périphérique :
				// les lignes d'axes doivent se reconstruire, pas se rafraîchir.
				this._axisRows = [];
				this._padListSig = null;
				this.buildAxisRows();
			};
			box.appendChild(b);
		}
	}

	buildAxisRows() {
		this.buildPadList();
		const pad = this.input.getGamepad();
		this.el.padName.textContent = pad ? `${pad.id} — ${padKind(pad.id)}` : 'no controller detected';
		this.renderCalibration(pad);
		if (!pad) { this.el.padMap.innerHTML = ''; this._axisRows = []; return; }

		this.el.padMap.innerHTML = '';
		this._axisRows = CHANNELS.map((ch) => {
			const tr = document.createElement('tr');
			// Les boutons sont proposés comme les axes : un remap manuel doit
			// pouvoir désigner la gâchette où le navigateur a rangé le gaz.
			const opts = padSignals(pad)
				.map((_, i) => `<option value="${i}">${signalLabel(i, pad.axes.length)}</option>`)
				.join('');
			tr.innerHTML = `<td>${ch}</td>
				<td><select>${opts}</select></td>
				<td><label><input type="checkbox"> inv</label></td>
				<td><div class="axisbar"><i></i></div></td>`;
			const sel = tr.querySelector('select');
			const inv = tr.querySelector('input');
			sel.value = String(this.input.map[ch].axis);
			inv.checked = this.input.map[ch].invert;
			const save = () => this.input.setMapping(ch, Number(sel.value), inv.checked);
			sel.onchange = save;
			inv.onchange = save;
			this.el.padMap.appendChild(tr);
			return { ch, sel, fill: tr.querySelector('.axisbar i') };
		});
	}

	updateAxisBars() {
		if (!this.settingsOpen) return;

		// Une mesure en cours a sa propre boucle (startCalibration) et cache les
		// lignes de remap : il n'y a rien à rafraîchir ici.
		if (this._cal) return;

		// La manette a pu se faire connaître après l'ouverture du panneau
		// (ex. gamepadconnected pas encore levé par le navigateur au moment
		// du premier buildAxisRows()) : on retente tant qu'aucune ligne n'a
		// été construite plutôt que de rester bloqué sur "no controller detected".
		if (this._axisRows.length === 0) { this.buildAxisRows(); return; }
		const pad = this.input.getGamepad();
		if (!pad) return;
		for (const row of this._axisRows) {
			const v = padSignals(pad)[Number(row.sel.value)] ?? 0;
			row.fill.style.left = `${((v + 1) / 2) * 100}%`;
		}
	}
}
