// Bootstrapping de l'opérateur (PHASE 01, Bible §12–14).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD a
// déjà rempli ce conteneur. Tout le texte visible est en anglais (D5).
import * as operatorApi from './operator.js';
import { readGamepadDir } from './gamepad-dir.js';
import { menuNav, blockNav } from './menu-nav.js';
import { uiAudio } from './ui-audio.js';
import { watchReveal } from './motion.js';
import { versionLine } from './version.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

// ---------- inventaire honnête (arch doc §4) ----------

async function measureRefreshHz() {
	// requestAnimationFrame est gelé dans un onglet caché : on court la mesure
	// contre un timeout qui résout null (la ligne affiche déjà UNKNOWN pour null).
	return new Promise((resolve) => {
		const done = (v) => resolve(v);
		setTimeout(() => done(null), 2000);
		const t = [];
		const tick = (now) => {
			t.push(now);
			if (t.length < 60) return requestAnimationFrame(tick);
			const deltas = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
			const median = deltas[deltas.length >> 1];
			done(median > 0 ? Math.round(1000 / median) : null);
		};
		requestAnimationFrame(tick);
	});
}

function gpuString() {
	try {
		const gl = document.createElement('canvas').getContext('webgl2')
			|| document.createElement('canvas').getContext('webgl');
		if (!gl) return { renderer: 'NONE', gpu: 'UNKNOWN' };
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
		const isGl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
		return { renderer: isGl2 ? 'WEBGL2' : 'WEBGL1', gpu: gpu || 'UNKNOWN' };
	} catch { return { renderer: 'UNKNOWN', gpu: 'UNKNOWN' }; }
}

function audioString() {
	try {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		const ac = new Ctx();
		const s = `${ac.sampleRate} HZ / ${ac.destination.maxChannelCount} CH`;
		ac.close();
		return s;
	} catch { return 'UNKNOWN'; }
}

async function storageString() {
	try {
		const { quota } = await navigator.storage.estimate();
		return quota ? `${(quota / 1e9).toFixed(1)} GB QUOTA` : 'UNKNOWN';
	} catch { return 'UNKNOWN'; }
}

async function terrainCacheString() {
	try {
		const r = await fetch('/__map-api/scenes');
		const { scenes } = await r.json();
		return scenes.length ? `${scenes.length} AREAS` : 'EMPTY';
	} catch { return 'UNKNOWN'; }
}

export async function probeHardware() {
	const ua = navigator.userAgentData;
	const platform = (ua?.platform || navigator.platform || 'UNKNOWN').toUpperCase();
	const brand = ua?.brands?.find((b) => !/Not.?A.?Brand/i.test(b.brand))?.brand
		|| (navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)/)?.[1])
		|| 'UNKNOWN';
	const hz = await measureRefreshHz();
	const { renderer, gpu } = gpuString();
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	return [
		{ label: 'PLATFORM', value: platform },
		{ label: 'BROWSER', value: String(brand).toUpperCase() },
		{ label: 'LANGUAGE', value: (navigator.language || 'UNKNOWN').toUpperCase() },
		{ label: 'TIMEZONE', value: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UNKNOWN').toUpperCase() },
		// window.screen explicite : `screen` est shadowé par la fonction screen() de ce module.
		// Un écran à l'échelle produit un ratio comme 0.8999999761581421, qui
		// passait à la ligne et cassait la colonne. Un relevé se lit, il ne se
		// déverse pas : deux décimales, et pas de zéro inutile.
		{ label: 'DISPLAY', value: `${window.screen.width} × ${window.screen.height} @ ${(+window.devicePixelRatio.toFixed(2))}x` },
		{ label: 'REFRESH', value: hz ? `${hz} HZ` : 'UNKNOWN' },
		{ label: 'RENDERER', value: renderer },
		{ label: 'GPU', value: String(gpu).toUpperCase() },
		{ label: 'CORES', value: String(navigator.hardwareConcurrency || 'UNKNOWN') },
		{ label: 'INPUT', value: pad ? `${pad.id.slice(0, 32).toUpperCase()} / ${pad.axes.length} AXES` : 'NO GAMEPAD' },
		{ label: 'AUDIO', value: audioString() },
		{ label: 'NETWORK', value: navigator.onLine ? 'ONLINE' : 'OFFLINE' },
		{ label: 'STORAGE', value: await storageString() },
		{ label: 'TERRAIN CACHE', value: await terrainCacheString() },
	];
}

