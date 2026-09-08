// Politique de la fenêtre de streaming rocktree (#168) : quels nœuds charger
// ou décharger selon la position de vol. Ne touche NI Three NI Rapier — ça,
// c'est le problème de l'appelant (main.js, Tâche 9), via onNodeReady()/
// onNodeReleased(). Même frontière que fetchNode() dans la tranche
// précédente : testable seule, remplaçable seule.
import { zoneOf } from '../tools/lib/rocktree/traverse.mjs';
import { ringsFor, assembleLod, metersBetween, boxIntersectsDisc } from '../tools/lib/rocktree/lod.mjs';
// La traversée par défaut tourne dans un Worker (#187) : le parse des bulks
// produisait ~10 longtasks de 59-72 ms par recalcul sur le fil principal.
// Les tests injectent toujours leur _traverse — l'import du client est sans
// effet en Node (Worker créé paresseusement au premier appel réel).
import { traverseInWorker } from './rocktree-traverse-client.js';
import { fetchNode as realFetchNode } from './rocktree-loader.js';
import { WORST_MEASURED_SPEED_MS } from './geofence.js';
import { geodeticToEcef, enuBasis, ecefToLocalEnu } from '../tools/lib/rocktree/geodesy.mjs';

// Recalcule la fenêtre après ce déplacement. CHOISI, pas mesuré — un ordre de
// grandeur raisonnable pour ce premier jalon, à affiner une fois qu'on
// observe le comportement réel en vol (comme RAMP_M dans rocktree-fence.js).
export const REFRESH_THRESHOLD_M = 50;

// Rayon de repli avant toute mesure de latence réelle — CHOISI, la première
// fenêtre doit bien démarrer avec quelque chose. Sert AUSSI de plancher une
// fois la latence mesurée (voir _loadRadiusM, #180).
export const FALLBACK_RADIUS_M = 200;

// Marge de sécurité entre le rayon de CHARGEMENT (la zone qu'on fetch) et le
// rayon de CONFIANCE que nearestTrustedRadius() rend à l'appelant : à
// l'intérieur de ce dernier, on garantit que du terrain est là. CHOISI, pas
// mesuré — même statut que RAMP_M dans rocktree-fence.js et HYST_M dans
// geofence.js, et pour la même raison : la marge la plus sûre dépend de ce que
// le vol réel produit au bord de la fenêtre (dépassement, nœuds 404, fetchs
// encore en vol), qu'on n'a pas encore observé. Même ordre de grandeur que
// RAMP_M par cohérence de style. À revoir une fois qu'on observe le
// comportement réel en vol.
export const TRUST_MARGIN_M = 20;

// Nombre d'échantillons de latence gardés pour le p95 glissant.
const LATENCY_SAMPLES = 20;

// Politique de retry des fetchs de nœud échoués (#186) : sans elle, un échec
// (étranglement réseau transitoire sur la rafale de boot — observé une fois,
// vague figée à 331 meshes sans erreur — ou 5xx passager) était simplement
// oublié : le nœud restait un trou dans le terrain jusqu'au PROCHAIN recalcul
// de fenêtre, donc jusqu'à REFRESH_THRESHOLD_M (50 m) de vol. On retente donc
// À L'INTÉRIEUR de la fenêtre courante, pas en attendant le prochain update().
//
// RETRY_DELAY_MS/RETRY_BACKOFF_FACTOR : CHOISI, pas mesuré — le plan #172
// n'a qu'une observation ponctuelle de l'incident, pas de distribution de
// pannes réseau à mesurer. 300 ms est du même ordre que les latences de fetch
// réel observées ailleurs dans ce fichier (_loadRadiusM : 60-150 ms en vol,
// #180) — assez pour laisser passer un étranglement transitoire sans
// l'aggraver, assez court pour ne pas laisser un trou visible pendant des
// secondes. Le facteur ×2 est le backoff exponentiel standard : un nœud
// injoignable retente de moins en moins souvent plutôt que de marteler le
// réseau au même rythme à chaque essai.
export const RETRY_DELAY_MS = 300;
export const RETRY_BACKOFF_FACTOR = 2;

// RETRY_MAX_ATTEMPTS : CHOISI. 3 tentatives (1 initiale + 2 retries, donc
// jusqu'à 300 + 600 = 900 ms de patience) couvrent l'ordre de grandeur d'un
// étranglement transitoire de boot. Au-delà, un nœud vraiment injoignable ne
// doit pas retenter indéfiniment ni brûler des workers du pool (#179) pour
// rien : le prochain recalcul de fenêtre (REFRESH_THRESHOLD_M) le retentera
// de toute façon tant qu'il reste désiré — la boucle de secours existante,
// pas supprimée par ce ticket.
export const RETRY_MAX_ATTEMPTS = 3;

