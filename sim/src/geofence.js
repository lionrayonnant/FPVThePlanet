// Les limites de la zone (issue #139) : où le monde s'arrête, et ce qui
// arrive quand on y va.
//
// Ni THREE, ni Rapier, ni DOM — même règle et même raison que wind.js,
// fog.js, link.js et flight-end.js : c'est la moitié que
// tools/geofence-selftest.mjs peut vérifier sans navigateur. Qui pousse la
// force dans Rapier, l'avertissement dans l'OSD et la perte dans le budget de
// liaison est le problème de main.js.
//
// La fiction n'est pas la portée radio, c'est LA ZONE SCANNÉE : le joueur a
// dessiné ce rectangle lui-même dans le Global Scanner, et hors de lui il n'y
// a pas de données — donc pas de couverture, donc pas de lien. Une portée
// radio aurait été un cercle centré sur le pilote, or le spawn n'est pas
// centré dans la bbox (sur tour-eiffel il est à (−120, 140) dans une boîte de
// ±642 m) : le cercle inscrit gaspillerait la moitié de la carte, le
// circonscrit déborderait dans le vide.

export const NOMINAL = 'NOMINAL';
export const CAUTION = 'CAUTION';   // averti
export const HOLD = 'HOLD';         // averti et retenu
export const LOST = 'LOST';         // dehors ; l'image est en train de mourir

// Mesurés par tools/geofence-measure.mjs sur public/scenes/tour-eiffel, sur
// les 6 familles de drone-profiles.js. Re-figés le 2026-08-31 (issues #141,
// #142) : les deux paragraphes ci-dessous décrivent le protocole ACTUEL, pas
// celui de la première mesure du 2026-08-30.
//
// Le protocole est EN ACRO, le mode du jeu (FlightController démarre en
// `acro`, entry-state.js:241 le force). Ça change tout : en ACRO des manches
// centrées ne remettent pas à plat, elles TIENNENT l'assiette. « Lâcher les
// manches » n'est donc pas une façon d'obéir ici, et « obéir » doit être un
// programme de manche explicite. Le voici, en entier — c'est lui, la
// définition :
//
//   approche : plein gaz, tangage tenu à une assiette BALAYÉE sur 42° / 55° /
//     70° / 85° (issue #141 — rien ne plafonne le tangage à ANGLE_MAX_TILT en
//     ACRO, ce plafond n'existe que pour le mode ANGLE, absent de ce jeu), et
//     le pire des quatre retenu par famille ;
//   freinage, dès l'entrée en HOLD : gaz ramenés quelque part entre zéro et
//     le stationnaire — bande BALAYÉE de 0 à hoverThrottle(), pire cas
//     PLAUSIBLE retenu (issue #142 — un gaz qui fait tomber l'appareil de
//     plus de 40 m, RANGES.COMFORTABLE.aglM[1] d'entry-state.js, pendant le
//     freinage aurait déjà touché le sol à toute altitude réellement jouable ;
//     il reste dans le balayage mais pas dans la sélection du pire cas) ; et
//     tangage TIRÉ pour ramener l'appareil à plat, puis CENTRÉ dès l'horizon
//     revenu et plus jamais touché. À partir de là l'ACRO tient l'assiette :
//     rien ne le remet à plat à sa place, et le résidu qu'il a laissé, il le
//     garde.
//
// Ensuite, seuls A_MAX et la traînée de quad.js décélèrent. Manches ramenés
// au calme et non tirés à fond, délibérément : un pilote qui insiste DOIT
// pouvoir passer, c'est la moitié du design. R_HOLD dimensionne le cas où on
// obéit, pas le cas où on désobéit.
//
// Ce n'est pas une soustraction mais un POINT FIXE : la rampe du rappel (0 à
// A_MAX sur R_HOLD mètres, pushOf() plus bas) dépend elle-même de R_HOLD, donc
// rétrécir le couloir durcit la rampe et change la distance qu'on mesure avec.
// Trouvé par itération directe pour chaque famille (voir la trace complète
// dans tools/geofence-measure.mjs à chaque run).
//
// Pire famille : race5, 72,26 m, arrondie au mètre supérieur — et non plus
// heavy5 (65,83 m sous l'ancien protocole plafonné à 42°). Le balayage
// d'assiette change le classement : à 85° race5 atteint 42,72 m/s contre
// 36,29 pour heavy5, et cet écart de vitesse pèse plus que l'écart de traînée
// de carène qui faisait gagner heavy5 à 42°. Les six valeurs vont de 22,50 m
// (toothpick) à 72,26 m (race5).
//
// La marge de sécurité visée par ce point fixe (12 m, MARGIN_M) est mesurée
// elle aussi : c'est la dispersion du point d'arrêt sur le balayage des gaz de
// freinage PLAUSIBLES (6,69 m au point fixe de race5, la pire des six
// familles), arrondie au mètre supérieur — l'écart que produit à elle seule la
// seule hypothèse de pilotage qu'on ne sait pas trancher. Le banc la re-mesure
// et refuse de livrer un chiffre si elle la dépasse.
export const R_HOLD = 73;      // m : distance d'arrêt du pilote qui obéit
// R_HOLD + le temps de lire l'avertissement à la vitesse maximale mesurée
// (42,72 m/s, race5, plein gaz à 85°). Ce délai est de la mise en scène et
// s'assume comme telle, mais il s'ancre sur une constante du dépôt : un
// avertissement doit clignoter trois fois pour être lu, et BLINK_PERIOD_MS
// vaut 500 ms (drone-osd.js:51). Soit 1,5 s, et la bande de 65 m ci-dessous
// en vaut 1,52 à cette vitesse-là.
export const R_CAUTION = 138;  // m : R_HOLD + 1,5 s à la vitesse maximale

