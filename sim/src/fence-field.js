// Le champ partagé des deux clôtures (#107) : ce qu'on voit quand on approche
// du bord du monde, que ce bord soit la bbox d'une carte pré-cuite
// (geofence-dome.js) ou le rayon de la fenêtre de streaming (fence-dome.js).
//
// Les deux posaient jusqu'ici le même `pow(sin(axe · k), 3)` en espace objet.
// Deux défauts, et le second est le vrai :
//
//   - des rayures régulières, qui sous-échantillonnent au loin (moiré) ;
//   - aucune atténuation selon l'angle de vue, donc une clôture aussi dense
//     regardée de face que longée en rasant.
//
// Or on la voit EN PERMANENCE. Une chose vue en permanence n'a pas le droit
// de s'imposer : elle doit être presque absente tant qu'elle n'a rien à dire,
// et se densifier quand elle en a. D'où les trois règles tenues ici :
//
//   1. Pas de période perceptible. Le motif est un fbm à domaine déformé, et
//      les dérives des octaves sont à des vitesses non commensurables — rien
//      à mémoriser, donc rien dont se lasser.
//   2. Mouvement lent. La masse roule à l'échelle de la dizaine de secondes.
//      Ce qui est rapide est soit rare (l'anneau de ping), soit fin (les
//      veines qui rampent dans la masse).
//   3. Discrétion par défaut. Le Fresnel efface la clôture regardée de face ;
//      opacityFor() la lève en approchant ; hueBiasFor() fait glisser sa
//      dominante du cyan vers le magenta. La couleur DIT la proximité.
//
// Le GLSL est une chaîne partagée plutôt que deux copies : les deux clôtures
// partageaient déjà opacityFor()/CYAN, un seul endroit à retoucher reste la
// règle. Chaque clôture ne garde que sa paramétrisation de surface — sphère
// (azimut, élévation) ou boîte (périmètre, altitude) — et sa normale.

// La paire de la culmination (docs/marque.md : « le cyan et le magenta
// appartiennent à l'écran »), reprise telle quelle depuis palette.js /
// tokens.css. fence-dome.js re-exporte CYAN pour ne pas casser ses
// importateurs.
export const CYAN = 0x4dd8e8;
export const MAGENTA = 0xe34de0;

// --- Bichromie -------------------------------------------------------------

// Le magenta ne prend jamais toute la place : au bord la masse est à
// dominante magenta, mais le cyan subsiste dans les creux du champ. Une
// clôture qui virerait au magenta pur cesserait d'appartenir à la même
// famille que le reste de l'écran. CHOISI.
export const HUE_BIAS_CEIL = 0.70;

// Quadratique, pas linéaire : un biais linéaire serait déjà à mi-course au
// milieu de la carte et ne signalerait plus rien. Là, la dominante reste
// franchement cyan sur la moitié intérieure et bascule sur la fin.
export function hueBiasFor(distanceRatio) {
	const r = Math.min(1, Math.max(0, distanceRatio));
	return HUE_BIAS_CEIL * r * r;
}

// --- Cadence du ping -------------------------------------------------------

// Le « ping » : un anneau qui part du point de la clôture le plus proche du
// drone et s'y propage. C'est là toute la part réactive — le mur RÉPOND au
// pilote au lieu de jouer une animation en boucle.
//
// Sous ce ratio, silence complet : au centre de la carte la clôture n'a rien
// à dire, et un anneau qui partirait quand même finirait par lasser. CHOISI,
// même statut que OPACITY_FLOOR/CEIL dans ce coin du code.
export const PING_SILENCE_RATIO = 0.35;
export const PING_INTERVAL_FAR_S = 3.0;
export const PING_INTERVAL_NEAR_S = 0.9;

// Infinity = ne pinge pas du tout. L'intervalle se resserre linéairement de
// la sortie du silence jusqu'au bord réel.
export function pingIntervalFor(distanceRatio) {
	const r = Math.min(1, Math.max(0, distanceRatio));
	if (r <= PING_SILENCE_RATIO) return Infinity;
	const k = (r - PING_SILENCE_RATIO) / (1 - PING_SILENCE_RATIO);
	return PING_INTERVAL_FAR_S + (PING_INTERVAL_NEAR_S - PING_INTERVAL_FAR_S) * k;
}

