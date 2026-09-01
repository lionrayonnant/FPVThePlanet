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
// fenêtre doit bien démarrer avec quelque chose.
const FALLBACK_RADIUS_M = 200;

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

	nearestTrustedRadius() {
		const latency = p95(this._latencies);
		const loadRadiusM = latency == null ? FALLBACK_RADIUS_M : latency * WORST_MEASURED_SPEED_MS;
		return loadRadiusM;
	}

	async update(dronePos) {
		if (this._lastPos && metersBetween(dronePos, this._lastPos) < REFRESH_THRESHOLD_M) return;
		this._lastPos = dronePos;

		const loadRadiusM = this.nearestTrustedRadius();
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
			this._fetchNode(meta, { signal: controller.signal })
				.then((result) => {
					if (!this._nodes.has(path)) return;   // libéré entre-temps
					this._latencies.push(performance.now() - t0);
					if (this._latencies.length > LATENCY_SAMPLES) this._latencies.shift();
					this._nodes.set(path, { status: 'ready' });
					this._onNodeReady(path, result.matrix, result.meshes, this._sphereRadius);
				})
				.catch(() => {
					// 404/410 (nœud absent, normal pour le protocole) ou abort :
					// dans les deux cas, rien à afficher. this._nodes est déjà
					// nettoyé par la boucle de libération ci-dessus si c'était un
					// abort ; sinon on le retire ici.
					this._nodes.delete(path);
				});
		}
	}
}
