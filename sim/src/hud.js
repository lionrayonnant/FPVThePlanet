// Écran de chargement. Le menu des cartes est devenu le terminal opérateur
// (terminal.js), le panneau Tab est parti dans settings.js, et l'OSD de vol
// s'est scindé en deux couches à la PHASE 12 (drone-osd.js et fpvtp-osd.js).
// Il ne reste ici que le chargement — PHASE 13 le déplacera derrière le TARGET
// SCAN.

export class Hud {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
			<div id="loading" hidden><div class="box">
				<h1>FPVThePlanet!</h1>
				<p id="loading-status">chargement…</p>
				<div class="bar"><div id="loading-bar"></div></div>
				<p id="loading-detail"></p>
				<p id="loading-clock"></p>
			</div></div>`);

		this.el = {
			loading: root.querySelector('#loading'),
			status: root.querySelector('#loading-status'),
			bar: root.querySelector('#loading-bar'),
			detail: root.querySelector('#loading-detail'),
			clock: root.querySelector('#loading-clock'),
		};
	}

	progress(text, fraction) {
		this.el.status.textContent = text;
		if (fraction !== undefined) this.el.bar.style.width = `${Math.round(fraction * 100)}%`;
	}

	detail(text) {
		this.el.detail.textContent = text;
	}

	show() { this.el.loading.hidden = false; }

	// A ticking clock is the cheapest way to tell "slow" apart from "hung", and
	// naming the current step says which part is the slow one.
	startClock() {
		const t0 = performance.now();
		this._stage = { name: '', at: t0 };
		this._clock = setInterval(() => {
			const total = (performance.now() - t0) / 1000;
			const inStage = (performance.now() - this._stage.at) / 1000;
			this.el.clock.textContent = this._stage.name
				? `${total.toFixed(0)} s — étape « ${this._stage.name} » depuis ${inStage.toFixed(0)} s`
				: `${total.toFixed(0)} s`;
		}, 250);
	}

	setStage(name) {
		if (this._stage) this._stage = { name, at: performance.now() };
	}

	fail(err) {
		clearInterval(this._clock);
		// Error text is data, never markup: a message that carried user input
		// (an unknown ?scene= slug) used to run through innerHTML.
		const span = document.createElement('span');
		span.className = 'err';
		span.textContent = String(err);
		this.el.status.replaceChildren(span);
		this.el.bar.style.width = '0%';
	}

	ready() {
		clearInterval(this._clock);
		this.el.loading.hidden = true;
	}
}