// Commentaires de crew : câblés sur ce qui a été trouvé, 2 à 4 par run.
// PHASE 21 : cet écran tourne avant le chargement de l'opérateur, donc avant
// que la mémoire du moteur de dialogue existe — le monter ici la figerait
// vide pour tout l'onglet. Lignes câblées en dur à dessein, ne pas relier au
// moteur de dialogue.
function crewNotes(rows) {
	const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	const out = [];
	const hz = parseInt(by.REFRESH, 10);
	if (hz >= 120) out.push('// root: ' + hz + 'hz', '// mikhail: acceptable');
	else if (hz) out.push('// root: ' + hz + 'hz', '// mikhail: we make do');
	if (by.INPUT === 'NO GAMEPAD') out.push('// root: no radio', '// mikhail: keyboard then');
	else out.push('// root: radio detected', '// cron: good');
	if (by.NETWORK === 'OFFLINE') out.push('// root: offline', '// cron: cache only');
	return out.slice(0, 4);
}

// ---------- montage d'écran ----------

function screen(root) {
	const el = document.createElement('div');
	el.className = 'bootstrap';
	el.innerHTML = '<div class="bootstrap-box"></div>';
	root.appendChild(el);
	const box = el.querySelector('.bootstrap-box');
	const unwatch = watchReveal(box); // issue #224
	return {
		el,
		box,
		remove: () => { unwatch(); el.remove(); },
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function revealLines(box, lines, { interval = 40 } = {}) {
	const pre = document.createElement('pre');
	box.appendChild(pre);
	let skipped = false;
	const skip = () => { skipped = true; };
	window.addEventListener('keydown', skip, { once: true });
	box.addEventListener('click', skip, { once: true });
	for (const line of lines) {
		pre.textContent += (pre.textContent ? '\n' : '') + line;
		if (!skipped) await sleep(interval);
	}
	if (skipped) pre.textContent = lines.join('\n');
	window.removeEventListener('keydown', skip);
	return pre;
}

function dotted(label, value, width = 20) {
	return `${label} ${'.'.repeat(Math.max(3, width - label.length))} ${value}`;
}

// ---------- écran 1 : HARDWARE DISCOVERY ----------

async function hardwareScreen(root) {
	const s = screen(root);
	const rows = await probeHardware();
	const notes = crewNotes(rows);
	const lines = [versionLine(), '', 'OPERATOR BOOTSTRAPPING', ''];
	rows.forEach((r, i) => {
		lines.push(dotted(r.label, r.value));
		if (i === 5 && notes[0]) lines.push(notes[0], notes[1] ?? '');
		if (i === 9 && notes[2]) lines.push(notes[2], notes[3] ?? '');
	});
	lines.push('', 'INITIALIZATION...');
	await revealLines(s.box, lines.filter((l) => l !== undefined));
	await new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		s.box.appendChild(button('CONTINUE', close));
		const nav = menuNav(s.el, {});
	});
}

function button(label, onClick) {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = `[ ${label} ]`;
	b.className = 'bootstrap-btn';
	b.onclick = onClick;
	return b;
}

// ---------- écran 2 : OPERATOR NAME ----------

async function nameScreen(root, api) {
	const s = screen(root);
	s.box.innerHTML = `
		<pre>OPERATOR NAME</pre>
		<input id="op-name" maxlength="24" autocomplete="off" spellcheck="false" placeholder="NEO">
		<div class="bootstrap-err" id="op-name-err"></div>`;
	const input = s.box.querySelector('#op-name');
	const err = s.box.querySelector('#op-name-err');
	input.focus();
	return new Promise((resolve) => {
		const submit = async () => {
			err.textContent = '';
			try {
				const state = await api.createOperator(input.value);
				nav.detach();
				s.remove();
				resolve(state);
			} catch (e) {
				err.textContent = e.message;
			}
		};
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		s.box.appendChild(button('REGISTER', submit));
		// Le champ garde son focus et ses touches (menu-nav ignore la saisie de
		// texte) ; la manette peut descendre sur REGISTER et valider avec A. Le
		// nom lui-même se tape au clavier — seul moment du jeu où il en faut un.
		const nav = menuNav(s.el, { focusFirst: false });
	});
}

// ---------- écrans 3+4 : CONTROL VECTOR ----------