// La pire vitesse mesurée par tools/geofence-measure.mjs (race5, plein gaz à
// 85°, voir le commentaire de R_CAUTION ci-dessus) — exportée séparément
// parce que la fenêtre de streaming rocktree (#168, #170) en a besoin pour
// dimensionner son propre rayon de chargement, sur le même principe que
// R_CAUTION : la distance qu'il faut pour réagir est celle que la pire
// vitesse mesurée impose. Un seul chiffre mesuré, deux consommateurs.
export const WORST_MEASURED_SPEED_MS = 42.72;

// ---------------------------------------------------------------------------
// Et la carte, dans tout ça : LA BORNE
// ---------------------------------------------------------------------------
//
// TOUS LES COMPTAGES DE CARTES DE CE BLOC portent sur public/scenes.json —
// 24 entrées le 2026-08-31 — et sur lui seul, parce que c'est le seul
// inventaire de cartes que git suive. public/scenes/ est gitignoré : son
// contenu varie d'une machine à l'autre, donc un nombre compté dessus n'est
// vérifiable par personne d'autre.
//
// Les deux chiffres ci-dessus (R_HOLD, R_CAUTION) sont des SCALAIRES GLOBAUX
// mesurés sur tour-eiffel, dont le plus petit demi-côté fait 641 m — bien plus
// grand que R_CAUTION. Sur une petite carte, R_CAUTION tout seul peut avaler
// la carte entière avant même de parler de R_HOLD.
//
// Geofence BORNE donc son couloir horizontal à un tiers du plus petit
// demi-côté de la bbox de la scène, les deux seuils mis à l'échelle par le
// MÊME facteur — pour que leur RAPPORT survive à la réduction, et avec lui le
// temps d'avertissement, qui est tout ce que R_CAUTION apporte :
//
//   halfMin = min((max.x − min.x)/2, (max.z − min.z)/2)
//   scale   = min(1, (halfMin / 3) / R_CAUTION)
//
// Le cœur volable — la zone où rien ne clignote — ne descend ainsi JAMAIS sous
// 67 % du plus petit côté, et une grande carte garde exactement la valeur
// mesurée (scale === 1, à l'identique bit pour bit).
//
// C'est une BORNE, pas une mesure. Elle n'invalide pas les chiffres du dessus,
// elle dit ce qu'on en garde quand la carte ne peut pas les payer. Une vraie
// mesure PAR SCÈNE a été écartée pour deux raisons : elle exigerait de rejouer
// tools/geofence-measure.mjs sur chacune des cartes (et de refiger deux
// nombres par famille à chaque `npm run add-map`), et surtout le banc NE
// TOURNE PAS sur les petites : il lui faut l'élan d'amener la famille à sa
// vitesse de pic PLUS le couloir d'essai devant la face, et une petite carte
// n'a pas cette place. Il refuse plutôt que de mesurer une approche qui n'a
// pas eu la place d'exister.
//
// `scale` s'applique à TOUT le couloir, `lost` compris : la clôture reste UNE
// forme, mise à l'échelle d'un bloc. Le segment au-delà du bord n'est contraint
// par rien de géométrique et la symétrie qui le justifiait sur une grande carte
// (« la distance qu'il faut pour s'arrêter est celle que l'image coûte ») n'a
// plus de sens une fois le couloir borné — mais un grand couloir de mort
// au-delà d'une petite carte serait disproportionné dans l'autre sens.
// Homothétie, donc, et pas de découplage.
//
// Le couloir effectivement appliqué est lisible sur l'instance
// (`fence.effectiveCorridor`), c'est lui qu'il faut montrer au joueur, pas la
// constante.
//
// CE QUE LA BORNE ÉCHANGE. Rétrécir le couloir raidit la rampe (`pushOf` étale
// toujours 0 → A_MAX sur `hold` mètres) mais ne rend pas au drone la distance
// qu'il lui faut : sous HOLD_STOP_GUARANTEE_M de rappel, le pilote qui OBÉIT
// (le programme de manche ci-dessus, exactement) franchit quand même le bord
// des données. C'est irréparable en gardant le design : durcir A_MAX au point
// d'arrêter la pire famille sur une carte de poche détruirait le « ce n'est
// pas un mur » qui EST le principe de la clôture.
//
// Le mode de défaillance reste doux, et c'est ce qui rend l'échange tenable :
// tant que la pénétration n'atteint pas `lost`, `over` reste faux et la
// session n'est PAS perdue — l'image agonise et le rappel repousse encore. On
// paie en image, pas en session.
//
// QUELLES CARTES SONT CONCERNÉES, MAINTENANT (#146) : pas une liste figée ici
// — celle qui existait avant nommait six scènes quand il y en avait sept, et
// citait des chiffres qu'aucune des re-mesures suivantes (#141, #142) n'a
// remis à jour. `node tools/geofence-check-scenes.mjs` relit
// public/scenes.json et le manifeste réel de chaque carte présente en local,
// et liste celles où HOLD_STOP_GUARANTEE_M n'est pas atteint — à date de ce
// commit, 9 des 24 : nantes, caen, parcdesprinces, bastille, triomphe,
// seine-iena-alma, roosevelt, betheny, palais-de-l-elysee. C'est la commande
// qui fait foi, pas ce commentaire.

