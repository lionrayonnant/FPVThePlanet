// Home minimale de l'opérateur (PHASE 01). JETABLE : PHASE 02 remplace ce
// fichier par l'Operator Terminal. Écrans montés en append dans #ui.
import * as operatorApi from './operator.js';
import { captureControlVector, bootstrap } from './bootstrap.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

function screen(root) {
	const el = document.createElement('div');
	el.className = 'bootstrap';
	el.innerHTML = '<div class="bootstrap-box"></div>';
	root.appendChild(el);
	return { box: el.querySelector('.bootstrap-box'), remove: () => el.remove() };
}

function button(label, onClick) {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = `[ ${label} ]`;
	b.onclick = onClick;
	return b;
}

export async function operatorSelect(root, choices) {
	const s = screen(root);
	s.box.innerHTML = '<pre>OPERATOR SELECT</pre>';
	return new Promise((resolve) => {
		for (const c of choices) {
			s.box.appendChild(button(c.name.toUpperCase(), () => { s.remove(); resolve({ id: c.id }); }));
		}
		s.box.appendChild(button('+ NEW OPERATOR', () => { s.remove(); resolve({ create: true }); }));
	});
}

export async function home(root, api = operatorApi) {
	const s = screen(root);
	// resolveHome est câblé par l'exécuteur de la Promise ci-dessous ; render()
	// referme dessus (même motif que finish() dans bootstrap.js:captureControlVector).
	let resolveHome;

	const render = () => {
		const op = api.getOperator();
		const vec = op.controlVector?.length
			? op.controlVector.map((d) => ARROW[d]).join(' ')
			: '(not set)';
		s.box.innerHTML = `<pre>OPERATOR // ${op.name.toUpperCase()}

CONTROL VECTOR   ${vec}</pre>`;
		s.box.appendChild(button('FLY', () => { s.remove(); resolveHome(); }));
		s.box.appendChild(button('CONTROL VECTOR', async () => {
			const v = await captureControlVector(root, op.controlVector?.length || 6);
			api.patch('controlVector', v);
			await api.flush();
			render();
		}));
		s.box.appendChild(button('SWITCH OPERATOR', async () => {
			const list = await api.listOperators();
			const pick = await operatorSelect(root, list);
			if (pick.create) await bootstrap(root);
			else await api.selectOperator(pick.id);
			render();
		}));
		const foot = document.createElement('pre');
		foot.textContent = '\nFPVTP! // LOCAL INSTALLATION';
		foot.style.opacity = '.55';
		s.box.appendChild(foot);
	};

	return new Promise((resolve) => {
		resolveHome = resolve;
		render();
	});
}