// metersBetween/boxIntersectsDisc vivent dans lod.mjs (#22) : l'assemblage
// des anneaux en a besoin sans dépendre de ce module. Ré-exportés pour les
// selftests, qui les lisaient ici.
export { boxIntersectsDisc };

// Deux listes d'octants exclus décrivent-elles le même maillage ? traverse()
// et assembleLod() les rendent triées, mais un nœud sans exclude du tout
// (traversée injectée par un test, nœud sans box) doit valoir la liste vide.
function sameExclude(a = [], b = []) {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((d, i) => d === b[i]);
}

function p95(samples) {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

export class RocktreeWindow {
	constructor({ level, origin, floorRadiusM = FALLBACK_RADIUS_M, onNodeReady, onNodeReleased, _traverse = traverseInWorker, _fetchNode = realFetchNode }) {
		this._level = level;
		this._origin = origin;
		// Plancher du rayon (mètres) : la valeur du curseur Settings (#182).
		// Passé au constructeur pour que le BOOT charge déjà au rayon choisi —
		// démarrer au repli puis élargir une frame plus tard fetcherait le boot
		// en deux vagues pour rien.
		this._floorRadiusM = floorRadiusM;
		this._originEcef = geodeticToEcef(origin.lat, origin.lon, 0);
		this._originBasis = enuBasis(origin.lat, origin.lon);
		this._onNodeReady = onNodeReady;
		this._onNodeReleased = onNodeReleased;
		this._traverse = _traverse;
		this._fetchNode = _fetchNode;
		this._nodes = new Map();   // path -> { status: 'pending'|'ready', controller }
		this._lastPos = null;
		// Latences de fetch en SECONDES (jamais en ms) : elles sont multipliées
		// par WORST_MEASURED_SPEED_MS, qui est en m/s. performance.now() rend des
		// millisecondes, la conversion se fait donc dès la capture, une seule
		// fois, pour qu'aucun lecteur de _latencies n'ait à se poser la question.
		this._latencies = [];
		// La sphère rocktree (PlanetoidMetadata) : lue une fois par le premier
		// traverse() réussi, jamais recalculée ensuite — elle ne change pas en
		// cours de vol. `radius`, ici, veut TOUJOURS dire cette sphère ; le
		// rayon de CHARGEMENT (mètres autour du drone) est nommé `loadRadiusM`
		// partout dans cette classe pour ne jamais confondre les deux — même
		// unité, sens totalement différent.
		this._sphereRadius = null;
		this.windowCenterLocal = null;
		// Exposées (pas seulement _originEcef/_originBasis) : main.js
		// (Tâche 10) en a besoin pour buildNodeMesh(), et les recalculer là-bas
		// depuis les mêmes lat/lon donnerait le même résultat au prix d'un appel
		// dupliqué — autant réutiliser celui déjà fait ici.
		this.originEcef = this._originEcef;
		this.originBasis = this._originBasis;
	}

	// Rayon de CHARGEMENT : la zone qu'update() fetch autour du drone, en
	// mètres. Même principe que R_CAUTION = R_HOLD + délai × vitesse dans
	// geofence.js — un terme fixe PLUS ce que le drone peut parcourir pendant
	// qu'on attend le réseau. Le terme fixe est REFRESH_THRESHOLD_M : la fenêtre
	// n'est recalculée qu'après ce déplacement, donc sans lui, à faible latence,
	// la zone chargée serait plus petite que la distance parcourue avant le
	// PROCHAIN recalcul — le drone sortirait du terrain chargé sans que rien ne
	// se déclenche. p95 est en SECONDES (voir _latencies dans le constructeur).
	_loadRadiusM() {
		const latencySeconds = p95(this._latencies);
		if (latencySeconds == null) return this._floorRadiusM;   // aucune mesure encore
		// Plancher : la formule latence×vitesse garantit la COLLISION, mais ce
		// rayon est aussi toute la portée VISUELLE de la fenêtre (le LOD par
		// anneaux, #22, ne change que le niveau, pas la portée). Mesuré
		// en vol (#180) : à faible latence elle tombait à 60-150 m — la fenêtre
		// passait de 1032 meshes au boot à ~340 au premier recalcul, l'horizon
		// reculait en volant. Le plancher rend la portée du boot permanente ; sa
		// valeur vient du curseur Settings (#182), FALLBACK_RADIUS_M n'étant que
		// le défaut sans curseur.
		return Math.max(this._floorRadiusM, REFRESH_THRESHOLD_M + latencySeconds * WORST_MEASURED_SPEED_MS);
	}

	// Le curseur Settings (#182) en vol. Invalide le cache de position : sans
	// ça, update() early-return tant que le drone n'a pas bougé de
	// REFRESH_THRESHOLD_M et le curseur semble mort — la couronne
	// ancien→nouveau rayon n'est jamais fetchée (ni l'excédent libéré).
	setFloorRadiusM(m) {
		if (m === this._floorRadiusM) return;
		this._floorRadiusM = m;
		this._lastPos = null;
	}

	// Nombre de fetchs encore en vol (#189) : ce que bootLive() attend
	// derrière l'écran de chargement avant de lâcher le drone — décoller
	// au-dessus d'un monde à trous, c'est atterrir dedans (passage sous la
	// carte mesuré à Lyon, churn de fenêtre infini ensuite).
	pendingCount() {
		let count = 0;
		for (const entry of this._nodes.values()) if (entry.status === 'pending') count++;
		return count;
	}

	// Rayon de CONFIANCE, distinct du rayon de chargement ci-dessus : « radius
	// moins une marge de sécurité » (la spec). C'est ce que l'appelant compare à
	// distance(drone, windowCenterLocal) pour le rappel doux — donc il doit
	// rester STRICTEMENT à l'intérieur de ce qui est réellement chargé.
	nearestTrustedRadius() {
		return Math.max(0, this._loadRadiusM() - TRUST_MARGIN_M);
	}

	// Rayon de CHARGEMENT exposé publiquement : le dôme numérique (fence-dome.js)
	// en a besoin pour sa propre échelle — reconstruire nearestTrustedRadius() +
	// TRUST_MARGIN_M serait fragile (silencieusement faux si le clamp à 0 de
	// nearestTrustedRadius() joue jamais). Ne fait rien de plus que _loadRadiusM(),
	// juste un nom public pour un consommateur hors de cette classe.
	loadRadiusM() {
		return this._loadRadiusM();
	}

	async update(dronePos) {
		if (this._lastPos && metersBetween(dronePos, this._lastPos) < REFRESH_THRESHOLD_M) return;
		this._lastPos = dronePos;

		const loadRadiusM = this._loadRadiusM();
		// Un niveau par anneau (#22, lod.mjs) : le niveau plein près du drone,
		// un de moins puis deux au loin. Une traversée par anneau, EN SÉQUENCE
		// et du plus fin au plus grossier : la première fetche tous les bulks,
		// les suivantes (zones et profondeurs incluses dans la sienne) ne
		// touchent plus que le cache du worker de traversée (#21) — en
		// parallèle, elles auraient demandé les mêmes bulks en même temps.
		const rings = ringsFor(loadRadiusM, this._level);
		const perRing = [];
		for (const ring of rings) {
			const zone = zoneOf({ lat: dronePos.lat, lon: dronePos.lon, radius: ring.radiusM });
			const { nodes, radius: sphereRadius } = await this._traverse(zone, ring.level, {});
			this._sphereRadius = sphereRadius;
			perRing.push({ radiusM: ring.radiusM, level: ring.level, nodes });
		}
		// Disque, pas carré (#21) et anneaux emboîtés sans recouvrement
		// (#22) : voir assembleLod(). Un nœud sans box (ne devrait pas arriver
		// depuis traverse()) est gardé plutôt que perdu en silence — même
		// politique que le tri par distance plus bas.
		const desired = new Map(assembleLod(perRing, dronePos).map((n) => [n.path, n]));

		// Centre de la fenêtre en mètres locaux ENU (repère de physics.position,
		// origine fixée au spawn) : c'est ce que la Tâche 10 lit pour le rappel
		// doux, distance(drone, centre) vs nearestTrustedRadius().
		const centerEcef = geodeticToEcef(dronePos.lat, dronePos.lon, 0);
		const local = ecefToLocalEnu(centerEcef, this._originEcef, this._originBasis);
		this.windowCenterLocal = { x: local.x, z: local.z };

		// Libère ce qui n'est plus voulu — ET ce dont la GÉOMÉTRIE a changé.
		// Depuis le LOD par anneaux (#22), `exclude` dépend de la position de
		// la fenêtre : un nœud grossier n'exclut un octant que tant qu'un nœud
		// plus fin le redessine. En volant, ce nœud fin sort du premier anneau
		// et est libéré ; le grossier, lui, reste désiré. Sans cette
		// comparaison il gardait le mesh construit avec l'ancien exclude —
		// l'octant n'était plus dessiné par personne (trou béant à mi-distance)
		// ou l'était deux fois (z-fight). Mesuré sur les vraies données à
		// Paris : 70 nœuds sur 870 dérivent à chaque recentrage de 50 m, et
		// l'erreur s'accumule tant que le nœud reste dans la fenêtre. Le
		// refetch ne coûte pas de réseau (Cache API du pool, #21), seulement un
		// re-build — le prix du bon maillage.
		// Tous les préfixes des chemins désirés : de quoi reconnaître, pour un
		// nœud qui s'en va, s'il est REMPLACÉ par un autre niveau (un ancêtre
		// ou un descendant couvre le même sol) plutôt que vraiment quitté.
		// Le LOD par anneaux en produit ~124 par recentrage à 600 m de portée,
		// mesuré à Paris — bien plus que les ~16 qui sortent réellement du
		// disque. Les libérer aussitôt rouvre le trou que l'échange de #31
		// avait fermé : là, le remplaçant n'a PAS le même chemin (21 -> 20,
		// c'est le parent), donc l'échange par chemin ne s'applique pas.
		const desiredPrefixes = new Set();
		for (const p of desired.keys()) for (let len = 1; len <= p.length; len++) desiredPrefixes.add(p.slice(0, len));
		const coveredByOtherLevel = (path) => {
			if (desiredPrefixes.has(path)) return true;               // un désiré descend sous lui
			for (let len = 1; len < path.length; len++) if (desired.has(path.slice(0, len))) return true;   // un ancêtre désiré le couvre
			return false;
		};

		// Les nœuds dont on garde le mesh à l'écran en attendant le remplaçant :
		// si le refetch échoue, il faudra bien finir par le retirer (sinon plus
		// aucune entrée ne le libérera jamais).
		const replacing = new Set();
		for (const path of [...this._nodes.keys()]) {
			const entry = this._nodes.get(path);
			const want = desired.get(path);
			if (want && sameExclude(entry.exclude, want.exclude)) continue;
			// Remplacé par un autre niveau : on le laisse à l'écran, l'appelant
			// le retirera quand la vague sera CONSTRUITE. Deux niveaux du même
			// sol dessinés ensemble une seconde, c'est un scintillement ; un
			// trou, c'est le ciel à travers le sol. On préfère le scintillement.
			if (!want && entry.status === 'ready' && coveredByOtherLevel(path)) {
				// `covered` : l'appelant garde le mesh à l'écran jusqu'à ce que la
				// VAGUE SOIT CONSTRUITE, pas seulement reçue du réseau. Cette
				// nuance est tout : la fenêtre ne connaît que ses fetchs, elle
				// ignore la file de builds étalée sous budget par frame — libérer
				// au retour du réseau creusait un trou PLUS grand qu'avant
				// (mesuré : 3,11 % de moyenne contre 0,54 %). C'est donc à
				// l'appelant de choisir le moment.
				this._nodes.delete(path);
				this._onNodeReleased(path, { covered: true });
				continue;
			}
			if (entry.status === 'pending') entry.controller.abort();
			// Un nœud TOUJOURS désiré dont seul le maillage change n'est pas
			// retiré de la scène tout de suite : `replaced` dit à l'appelant
			// que le remplaçant arrive et qu'il échangera lui-même. Sinon
			// l'ancien part immédiatement (les libérations passent avant les
			// builds) et le sol manque le temps du refetch — mesuré en jeu :
			// 8,17 % du sol absent 583 ms après un recentrage, refermé avant
			// 1,2 s. C'est l'« anneau qui recharge » vu en volant.
			else if (want) { this._onNodeReleased(path, { replaced: true }); replacing.add(path); }
			else this._onNodeReleased(path);
			this._nodes.delete(path);
		}

		// Fetch dans l'ordre de la distance au drone, pas de la marche de
		// l'octree (#184) : le nœud SOUS le drone part dans la première vague —
		// c'est lui que l'attente du sol de bootLive() guette (elle expirait à
		// froid quand il arrivait dernier, drone mesuré à −917 m), et le terrain
		// proche apparaît avant le lointain. Les nœuds sans box (ne devrait pas
		// arriver depuis traverse()) passent en dernier plutôt que de planter.
		const dist = (n) => (n.box
			? metersBetween(dronePos, { lat: (n.box.s + n.box.n) / 2, lon: (n.box.w + n.box.e) / 2 })
			: Infinity);
		const missing = [...desired.values()].filter((n) => !this._nodes.has(n.path));
		missing.sort((a, b) => dist(a) - dist(b));
		for (const meta of missing) {
			const path = meta.path;
			const controller = new AbortController();
			// `exclude` est retenu avec l'entrée : c'est lui que le prochain
			// recalcul compare (voir la boucle de libération plus haut).
			const entry = { status: 'pending', controller, exclude: meta.exclude, replacing: replacing.has(path) };
			this._nodes.set(path, entry);
			this._runFetch(path, meta, entry, performance.now(), 0);
		}
	}

	// Abandon d'un fetch : l'entrée disparaît. Si elle remplaçait un mesh
	// laissé à l'écran (voir `replaced` dans update()), c'est le dernier
	// moment pour le retirer — sinon plus aucune entrée ne le connaît et il
	// reste là, périmé, jusqu'à la fin de la session.
	_giveUp(path, entry) {
		this._nodes.delete(path);
		if (entry.replacing) this._onNodeReleased(path);
	}

	// Une tentative de fetch pour `path`, avec retry en cas d'échec transitoire
	// (#186). `entry` est l'objet stocké dans this._nodes : son identité (pas
	// juste this._nodes.has(path)) sert à détecter qu'un nœud a été libéré OU
	// remplacé par une entrée plus récente (nouvel update() sur le même path)
	// pendant qu'une tentative ou une attente de backoff était en cours — dans
	// les deux cas, cette tentative n'a plus rien à faire. `t0` reste celui de
	// la PREMIÈRE tentative : la latence mesurée est le temps total jusqu'à ce
	// que le nœud soit prêt, pas celui du dernier essai seul.
	async _runFetch(path, meta, entry, t0, attempt) {
		let result;
		try {
			// Le build (ECEF→ENU, strip, UV) tourne dans le Worker (#187) : il
			// lui faut le rayon de la sphère rocktree et l'origine ENU de la
			// session, que seule la fenêtre connaît. Joints à chaque requête
			// (stateless — le Worker ne garde aucun état de session).
			result = await this._fetchNode({
				...meta,
				sphereRadius: this._sphereRadius,
				originEcef: this._originEcef,
				originBasis: this._originBasis,
			}, { signal: entry.controller.signal });
		} catch (err) {
			if (this._nodes.get(path) !== entry) return;   // libéré/remplacé entre-temps
			// Trois issues de nature différente pour ce catch :
			//   - abort : la boucle de libération de update() a déjà retiré
			//     l'entrée (elle ne l'a délibérément plus voulue) ; rien à
			//     retenter, rien à nettoyer de plus ici.
			if (err?.name === 'AbortError') return;
			//   - 404/410 : nœud réellement absent, résultat NORMAL de ce
			//     protocole (pas une panne). Jamais de retry.
			if (err?.status === 404 || err?.status === 410) { this._giveUp(path, entry); return; }
			//   - tout le reste (coupure réseau, 5xx, status null) : échec
			//     transitoire, on retente sur place plutôt que d'attendre le
			//     prochain recalcul de fenêtre.
			if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
				// Tentatives épuisées : on abandonne pour CE recalcul. Le nœud
				// reste désiré (il n'a jamais été retiré de `desired`) donc le
				// prochain recalcul de fenêtre le retentera tant qu'il l'est
				// toujours — la boucle de secours d'origine, conservée.
				this._giveUp(path, entry);
				return;
			}
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt));
			if (this._nodes.get(path) !== entry) return;   // libéré pendant l'attente
			return this._runFetch(path, meta, entry, t0, attempt + 1);
		}
		if (this._nodes.get(path) !== entry) return;   // libéré entre-temps
		this._latencies.push((performance.now() - t0) / 1000);
		if (this._latencies.length > LATENCY_SAMPLES) this._latencies.shift();
		entry.status = 'ready';
		// onNodeReady() ne devrait JAMAIS lever ; s'il lève, c'est un bug de
		// l'appelant (ex. addNodeCollider sur une clé dupliquée). Le traiter
		// comme un échec de fetch le rendait invisible ET fuyait : l'ancien
		// code faisait _nodes.delete(path) alors qu'onNodeReady avait peut-être
		// déjà ajouté mesh/collider au monde — plus aucune entrée pour les
		// libérer un jour. On garde donc l'entrée 'ready' (une libération
		// future appellera bien onNodeReleased) et on hurle dans la console au
		// lieu d'avaler.
		try {
			this._onNodeReady(path, result.matrix, result.meshes, this._sphereRadius);
		} catch (err) {
			console.error(`[rocktree] onNodeReady a levé pour ${path} — bug de l'appelant, pas un 404`, err);
		}
	}
}
