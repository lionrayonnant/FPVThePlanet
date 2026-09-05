// Le geste de confirmation du terminal (issue #213).
//
// La Bible §44 refuse l'UI de navigateur : un `confirm()` est une modale
// système, elle casse la fiction du terminal et ne se navigue ni au clavier du
// jeu ni à la manette. Mais une action destructrice ne peut pas non plus partir
// sur une seule pression distraite. #211 a posé la réponse pour l'acquisition,
// et c'est celle-ci qu'on généralise :
//
//     [ REMOVE TERRAIN ]  →  [ REMOVE TERRAIN — CONFIRM ]  →  fait
//
// La deuxième pression EST la confirmation. L'armement retombe tout seul :
// après TIMEOUT_MS, ou dès que le curseur quitte le bouton — sans quoi un
// bouton armé attendrait indéfiniment la pression suivante, qui pourrait
// arriver pour une tout autre raison.
//
// La logique de décision est pure et testée sans DOM (tools/confirm-selftest.mjs) :
// `nextConfirmState` dit ce qu'une pression doit produire, `armConfirm` se
// contente de la câbler sur un vrai bouton.

export const CONFIRM_TIMEOUT_MS = 4000;

export const confirmLabel = (label) => `${label} — CONFIRM`;

// L'automate, en une fonction. `armed` est l'état courant du bouton ; le
// retour dit l'état suivant et si l'action doit partir maintenant.
export function nextConfirmState(armed) {
	return armed ? { armed: false, fire: true } : { armed: true, fire: false };
}

// Câble le geste sur un bouton existant.
// - `button` : l'élément. Son libellé courant devient le libellé neutre.
// - `onConfirm` : appelé à la DEUXIÈME pression seulement. Peut être async ;
//   le bouton reste désarmé pendant, et un rejet ne le laisse pas armé.
// - `timeoutMs` : retour à l'état neutre sans nouvelle pression.
// Rend une fonction qui désarme et détache les écouteurs de retombée.
export function armConfirm(button, onConfirm, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
	const neutral = button.textContent;
	let armed = false;
	let timer = 0;

	const disarm = () => {
		if (timer) { clearTimeout(timer); timer = 0; }
		if (!armed) return;
		armed = false;
		button.textContent = neutral;
		button.classList?.remove('cta-armed');
	};

	const onClick = async () => {
		const next = nextConfirmState(armed);
		if (!next.fire) {
			armed = true;
			button.textContent = confirmLabel(neutral);
			button.classList?.add('cta-armed');
			timer = setTimeout(disarm, timeoutMs);
			return;
		}
		disarm();
		await onConfirm();
	};

	button.addEventListener('click', onClick);
	// Quitter le bouton le désarme : au curseur comme au focus, parce que la
	// navigation du terminal se fait aux flèches autant qu'à la souris.
	button.addEventListener('mouseleave', disarm);
	button.addEventListener('blur', disarm);

	return () => {
		disarm();
		button.removeEventListener('click', onClick);
		button.removeEventListener('mouseleave', disarm);
		button.removeEventListener('blur', disarm);
	};
}
