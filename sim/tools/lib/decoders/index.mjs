// Sélection du décodeur : on renifle le dossier plutôt que de le déclarer, pour
// que prep.mjs garde sa signature CLI et reste découplé du fournisseur. Si un
// jour un fournisseur sert de l'OBJ, il réutilise ce décodeur sans rien dire.
import * as obj from './obj.mjs';

export const DECODERS = [obj];

export function pick(tileDir) {
	const d = DECODERS.find((x) => x.sniff(tileDir));
	if (!d) throw new Error(`aucun décodeur ne reconnaît ${tileDir} (connus : ${DECODERS.map((x) => x.id).join(', ')})`);
	return d;
}