// Le couloir HOLD effectif en dessous duquel la garantie ci-dessus tombe.
// Mesuré, pas choisi : `node tools/geofence-measure.mjs --guarantee` le rejoue
// par bissection sur la pire famille (race5, depuis #141) depuis un bracket
// anchré sur R_HOLD — jamais sur cette constante-ci — et refuse un chiffre
// s'il n'encadre pas ou ne converge pas. 2026-08-31, bracket [18,25 ; 73,00] :
// `59,433 < hold* <= 59,446 m`, soit un demi-côté de carte de 337,1 m.
//
// Figé à 60 et non 59 : l'arrondi est délibérément vers le HAUT, même logique
// qu'ailleurs dans ce fichier — une garde qui avertit à tort coûte une phrase
// au développeur qui ajoute la carte ; une garde qui se tait à tort laisse
// passer une carte où le pilote qui obéit franchit le bord sans que personne
// ne l'ait su.
//
// Exporté et non recopié parce que tools/lib/add-map-core.mjs et
// tools/geofence-check-scenes.mjs (#146) s'en servent tous les deux pour
// avertir — l'un à l'ajout d'une carte, l'autre en relisant scenes.json —
// sans quoi ce nombre deviendrait un second exemplaire à tenir à jour,
// exactement le problème que ces deux outils ferment.
export const HOLD_STOP_GUARANTEE_M = 60;

// Le couloir vertical, lui, ne se mesure pas — et c'est délibéré. Une distance
// d'arrêt n'a pas de sens ici : on n'arrive pas sous la dalle en fonçant, on y
// arrive en se faufilant. Ces trois nombres sont posés sur un argument
// géométrique : deux mètres sous la surface la PLUS BASSE de la carte, on est
// forcément sous quelque chose. Il n'y a aucun faux positif à écarter, donc
// rien à séparer, donc rien à mesurer.
//
// Le signe est ce qui compte le plus dans ce fichier. Tout le couloir est SOUS
// bbox.min.y. Le poser au-dessus pousserait le drone vers le haut au point le
// plus bas de la carte — la surface de la Seine sur ile-de-la-cite, où voler à
// deux mètres de l'eau est un vol parfaitement normal.
export const FLOOR_CAUTION = 2;   // m sous bbox.min.y : l'avertissement
export const FLOOR_HOLD = 5;      // le rappel vers le haut commence
export const FLOOR_EDGE = 8;      // le rappel est plein, la perte s'emballe
export const FLOOR_LOST = 10;     // fin de session

