// Interpolation d'une entrée de dialogue (PHASE 21). Pur, sans DOM.
//
// La règle est volontairement brutale : si un slot ne résout pas, on JETTE. Ce
// cas ne peut se produire que sur un corpus qui n'a pas passé validate.mjs,
// donc en développement — le runtime, lui, n'appelle render() que sur des
// entrées déjà déclarées éligibles par engine.mjs. Mieux vaut une exception
// bruyante au banc qu'un « {wind} meters per second » affiché au joueur.
import { SLOTS, resolvePath } from './catalog.mjs';

export function render(entry, ctx) {
	return (entry?.lines ?? []).map((line) => {
		const text = String(line.text ?? '').replace(/\{([a-z_]+)\}/g, (whole, name) => {
			const slot = SLOTS[name];
			if (!slot) throw new Error(`slot inconnu du catalogue : {${name}} (entrée ${entry?.id})`);
			const raw = resolvePath(ctx, slot.path);
			if (raw === null) throw new Error(`slot non résolu : {${name}} → ${slot.path} (entrée ${entry?.id})`);
			return slot.format(raw);
		});
		return { speaker: line.speaker, text };
	});
}