// Horloge du ping, séparée des clôtures pour rester testable en Node.
export class PingClock {
	constructor() {
		// Armée au départ : l'ENTRÉE dans la zone active est l'information
		// « tu approches », elle ne peut pas attendre PING_INTERVAL_FAR_S.
		this._armed = true;
		this._timer = 0;
	}

	// Renvoie true sur la frame où un anneau doit partir.
	advance(dt, distanceRatio) {
		const interval = pingIntervalFor(distanceRatio);
		if (!Number.isFinite(interval)) {
			// Retour au calme : réarme, pour que le prochain retour au bord
			// reping immédiatement.
			this._armed = true;
			this._timer = 0;
			return false;
		}
		if (this._armed) {
			this._armed = false;
			this._timer = 0;
			return true;
		}
		this._timer += dt;
		if (this._timer >= interval) {
			// Remise à zéro, pas soustraction : un dt énorme (onglet revenu
			// d'arrière-plan) ne doit pas déclencher une rafale de rattrapage.
			this._timer = 0;
			return true;
		}
		return false;
	}
}

// --- Projections de surface ------------------------------------------------
//
// Les deux clôtures parlent la même langue au shader : une coordonnée de
// surface en MÈTRES, `u` le long du bord (périodique, de période `perimeter`)
// et `v` vertical. C'est ce qui permet au même GLSL de servir une boîte et
// une sphère, et à l'anneau de se propager sans se casser au passage d'un
// coin.

// Point de la muraille le plus proche du drone, en coordonnée de surface.
// `u` parcourt le périmètre dans l'ordre nord (z=min) → est → sud → ouest, en
// partant du coin (minX, minZ) : continu d'une face à l'autre, y compris en
// tournant un coin.
export function nearestOnBoxSurface(dronePosLocal, bbox) {
	const [minX, , minZ] = bbox.min;
	const [maxX, , maxZ] = bbox.max;
	const width = maxX - minX;
	const depth = maxZ - minZ;
	const x = dronePosLocal.x, z = dronePosLocal.z;

	// Distance à chacune des quatre faces ; la plus proche gagne.
	const dNorth = Math.abs(z - minZ);
	const dEast = Math.abs(x - maxX);
	const dSouth = Math.abs(z - maxZ);
	const dWest = Math.abs(x - minX);
	const nearest = Math.min(dNorth, dEast, dSouth, dWest);

	let u;
	if (nearest === dNorth) u = x - minX;
	else if (nearest === dEast) u = width + (z - minZ);
	else if (nearest === dSouth) u = width + depth + (maxX - x);
	else u = 2 * width + depth + (maxZ - z);

	const perimeter = 2 * (width + depth);
	// Le drone peut être hors bbox (rappel physique déjà engagé) : u sort
	// alors de [0, perimeter) et doit être ramené dans le tour.
	if (perimeter > 0) u = ((u % perimeter) + perimeter) % perimeter;
	else u = 0;

	return { u, v: dronePosLocal.y, perimeter };
}