// Le rappel, en m/s². 60 % de ce que le drone dépense simplement à tenir un
// stationnaire. Ce chiffre est choisi, et il est choisi pour ce qu'il NE fait
// PAS : il ne dépasse pas la poussée disponible. Un pilote qui lâche les
// manches est ramené ; un pilote qui insiste plein gaz passe, et perd sa
// session. Ce n'est pas un mur, c'est le failsafe du drone qui se bat contre
// toi — un comportement qu'un pilote FPV reconnaît.
export const A_MAX = 0.6 * 9.81;

// Hystérésis sur les frontières de zone, en MÈTRES ABSOLUS (issue #143).
// Sans elle, un stationnaire tenu pile sur R_CAUTION fait strober
// l'avertissement de l'OSD. link.js a exactement ce problème et exactement
// cette réponse (FREEZE_ENTER / FREEZE_LEAVE, et son commentaire : « at a
// single threshold the picture strobes between frozen and clean while you
// hover on the boundary »).
//
// Était une FRACTION du couloir (15 %), justifiée par « la dérive d'un
// stationnaire tenu, qui se compte en dizaines de centimètres ». Faux pour ce
// jeu : le vol est en ACRO (entry-state.js:241), qui NE S'AUTO-NIVELLE PAS —
// manches centrés, l'appareil garde l'assiette qu'il a, il ne la ramène pas à
// plat (c'est tout le sujet du protocole de tools/geofence-measure.mjs, voir
// son en-tête). Un « stationnaire tenu » n'a donc pas de dérive résiduelle
// mesurable au sens physique : à plat et sticks centrés elle est nulle au bruit
// flottant près, ce que le banc de simulation ne peut pas distinguer d'un vrai
// pilote qui recentre activement. Rien dans ce dépôt ne modélise le tremblement
// de main sur un vrai stick — cette grandeur-là n'est pas mesurable ici.
//
// Sur les seuils mesurés (R_HOLD 66, R_CAUTION 113), 15 % valait 26,85 m — cent
// fois l'ordre de grandeur invoqué, et un vrai défaut : `pushOf()`/`lossOf()`
// lisent la marge brute, seul `zone`/`warning` porte l'hystérésis, donc l'OSD
// pouvait afficher NO COVERAGE jusqu'à 5,4 s après un retour bien à l'intérieur
// (lossDb = 0, push = 0) — un avertissement sans rien derrière.
//
// HYST_M est donc CHOISI, pas mesuré — comme A_MAX ci-dessus, et pour la même
// raison : la grandeur qu'il couvre (jitter d'affichage / arrondi de
// simulation, pas dérive de vol) n'a pas de protocole de mesure qui ait un
// sens. 3 m est l'unité déjà en usage dans ce fichier pour « petite marge
// physique » (l'écart entre les seuils du couloir vertical, FLOOR_CAUTION à
// FLOOR_LOST, est de 2 à 3 m) : assez pour qu'un déplacement d'une frame ne
// fasse jamais osciller la zone, largement trop petit pour reproduire la
// fenêtre « avertissement sans rien derrière » du réglage précédent.
export const HYST_M = 3;

