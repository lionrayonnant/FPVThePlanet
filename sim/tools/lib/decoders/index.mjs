// Sélection du décodeur : on renifle le dossier plutôt que de le déclarer, pour
// que prep.mjs garde sa signature CLI et reste découplé du fournisseur. Si un
// jour un fournisseur sert de l'OBJ, il réutilise ce décodeur sans rien dire.
//
// Contrat d'un décodeur (issue #18) :
//   id      : string — identifiant court ('obj', 'gltf', ...).
//   sniff(tileDir) -> boolean
//     Détecte le FORMAT à partir des fichiers présents dans tileDir, sans
//     juger de leur contenu (voir le commentaire dans obj.mjs : c'est decode()
//     qui valide l'usabilité, pas sniff()).
//   decode(tileDir, { onLog }) -> Promise<DecodeResult>
//     onLog(line) reçoit des lignes NON horodatées (prep.mjs préfixe avec son
//     propre stamp() — le décodeur n'emporte pas l'horloge). Les erreurs sont
//     levées (jamais process.exit) : c'est une bibliothèque, pas un point
//     d'entrée CLI.
//
// DecodeResult = {
//   materials    : [{ name, texture }] — texture est un chemin ABSOLU ou un
//                  Buffer (textures embarquées), ou null si le matériau n'a
//                  pas de texture.
//   byName       : Map<name, index dans materials>
//   vx, vy, vz   : Growable(Float64Array) — sommets en ECEF, mètres.
//   tu, tv       : Growable(Float32Array) — UV en CONVENTION MOTEUR, c'est-à-
//                  dire origine en haut-gauche (DataArrayTexture force
//                  flipY=false). CHAQUE DÉCODEUR DÉCIDE POUR SON PROPRE COMPTE
//                  s'il doit inverser l'axe V pour y arriver : OBJ a l'origine
//                  UV en bas-gauche (obj.mjs inverse), glTF l'a déjà en
//                  haut-gauche (un futur décodeur glTF n'inversera PAS). C'est
//                  le mécanisme derrière les « textures grises » historiques
//                  du projet (21 % de la surface visible échantillonnant le
//                  padding gris) — ne pas remonter cette décision dans le
//                  contrat, ni la mutualiser entre décodeurs.
//   triByMat     : par matériau, Growable(Uint32Array) de paires (vIdx, uvIdx),
//                  6 entrées par triangle, déjà fan-triangulé.
//   vertCount, faceCount, polyFaces, unmatchedPairs : entiers, pour les logs.
//   attribution  : string[] — lignes de crédit lues DANS les tuiles décodées
//                  (ex. asset.copyright glTF). Prime sur l'attribution annoncée
//                  par le fournisseur, qui prime sur le défaut. Un décodeur qui
//                  ne sait rien dire (OBJ) rend [].
import * as obj from './obj.mjs';

export const DECODERS = [obj];

export function pick(tileDir) {
	const d = DECODERS.find((x) => x.sniff(tileDir));
	if (!d) throw new Error(`aucun décodeur ne reconnaît ${tileDir} (connus : ${DECODERS.map((x) => x.id).join(', ')})`);
	return d;
}
