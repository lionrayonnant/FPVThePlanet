// Faux AudioContext, juste assez complet pour les modules audio du dépôt
// (PHASE 18). Il n'émet aucun son : il RECENSE. Ce qu'on veut pouvoir affirmer
// sous Node, sans navigateur :
//   - le graphe est branché jusqu'à la destination (un `connect` oublié est
//     silencieux dans une vraie Web Audio, et donc invisible à l'oreille comme
//     au débogueur) ;
//   - une partition est programmée aux bons instants ;
//   - rien ne fuit : tout nœud one-shot finit disconnect().
//
// Aucune dépendance. Ne sert qu'aux tests.

function makeParam(name, value) {
	return {
		_param: `param:${name}`,
		value,
		calls: [],
		setValueAtTime(v, t) { this.value = v; this.calls.push(['setValueAtTime', v, t]); return this; },
		linearRampToValueAtTime(v, t) { this.value = v; this.calls.push(['linearRampToValueAtTime', v, t]); return this; },
		exponentialRampToValueAtTime(v, t) { this.value = v; this.calls.push(['exponentialRampToValueAtTime', v, t]); return this; },
		setTargetAtTime(v, t, tau) { this.value = v; this.calls.push(['setTargetAtTime', v, t, tau]); return this; },
		cancelScheduledValues(t) { this.calls.push(['cancelScheduledValues', t]); return this; },
	};
}

export function fakeAudioContext({ sampleRate = 48000, state = 'running' } = {}) {
	const nodes = [];
	const conns = [];
	let nextId = 0;

	const node = (type, extra = {}) => {
		const n = {
			id: ++nextId,
			type,
			disconnected: false,
			connect(dst) {
				conns.push([this.id, dst.id ?? dst._param ?? 'unknown']);
				return dst;
			},
			disconnect() { this.disconnected = true; },
			...extra,
		};
		nodes.push(n);
		return n;
	};

	const source = (type, extra = {}) => node(type, {
		started: null,
		stopped: null,
		onended: null,
		start(t = 0) { this.started = t; },
		stop(t = 0) { this.stopped = t; },
		...extra,
	});

	const ctx = {
		sampleRate,
		state,
		currentTime: 0,
		createGain: () => node('gain', { gain: makeParam('gain', 1) }),
		createOscillator: () => source('oscillator', {
			type: 'sine',
			frequency: makeParam('frequency', 440),
			detune: makeParam('detune', 0),
		}),
		createBiquadFilter: () => node('biquad', {
			type: 'lowpass',
			frequency: makeParam('frequency', 350),
			Q: makeParam('Q', 1),
			gain: makeParam('gain', 0),
		}),
		createStereoPanner: () => node('panner', { pan: makeParam('pan', 0) }),
		// maxDelayTime est retenu : un DelayNode dont on vise un temps au-delà
		// de son maximum sature silencieusement dans le vrai navigateur, et
		// c'est le genre de plafond qu'un test doit pouvoir constater.
		createDelay: (maxDelayTime = 1) => node('delay', {
			maxDelayTime,
			delayTime: makeParam('delayTime', 0),
		}),
		createDynamicsCompressor: () => node('compressor', {
			threshold: makeParam('threshold', -24),
			knee: makeParam('knee', 30),
			ratio: makeParam('ratio', 12),
			attack: makeParam('attack', 0.003),
			release: makeParam('release', 0.25),
		}),
		createBufferSource: () => source('bufferSource', {
			buffer: null,
			loop: false,
			playbackRate: makeParam('playbackRate', 1),
			detune: makeParam('detune', 0),
		}),
		createBuffer: (channels, length, rate) => ({
			numberOfChannels: channels,
			length,
			sampleRate: rate,
			getChannelData: () => new Float32Array(length),
		}),
		resume() { this.state = 'running'; return Promise.resolve(); },
		close() { this.state = 'closed'; return Promise.resolve(); },
		_nodes: nodes,
		_conns: conns,
	};
	ctx.destination = node('destination');
	return ctx;
}

// Vrai si `from` atteint `to` en suivant les connexions. Le test utile n'est
// pas « le nœud existe » mais « le son sort ».
export function reaches(ctx, from, to, seen = new Set()) {
	if (from === to) return true;
	if (seen.has(from)) return false;
	seen.add(from);
	return ctx._conns
		.filter(([a]) => a === from)
		.some(([, b]) => typeof b === 'number' && reaches(ctx, b, to, seen));
}