export async function captureControlVector(root, initialLength = 6) {
	const s = screen(root);
	// Ici les flèches sont la donnée saisie, pas de la navigation : cet écran
	// ne s'abonne pas à menu-nav et rend inertes les navs restés montés
	// dessous (issue #123 — un écran s'abonne explicitement).
	const unblock = blockNav(s.el);
	let length = initialLength;
	let vec = [];
	let resolveVec;

	const render = () => {
		s.box.innerHTML = `
			<pre>DEFINE CONTROL VECTOR

4-8 INPUTS
DEFAULT LENGTH: 6

THIS VECTOR WILL BE REQUIRED
FOR FUTURE TARGET ACQUISITIONS.
WRITE IT DOWN.</pre>
			<div class="bootstrap-row">LENGTH:
				<button type="button" data-d="-1">[ - ]</button> ${length}
				<button type="button" data-d="1">[ + ]</button></div>
			<pre class="bootstrap-vec">${
				vec.map((d) => ARROW[d]).concat(Array(length - vec.length).fill('_')).join(' ')
			}</pre>`;
		s.box.querySelectorAll('[data-d]').forEach((b) => {
			b.onclick = () => {
				length = Math.min(8, Math.max(4, length + Number(b.dataset.d)));
				vec = [];
				render();
			};
		});
		s.box.appendChild(button('DELETE', () => { vec = vec.slice(0, -1); render(); }));
		const confirm = button('CONFIRM VECTOR', () => finish());
		confirm.disabled = vec.length !== length;
		s.box.appendChild(confirm);
	};

	const add = (dir) => {
		if (vec.length >= length) return;
		vec.push(dir);
		render();
	};

	const onKey = (e) => {
		const map = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
		if (map[e.key]) { e.preventDefault(); add(map[e.key]); }
		if (e.key === 'Backspace') { e.preventDefault(); vec = vec.slice(0, -1); render(); }
		// Entrée = CONFIRM VECTOR, aux mêmes conditions que le bouton (issue
		// #123 : tout doit être faisable au clavier seul).
		if (e.key === 'Enter' && vec.length === length) { e.preventDefault(); finish(); }
	};
	window.addEventListener('keydown', onKey);

	// A confirme (vecteur complet seulement), B efface — mêmes boutons que dans
	// menu-nav.js. Front montant, et « tenu » au départ : le geste qui a ouvert
	// cet écran ne doit pas confirmer ou effacer à travers lui.
	let padPrev = null;
	const padHeld = { 0: true, 1: true };
	const padPoll = setInterval(() => {
		const d = readGamepadDir(padPrev);
		if (d !== '__hold') {
			if (d) { padPrev = d; add(d); } else { padPrev = null; }
		}
		const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
		for (const b of [0, 1]) {
			const down = !!pad?.buttons[b]?.pressed;
			if (down && !padHeld[b]) {
				if (b === 0 && vec.length === length) finish();
				if (b === 1) { vec = vec.slice(0, -1); render(); }
			}
			padHeld[b] = down;
		}
	}, 80);

	// finish() : déclaration hoistée dans le scope de la fonction pour rester
	// visible depuis render() (referme sur resolveVec, câblé par l'exécuteur).
	function finish() {
		window.removeEventListener('keydown', onKey);
		clearInterval(padPoll);
		unblock();
		s.remove();
		resolveVec(vec.slice());
	}

	render();

	return new Promise((resolve) => {
		resolveVec = resolve;
	});
}

async function registeredScreen(root, vec) {
	const s = screen(root);
	s.box.innerHTML = `<pre>CONTROL VECTOR REGISTERED

${vec.map((d) => ARROW[d]).join(' ')}

KEEP THIS VECTOR.
YOU WILL NEED IT.</pre>`;
	return new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		s.box.appendChild(button('CONTINUE', close));
		const nav = menuNav(s.el, {});
	});
}

// ---------- séquence complète ----------

export async function bootstrap(root, api = operatorApi) {
	await hardwareScreen(root);
	await nameScreen(root, api);
	const vec = await captureControlVector(root, 6);
	api.patch('controlVector', vec);
	await flushOrRetry(root, api);
	await registeredScreen(root, vec);
	return api.getOperator();
}

// flush() jette si rien n'a pu être écrit : on montre l'erreur sur l'écran
// courant avec un bouton RETRY plutôt que d'annoncer « REGISTERED » à tort.
async function flushOrRetry(root, api) {
	while (true) {
		try { await api.flush(); return; }
		catch {
			uiAudio.play('ERROR');
			const s = screen(root);
			const ok = await new Promise((resolve) => {
				const retry = () => { nav.detach(); s.remove(); resolve(true); };
				s.box.innerHTML = '<pre>VECTOR NOT SAVED — RETRY</pre>';
				s.box.appendChild(button('RETRY', retry));
				const nav = menuNav(s.el, {});
			});
			if (!ok) return;
		}
	}
}
