// Politique de la fenêtre de streaming rocktree (#168) : quels nœuds charger
// ou décharger selon la position de vol. Ne touche NI Three NI Rapier — ça,
// c'est le problème de l'appelant (main.js, Tâche 9), via onNodeReady()/
// onNodeReleased(). Même frontière que fetchNode() dans la tranche
// précédente : testable seule, remplaçable seule.
import { traverse as realTraverse, zoneOf } from '../tools/lib/rocktree/traverse.mjs';
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

const M_PER_DEG_LAT = 111320;

function metersBetween(a, b) {
	const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
	const dLon = (a.lon - b.lon) * M_PER_DEG_LAT * Math.cos((a.lat / 180) * Math.PI);
	return Math.hypot(dLat, dLon);
}

function p95(samples) {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

export class RocktreeWindow {
	constructor({ level, origin, onNodeReady, onNodeReleased, _traverse = realTraverse, _fetchNode = realFetchNode }) {
		this._level = level;
		this._origin = origin;
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
		if (latencySeconds == null) return FALLBACK_RADIUS_M;   // aucune mesure encore
		// Plancher à FALLBACK_RADIUS_M : la formule latence×vitesse garantit la
		// COLLISION, mais ce rayon est aussi toute la portée VISUELLE du jalon
		// (pas de LOD). Mesuré en vol (#180) : à faible latence elle tombait à
		// 60-150 m — la fenêtre passait de 1032 meshes au boot à ~340 au premier
		// recalcul, l'horizon reculait en volant. Le plancher rend la portée du
		// boot permanente ; voir plus loin que 200 m est le travail de la vraie
		// sélection de LOD (tranche suivante), pas de ce rayon-ci.
		return Math.max(FALLBACK_RADIUS_M, REFRESH_THRESHOLD_M + latencySeconds * WORST_MEASURED_SPEED_MS);
	}

	// Rayon de CONFIANCE, distinct du rayon de chargement ci-dessus : « radius
	// moins une marge de sécurité » (la spec). C'est ce que l'appelant compare à
	// distance(drone, windowCenterLocal) pour le rappel doux — donc il doit
	// rester STRICTEMENT à l'intérieur de ce qui est réellement chargé.
	nearestTrustedRadius() {
		return Math.max(0, this._loadRadiusM() - TRUST_MARGIN_M);
	}

	async update(dronePos) {
		if (this._lastPos && metersBetween(dronePos, this._lastPos) < REFRESH_THRESHOLD_M) return;
		this._lastPos = dronePos;

		const loadRadiusM = this._loadRadiusM();
		const zone = zoneOf({ lat: dronePos.lat, lon: dronePos.lon, radius: loadRadiusM });
		const { nodes, radius: sphereRadius } = await this._traverse(zone, this._level, {});
		this._sphereRadius = sphereRadius;
		const desired = new Map(nodes.map((n) => [n.path, n]));

		// Centre de la fenêtre en mètres locaux ENU (repère de physics.position,
		// origine fixée au spawn) : c'est ce que la Tâche 10 lit pour le rappel
		// doux, distance(drone, centre) vs nearestTrustedRadius().
		const centerEcef = geodeticToEcef(dronePos.lat, dronePos.lon, 0);
		const local = ecefToLocalEnu(centerEcef, this._originEcef, this._originBasis);
		this.windowCenterLocal = { x: local.x, z: local.z };

		for (const path of this._nodes.keys()) {
			if (desired.has(path)) continue;
			const entry = this._nodes.get(path);
			if (entry.status === 'pending') entry.controller.abort();
			else this._onNodeReleased(path);
			this._nodes.delete(path);
		}

		for (const [path, meta] of desired) {
			if (this._nodes.has(path)) continue;
			const controller = new AbortController();
			this._nodes.set(path, { status: 'pending', controller });
			const t0 = performance.now();
			// Deux échecs de nature TOTALEMENT différente, donc deux try/catch
			// séparés — les confondre en un seul .catch() était un vrai bug :
			//   - le fetch peut légitimement échouer (404/410 : nœud absent, c'est
			//     normal dans ce protocole ; ou abort). Silencieux.
			//   - onNodeReady() ne devrait JAMAIS lever ; s'il lève, c'est un bug
			//     de l'appelant (ex. addNodeCollider sur une clé dupliquée). Le
			//     traiter comme un 404 le rendait invisible ET fuyait : l'ancien
			//     code faisait _nodes.delete(path) alors qu'onNodeReady avait
			//     peut-être déjà ajouté mesh/collider au monde — plus aucune
			//     entrée pour les libérer un jour. On garde donc l'entrée 'ready'
			//     (une libération future appellera bien onNodeReleased) et on
			//     hurle dans la console au lieu d'avaler.
			(async () => {
				let result;
				try {
					result = await this._fetchNode(meta, { signal: controller.signal });
				} catch {
					// this._nodes est déjà nettoyé par la boucle de libération
					// ci-dessus si c'était un abort ; sinon on le retire ici.
					this._nodes.delete(path);
					return;
				}
				if (!this._nodes.has(path)) return;   // libéré entre-temps
				this._latencies.push((performance.now() - t0) / 1000);
				if (this._latencies.length > LATENCY_SAMPLES) this._latencies.shift();
				this._nodes.set(path, { status: 'ready' });
				try {
					this._onNodeReady(path, result.matrix, result.meshes, this._sphereRadius);
				} catch (err) {
					console.error(`[rocktree] onNodeReady a levé pour ${path} — bug de l'appelant, pas un 404`, err);
				}
			})();
		}
	}
}
