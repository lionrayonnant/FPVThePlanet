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
//     ATTENTION, couplage à préserver : deux de ces lignes sont re-parsées en
//     aval par `parsePrepLine()` (tools/lib/add-map-core.mjs), qui les
//     détecte dans le stdout de `node tools/prep.mjs` pour piloter l'UI du
//     scanner PHASE 05. Un décodeur DOIT les émettre au mot près (obj.mjs les
//     produit actuellement) :
//       "<N> materials, <N> without a texture"   — RE_MATERIALS
//       "<N> vertices, <N> uvs, <N> triangles"    — RE_GEOMETRY, et c'est ELLE
//         qui fait basculer l'écran de DECODE à REBUILD (rien après cette
//         ligne ne relit plus l'entrée). Un futur décodeur qui reformule cette
//         ligne laisse le scanner bloqué sur DECODE indéfiniment, sans qu'aucun
//         test ne le détecte — voir parsePrepLine pour le contrat exact.
//
// DecodeResult = {
//   materials    : [{ name, texture }] — texture est un chemin ABSOLU ou un
//                  Buffer (textures embarquées), ou null si le matériau n'a
//                  pas de texture.
//   byName       : Map<name, index dans materials> — OPTIONNEL, interne au
//                  décodeur (usage propre à obj.mjs pendant son parsing).
//                  prep.mjs ne le lit pas : voir la déstructuration `const {
//                  materials, vx, vy, vz, tu, tv, triByMat, vertCount } =
//                  decoded`. Un futur décodeur n'est pas obligé d'en produire un.
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
//   vertCount    : entier — REQUIS, lu par prep.mjs (voir la déstructuration
//                  citée plus haut).
//   faceCount, polyFaces, unmatchedPairs : entiers, OPTIONNELS. obj.mjs les
//                  loggue lui-même avant de rendre (onLog), au moment où il
//                  les connaît encore ; rien en aval ne les relit sur le
//                  DecodeResult. Un futur décodeur n'est pas obligé de les
//                  produire.
//   attribution  : string[] — lignes de crédit lues DANS les tuiles décodées
//                  (ex. asset.copyright glTF). Prime sur l'attribution annoncée
//                  par le fournisseur, qui prime sur le défaut. Un décodeur qui
//                  ne sait rien dire (OBJ) rend [].
//   textures(tileDir) -> Promise<(string|null)[]>   — OPTIONNEL (issue #110)
//     La liste ORDONNÉE des textures du dossier, une par couche, dans l'ordre
//     que prep.mjs assigne aux couches ; chemin absolu, ou null pour un
//     matériau sans texture. Sert au contrôle de convention UV de
//     tools/selftest.mjs, qui relisait jusqu'ici exp_model.mtl lui-même —
//     la dernière hypothèse « l'entrée est de l'OBJ » hors de ce dossier.
//     Un décodeur ne l'expose QUE s'il peut répondre sans décoder toute la
//     tuile : rocktree.mjs ne le peut pas (ses atlas sont des Buffers
//     construits pendant le décodage, réparation d'imagerie comprise) et ne
//     l'expose donc pas. Le contrôle se met alors en SKIP, en le disant.
import * as obj from './obj.mjs';
import * as rocktree from './rocktree.mjs';

export const DECODERS = [obj, rocktree];

export function pick(tileDir) {
	const d = DECODERS.find((x) => x.sniff(tileDir));
	if (!d) throw new Error(`aucun décodeur ne reconnaît ${tileDir} (connus : ${DECODERS.map((x) => x.id).join(', ')})`);
	return d;
}