// Le budget que la clôture dépense, en dB. LOSS_DEAD − LOSS_CLEAN de link.js :
// c'est, par construction, ce qui emmène N'IMPORTE QUEL lien, si propre
// soit-il, de parfait à mort. Dupliqué plutôt qu'importé pour garder ce
// fichier sans dépendance ; tools/geofence-selftest.mjs vérifie l'égalité.
export const FENCE_SPAN = 58;
// Ce que la clôture dépense AVANT le bord, pendant l'avertissement. C'est
// KNIFE_EDGE_DB de link.js : le plus petit incident que le modèle juge
// significatif — assez pour se lire comme une dégradation, pas assez pour
// compter. C'est le principe déjà écrit dans link.js : « you are told you are
// running out of margin before you run out. »
export const FENCE_WARN_DB = 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// La marge horizontale : positive dedans, négative dehors, et dehors c'est la
// VRAIE distance euclidienne au bord — pas le min des deux axes, qui
// sous-estimerait la sortie par un coin.
export function horizontalMargin(p, bbox) {
	const dx = Math.max(bbox.min[0] - p.x, p.x - bbox.max[0]);
	const dz = Math.max(bbox.min[2] - p.z, p.z - bbox.max[2]);
	if (dx <= 0 && dz <= 0) return -Math.max(dx, dz);   // dedans
	return -Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

// La marge verticale se compte depuis le point le plus bas du maillage, pas
// depuis le plancher du couloir : c'est ce repère-là qui a un sens physique.
export function verticalMargin(p, bbox) {
	return p.y - bbox.min[1];
}

// Un couloir : quatre marges décroissantes vers le danger. `edge` est le bord
// des données, `lost` la fin de session.
function corridor(caution, hold, edge, lost) {
	return { caution, hold, edge, lost };
}

// Où l'on en est dans un couloir : 0 à l'entrée de `caution`, 1 à `lost`.
// Au-delà de 1 la valeur continue de croître — main.js s'en sert pour savoir
// de combien on a dépassé.
function progress(margin, c) {
	return (c.caution - margin) / (c.caution - c.lost);
}

function zoneOf(margin, c, previous) {
	// Hystérésis sur LES TROIS frontières, pas seulement les deux du dedans :
	// on peut aussi bien osciller autour du bord des données qu'autour de
	// l'entrée en avertissement. Un seuil est un peu plus haut pour SORTIR
	// d'une zone que pour y entrer — « plus haut » au sens de la marge, donc
	// il faut revenir un peu plus loin dans le sûr qu'on n'est allé dans le
	// danger.
	const w = (thr, current) => (previous === current ? thr + HYST_M : thr);
	if (margin < w(c.edge, LOST)) return LOST;
	if (margin <= w(c.hold, HOLD)) return HOLD;
	if (margin <= w(c.caution, CAUTION)) return CAUTION;
	return NOMINAL;
}

// La perte de la clôture, en dB, en fonction de l'avancement dans le couloir.
// Deux segments, et aucun des deux n'invente son nombre :
//   - de `caution` à `edge` : FENCE_WARN_DB, l'avertissement ;
//   - de `edge` à `lost`    : le reste du budget, soit la mort de l'image
//     exactement au mètre où la session s'arrête.
// La symétrie est voulue : la distance qu'il faut pour s'arrêter est
// exactement celle que l'image coûte.
function lossOf(margin, c) {
	if (margin >= c.caution) return 0;
	if (margin >= c.edge) {
		const u = (c.caution - margin) / (c.caution - c.edge);
		return FENCE_WARN_DB * u;
	}
	const u = clamp01((c.edge - margin) / (c.edge - c.lost));
	return FENCE_WARN_DB + (FENCE_SPAN - FENCE_WARN_DB) * u;
}

// L'amplitude du rappel : nulle à l'entrée en HOLD, pleine au bord, et
// constante au-delà. Continue en `hold`, donc pas d'à-coup à l'entrée.
function pushOf(margin, c) {
	if (margin >= c.hold) return 0;
	if (margin <= c.edge) return A_MAX;
	return A_MAX * (c.hold - margin) / (c.hold - c.edge);
}

const RANK = { [NOMINAL]: 0, [CAUTION]: 1, [HOLD]: 2, [LOST]: 3 };

export class Geofence {
	constructor(bbox) {
		this.bbox = bbox;
		// La borne (voir le bloc « Et la carte, dans tout ça » plus haut) : le
		// couloir horizontal ne dépasse jamais le tiers du plus petit demi-côté
		// de la carte. Un seul facteur pour les deux seuils, sinon la bande
		// d'avertissement — le seul rôle de R_CAUTION — se ferait écraser la
		// première.
		const halfMin = Math.min(
			(bbox.max[0] - bbox.min[0]) / 2,
			(bbox.max[2] - bbox.min[2]) / 2,
		);
		const scale = Math.min(1, halfMin / 3 / R_CAUTION);
		// Le couloir RÉELLEMENT appliqué, en mètres, à lire de l'extérieur :
		// l'OSD et le README doivent dire au joueur ce qui s'applique à SA
		// carte, pas ce que la constante vaut. `scale === 1` veut dire « la
		// carte est assez grande, c'est la valeur mesurée telle quelle ».
		//
		// Calculé UNE FOIS ici, comme this.h : si la scène change, on
		// reconstruit un Geofence, on ne mute pas la bbox sous celui-ci —
		// `update()` lit `this.bbox` en direct, donc une bbox mutée après coup
		// donnerait un couloir qui ne correspond plus à la carte. Gelé pour que
		// l'écrire de l'extérieur échoue franchement au lieu de rendre cette
		// propriété menteuse sans toucher au couloir réellement appliqué.
		this.effectiveCorridor = Object.freeze({
			caution: R_CAUTION * scale,
			hold: R_HOLD * scale,
			scale,
			halfMinM: halfMin,
		});
		const e = this.effectiveCorridor;
		this.h = corridor(e.caution, e.hold, 0, -e.hold);
		// Marges relatives à bbox.min.y, donc toutes négatives : le couloir est
		// entièrement sous le point le plus bas du maillage. PAS mis à
		// l'échelle : ces quatre seuils sont géométriques (« deux mètres sous
		// la surface la plus basse »), pas une distance d'arrêt — une petite
		// carte n'a pas un dessous plus mince qu'une grande.
		this.v = corridor(-FLOOR_CAUTION, -FLOOR_HOLD, -FLOOR_EDGE, -FLOOR_LOST);
		// Muté chaque frame plutôt que recréé, comme link.out et flightEnd.out :
		// ceci tourne à la fréquence d'affichage.
		this.out = {
			zone: NOMINAL, marginM: Infinity, t: 0,
			push: { x: 0, y: 0, z: 0 }, lossDb: 0, warning: '', over: false,
		};
		this.reset();
	}

	reset() {
		this._zoneH = NOMINAL;
		this._zoneV = NOMINAL;
		const o = this.out;
		o.zone = NOMINAL; o.marginM = Infinity; o.t = 0;
		o.push.x = 0; o.push.y = 0; o.push.z = 0;
		o.lossDb = 0; o.warning = ''; o.over = false;
	}

	update(p) {
		const b = this.bbox;
		const mH = horizontalMargin(p, b);
		const mV = verticalMargin(p, b);

		this._zoneH = zoneOf(mH, this.h, this._zoneH);
		this._zoneV = zoneOf(mV, this.v, this._zoneV);

		const o = this.out;
		o.zone = RANK[this._zoneV] > RANK[this._zoneH] ? this._zoneV : this._zoneH;
		o.marginM = Math.min(mH, mV - this.v.edge);
		o.t = Math.max(progress(mH, this.h), progress(mV, this.v));
		o.lossDb = Math.max(lossOf(mH, this.h), lossOf(mV, this.v));
		o.warning = o.zone === NOMINAL ? '' : 'NO COVERAGE';
		o.over = mH < this.h.lost || mV < this.v.lost;

		// Les deux poussées sont orthogonales : on les somme sans arbitrer.
		// L'horizontale pointe vers l'intérieur le long de la normale de la
		// face la plus proche ; la verticale est toujours vers le haut.
		const aH = pushOf(mH, this.h);
		if (aH > 0) {
			const n = this._inwardNormal(p);
			o.push.x = n.x * aH;
			o.push.z = n.z * aH;
		} else {
			o.push.x = 0; o.push.z = 0;
		}
		o.push.y = pushOf(mV, this.v);
		return o;
	}

	// La normale rentrante, en X/Z. Dedans, c'est celle de la face la plus
	// proche ; dehors, c'est la direction du point le plus proche de la boîte,
	// ce qui recolle proprement dans les coins.
	_inwardNormal(p) {
		const b = this.bbox;
		const cx = Math.min(Math.max(p.x, b.min[0]), b.max[0]);
		const cz = Math.min(Math.max(p.z, b.min[2]), b.max[2]);
		if (cx !== p.x || cz !== p.z) {
			const dx = cx - p.x, dz = cz - p.z;
			const len = Math.hypot(dx, dz) || 1;
			return { x: dx / len, z: dz / len };
		}
		// Dedans : la face la plus proche, une seule composante.
		const d = [
			[p.x - b.min[0], 1, 0], [b.max[0] - p.x, -1, 0],
			[p.z - b.min[2], 0, 1], [b.max[2] - p.z, 0, -1],
		];
		d.sort((a, c) => a[0] - c[0]);
		return { x: d[0][1], z: d[0][2] };
	}
}
