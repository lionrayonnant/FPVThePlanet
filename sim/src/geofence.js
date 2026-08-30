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

// Mesurés par tools/geofence-measure.mjs sur public/scenes/tour-eiffel le
// 2026-08-30, sur les 6 familles de drone-profiles.js.
//
// Le protocole est EN ACRO, le mode du jeu (FlightController démarre en
// `acro`, entry-state.js:241 le force). Ça change tout : en ACRO des manches
// centrées ne remettent pas à plat, elles TIENNENT l'assiette. Mesuré, manches
// centrés et gaz au stationnaire : l'assiette reste à 42° et cinq familles sur
// six franchissent la face sous un couloir de 29 m — jusqu'à +44,6 m (heavy5)
// dans les dix secondes qui suivent l'entrée en HOLD. « Lâcher les manches »
// n'est donc pas une façon d'obéir ici, et « obéir » doit être un programme de
// manche explicite. Le voici, en entier — c'est lui, la définition :
//
//   approche : plein gaz, et le pilote pique jusqu'à 42° (ANGLE_MAX_TILT,
//     l'assiette la plus inclinée que l'auto-stabilisation du dépôt tienne)
//     et tient cette assiette jusqu'au couloir ;
//   freinage, dès l'entrée en HOLD : gaz ramenés quelque part entre zéro et
//     le stationnaire — bande BALAYÉE de 0 à hoverThrottle(), pire cas
//     retenu, parce que le manche des gaz d'un pilote qui freine n'est pas
//     connaissable ; et tangage TIRÉ pour ramener l'appareil à plat, puis
//     CENTRÉ dès l'horizon revenu et plus jamais touché. À partir de là
//     l'ACRO tient l'assiette : rien ne le remet à plat à sa place, et le
//     résidu qu'il a laissé, il le garde.
//
// Ensuite, seuls A_MAX et la traînée de quad.js décélèrent. Manches ramenés
// au calme et non tirés à fond, délibérément : un pilote qui insiste DOIT
// pouvoir passer, c'est la moitié du design. R_HOLD dimensionne le cas où on
// obéit, pas le cas où on désobéit.
//
// Ce n'est pas une soustraction mais un POINT FIXE : la rampe du rappel (0 à
// A_MAX sur R_HOLD mètres, pushOf() plus bas) dépend elle-même de R_HOLD, donc
// rétrécir le couloir durcit la rampe et change la distance qu'on mesure avec.
// Trouvé par itération directe, convergence en 3 à 5 pas, indépendante du
// point de départ : 65,82 / 65,83 / 65,84 / 65,87 / 65,93 m depuis des départs
// de 5, 10, 20, 40 et 66 m (`--start`). Insensible au modèle de pilotage, lui
// aussi : sur la grille (taux de ralliement /2, x1, x2) x (seuil « à plat »
// 0,25°, 1°, 4°) le point fixe tient dans 63,40 - 65,98 m, sous 66 dans les
// neuf cas.
//
// Pire famille : heavy5, 65,83 m, arrondie au mètre supérieur. Pire non parce
// qu'elle est la plus lourde — elle ne l'est pas, longrange fait 0,92 kg
// contre 0,85 — mais parce qu'elle a la plus faible traînée de carène par
// unité de masse des six (bodyDrag.z/masse = 0,0129, contre 0,0164 pour race5
// et 0,0500 pour cinewhoop) tout en approchant à 27,76 m/s. Les six valeurs
// vont de 19,19 m (toothpick) à 65,83 m (heavy5).
//
// La marge de sécurité visée par ce point fixe (12 m) est mesurée elle aussi :
// c'est la dispersion du point d'arrêt sur le balayage des gaz de freinage
// (11,08 m au point fixe), arrondie au mètre supérieur — l'écart que produit à
// elle seule la seule hypothèse de pilotage qu'on ne sait pas trancher. Le
// banc la re-mesure et refuse de livrer un chiffre si elle la dépasse.
export const R_HOLD = 66;      // m : distance d'arrêt du pilote qui obéit
// R_HOLD + le temps de lire l'avertissement à la vitesse maximale mesurée
// (30,87 m/s, race5, plein gaz à 42°). Ce délai est de la mise en scène et
// s'assume comme telle, mais il s'ancre sur une constante du dépôt : un
// avertissement doit clignoter trois fois pour être lu, et BLINK_PERIOD_MS
// vaut 500 ms (drone-osd.js:51). Soit 1,5 s, et la bande de 47 m ci-dessous
// en vaut 1,52 à cette vitesse-là.
export const R_CAUTION = 113;  // m : R_HOLD + 1,5 s à la vitesse maximale

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

// Hystérésis sur les frontières de zone, en fraction de la marge du seuil.
// Sans elle, un stationnaire tenu pile sur R_CAUTION fait strober
// l'avertissement de l'OSD. link.js a exactement ce problème et exactement
// cette réponse (FREEZE_ENTER / FREEZE_LEAVE, et son commentaire : « at a
// single threshold the picture strobes between frozen and clean while you
// hover on the boundary »).
//
// 15 % est posé et n'a pas besoin d'être mieux : il suffit que l'écart dépasse
// la dérive d'un stationnaire tenu, qui se compte en dizaines de centimètres
// quand R_CAUTION se compte en dizaines de mètres. Il n'y a pas deux ordres de
// grandeur à arbitrer.
export const HYST = 0.15;

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
	const span = Math.abs(c.caution - c.lost) * HYST;
	const w = (thr, current) => (previous === current ? thr + span : thr);
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
		this.h = corridor(R_CAUTION, R_HOLD, 0, -R_HOLD);
		// Marges relatives à bbox.min.y, donc toutes négatives : le couloir est
		// entièrement sous le point le plus bas du maillage.
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