// Même chose sur la sphère du dôme live : `u` est l'arc d'azimut, `v` l'arc
// d'élévation, tous deux en mètres au rayon du dôme. La circonférence
// rétrécit vers les pôles, donc le motif s'y étire — compromis assumé de
// toute paramétrisation équirectangulaire, et ce dôme se regarde de côté.
export function nearestOnSphereSurface(dronePosLocal, centerXZ, radius, centerY = 0) {
	const dx = dronePosLocal.x - centerXZ.x;
	const dy = dronePosLocal.y - centerY;
	const dz = dronePosLocal.z - centerXZ.z;
	const perimeter = 2 * Math.PI * radius;
	const len = Math.hypot(dx, dy, dz);
	// Drone pile au centre : aucune direction à en tirer, on renvoie l'origine
	// de la surface plutôt que des NaN.
	if (!(len > 0)) return { u: 0, v: 0, perimeter };

	const azimuth = Math.atan2(dz, dx);
	const elevation = Math.asin(Math.min(1, Math.max(-1, dy / len)));
	const u = (((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * radius;
	return { u, v: elevation * radius, perimeter };
}

// --- Le champ lui-même -----------------------------------------------------
//
// Inséré tel quel dans le fragment shader des deux clôtures, qui n'ont plus
// qu'à remplir un FenceIn et à jeter les fragments sous le seuil.
//
// Périodicité : le bruit est échantillonné sur une grille dont le tour fait
// un nombre ENTIER de cellules, et le hash replie l'index sur ce nombre. Sans
// ça, `u` recollé à lui-même laisserait une couture verticale au point de
// départ du périmètre. Le domain warp partage la même période, donc la
// composition reste exactement périodique.
export const FENCE_FIELD_GLSL = /* glsl */`
	// Taille de la masse, en mètres. Un paquet de quelques dizaines de mètres
	// se lit à la fois de près en longeant le bord et de loin en vol. CHOISI.
	const float FENCE_FEATURE_M = 50.0;
	// Amplitude du domain warp, en cellules : c'est lui qui transforme un fbm
	// (nuageux, isotrope) en masse qui roule et s'étire.
	const float FENCE_WARP = 0.85;
	// Les veines : les LIGNES DE NIVEAU du champ, pas des bandes horizontales.
	//
	// C'est le point qui a demandé une deuxième passe. Une structure alignée
	// sur l'horizontale se projette en ÉVENTAIL depuis le point de fuite dès
	// qu'on longe le mur — ce sont exactement les « rayons » qu'on est venu
	// supprimer, et les remettre plus fins ne faisait que les rendre plus
	// nombreux. Les lignes de niveau, elles, n'ont aucune direction
	// privilégiée : elles rampent avec la masse et ne peuvent pas converger.
	const float FENCE_VEIN_BANDS = 3.0;
	const float FENCE_VEIN_SPEED = 0.05;
	// Largeur de référence de la veine, en unités de champ. Sert aussi de
	// seuil d'atténuation : au-delà, la veine se dissout au lieu de saturer.
	const float FENCE_VEIN_W = 0.09;
	// Regardée de face la clôture s'efface, longée en rasant elle se densifie.
	// Le plancher l'empêche de disparaître complètement : elle reste un
	// avertissement, pas une surprise.
	const float FENCE_FRESNEL_POW = 2.5;
	const float FENCE_FRESNEL_FLOOR = 0.22;
	// L'anneau de ping : vitesse, largeur et durée de vie.
	const float FENCE_RING_SPEED = 45.0;
	const float FENCE_RING_WIDTH = 18.0;
	const float FENCE_RING_LIFE = 2.2;
	// Écart de teinte porté par le champ autour du biais : les deux couleurs
	// se poursuivent dans la masse au lieu d'être posées en zones.
	const float FENCE_HUE_SPREAD = 0.6;
	// La clôture est une BANDE à hauteur d'œil, pas un panneau de 4000 m.
	//
	// Le mur monte si haut pour qu'aucun angle de vue n'en trouve le bord ; le
	// rendre également dense sur toute cette hauteur en faisait un aplat qui
	// remplit l'écran. Une gaussienne centrée sur l'altitude du pilote le
	// dissout vers le haut et vers le bas : ce qui reste est une masse qui
	// suit le vol. Le plancher empêche la dissolution d'être totale — au-delà
	// de la bande la limite doit rester devinable, pas disparaître.
	const float FENCE_BAND_M = 400.0;
	const float FENCE_BAND_FLOOR = 0.30;
	// edgeFade : le plancher de bande garde la clôture devinable très loin de
	// la hauteur d'œil, et ce plancher rendait le SOMMET du mur visible comme
	// une arête franche quand on levait les yeux vers la clôture d'en face.
	// Une surface dont on peut voir le bord cesse d'être une limite du monde.
	// La clôture s'éteint donc complètement avant d'atteindre sa propre
	// géométrie ; une sphère, qui n'a pas de bord, passe simplement 1.0.

	struct FenceIn {
		vec2 surf;        // coordonnée de surface en mètres (u le long du bord, v vertical)
		vec3 normal;      // normale de surface, espace monde
		vec3 view;        // fragment -> caméra, espace monde
		vec3 cyan;        // dominante loin du bord
		vec3 magenta;     // dominante au bord
		float time;       // secondes accumulées
		float opacity;    // opacityFor(ratio)
		float hueBias;    // hueBiasFor(ratio)
		vec2 impact;      // coordonnée de surface du dernier ping
		float impactAge;  // secondes depuis ce ping
		float eyeV;       // v du pilote sur la surface : le centre de la bande
		float edgeFade;   // 0 au bord géométrique de la clôture, 1 ailleurs
		float wrap;       // période de u, en mètres (0 = pas de repli)
		float extra;      // bruit additionnel 0..1 (glitch de churn en ?live=)
	};

	// Hash replié sur \`cells\` en x : c'est ce repli qui rend le bruit
	// exactement périodique le long du périmètre.
	float fenceHash21(vec2 i, float cells) {
		if (cells > 0.0) i.x = mod(i.x, cells);
		vec2 p = fract(i * vec2(123.34, 456.21));
		p += dot(p, p + 45.32);
		return fract(p.x * p.y);
	}

	float fenceNoise(vec2 p, float cells) {
		vec2 i = floor(p), f = fract(p);
		vec2 u = f * f * (3.0 - 2.0 * f);
		float a = fenceHash21(i, cells);
		float b = fenceHash21(i + vec2(1.0, 0.0), cells);
		float c = fenceHash21(i + vec2(0.0, 1.0), cells);
		float d = fenceHash21(i + vec2(1.0, 1.0), cells);
		return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
	}

	// Trois octaves, lacunarité 2 : la période reste entière à chaque octave,
	// donc le repli tient. La variété ne vient pas d'une lacunarité exotique
	// mais des dérives temporelles, non commensurables entre elles.
	float fenceFbm(vec2 p, float cells, float t) {
		float sum = 0.0, amp = 0.5, c = cells;
		vec2 drift = vec2(0.0137, 0.0091);
		for (int k = 0; k < 3; k++) {
			sum += amp * fenceNoise(p + drift * t, c);
			p *= 2.0;
			c *= 2.0;
			amp *= 0.5;
			// Chaque octave dérive plus vite ET dans une autre direction, à un
			// rapport irrationnel : les octaves ne se réalignent jamais.
			drift = vec2(-drift.y * 1.6180339, drift.x * 1.3247180);
		}
		return sum / 0.875;
	}

	// Domain warp : deux champs lents qui déplacent l'échantillonnage. Même
	// \`cells\` que le champ warpé, sinon la couture revient.
	vec2 fenceWarp(vec2 p, float cells, float t) {
		float a = fenceFbm(p + vec2(11.7, 3.1), cells, t);
		float b = fenceFbm(p + vec2(29.3, 47.9), cells, -t * 0.77);
		return (vec2(a, b) - 0.5) * FENCE_WARP;
	}

	vec4 fenceField(FenceIn f) {
		// Grille recalée pour que le tour fasse un nombre entier de cellules ;
		// hors périmètre connu (wrap = 0) on tombe sur l'échelle nominale.
		float cells = 0.0;
		vec2 p;
		if (f.wrap > 0.0) {
			cells = max(1.0, floor(f.wrap / FENCE_FEATURE_M + 0.5));
			p = vec2(f.surf.x / f.wrap * cells, f.surf.y / FENCE_FEATURE_M);
		} else {
			p = f.surf / FENCE_FEATURE_M;
		}

		float field = fenceFbm(p + fenceWarp(p, cells, f.time), cells, f.time);
		// Des paquets, pas un voile uniforme : c'est le seuillage doux qui fait
		// lire la chose comme une masse et non comme du bruit.
		float mass = smoothstep(0.30, 0.78, field);

		// Veines : les lignes de niveau du champ, donc une structure qui suit la
		// masse au lieu de lui être superposée.
		//
		// Le facteur d'atténuation final n'est pas un détail : un smoothstep
		// dont la rampe s'élargit ne FOND pas, il SATURE — plus le fragment
		// couvre de bandes, plus (1 - smoothstep) remonte, et la surface finit
		// en voile brillant. On rend donc explicitement la veine à sa moyenne
		// (≈ son rapport cyclique) dès que le pixel couvre plus large qu'elle.
		float veinCoord = field * FENCE_VEIN_BANDS - f.time * FENCE_VEIN_SPEED;
		float tri = abs(fract(veinCoord) - 0.5) * 2.0;
		float aa = fwidth(veinCoord) * 2.0 + 0.02;
		float vein = (1.0 - smoothstep(FENCE_VEIN_W, FENCE_VEIN_W + aa, tri))
			* (FENCE_VEIN_W / (FENCE_VEIN_W + aa));

		// Anneau de ping, dans la métrique de surface — la distance se replie
		// sur le périmètre, donc l'anneau passe les coins sans se casser.
		float du = abs(f.surf.x - f.impact.x);
		if (f.wrap > 0.0) du = min(du, f.wrap - du);
		float dist = length(vec2(du, f.surf.y - f.impact.y));
		float front = f.impactAge * FENCE_RING_SPEED;
		float life = clamp(1.0 - f.impactAge / FENCE_RING_LIFE, 0.0, 1.0);
		float ring = exp(-pow((dist - front) / FENCE_RING_WIDTH, 2.0)) * life * life;

		// La bande : dense à hauteur d'œil, dissoute loin au-dessus et en dessous.
		float bandT = (f.surf.y - f.eyeV) / FENCE_BAND_M;
		float band = FENCE_BAND_FLOOR + (1.0 - FENCE_BAND_FLOOR) * exp(-bandT * bandT);

		float facing = abs(dot(normalize(f.normal), normalize(f.view)));
		float fresnel = FENCE_FRESNEL_FLOOR
			+ (1.0 - FENCE_FRESNEL_FLOOR) * pow(1.0 - facing, FENCE_FRESNEL_POW);

		float pattern = clamp(mass * 0.7 + vein * 0.5 + f.extra * 0.8, 0.0, 1.0);
		// Plancher de motif bas : ce qu'on doit lire est la MASSE, pas un voile
		// uniforme sous elle. Un plancher haut remplissait l'écran d'un lavande
		// plat dès que le mur occupait le champ de vision.
		float alpha = f.opacity * fresnel * band * f.edgeFade * (0.20 + 0.80 * pattern);
		// L'anneau MULTIPLIE au lieu de s'ajouter au motif. Additionné, il
		// disparaissait : le motif sature déjà à 1 dans la masse, et l'anneau
		// n'y ajoutait rien — il ne se voyait que dans les creux, c'est-à-dire
		// nulle part où l'œil regarde. En facteur, il traverse la masse.
		alpha = min(1.0, alpha * (1.0 + ring * 1.8));

		// Le champ fait courir les deux teintes l'une dans l'autre ; le biais
		// déplace le point d'équilibre, l'anneau tire vers le magenta sur son
		// passage — le ping se lit comme une couleur, pas comme un flash.
		float hue = clamp(f.hueBias + (field - 0.5) * FENCE_HUE_SPREAD + ring * 0.6, 0.0, 1.0);
		return vec4(mix(f.cyan, f.magenta, hue), alpha);
	}
`;

// Sous ce seuil d'alpha la clôture ne contribue plus rien de visible : les
// deux shaders jettent le fragment plutôt que de payer le blend. Le Fresnel
// met une bonne part de l'écran sous ce seuil en vol normal.
export const FENCE_DISCARD_ALPHA = 0.004;
