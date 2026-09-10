// Files de travail du mode live (#184, #32, #75) : ce que la fenêtre de
// streaming (rocktree-window.js) a reçu ou libéré attend ici, et drain()
// l'exécute sous un budget par frame. Ni Three ni Rapier : l'appelant passe
// build()/dispose(), ce module ne décide que de l'ORDRE et du MOMENT.
//
// Le principe (#75) : L'ANCIENNE IMAGE RESTE INTACTE JUSQU'À CE QUE LA
// NOUVELLE SOIT COMPLÈTE, PUIS ON ÉCHANGE. Quatre files, dans l'ordre du drain :
//   - releases : mesh + collider à retirer tout de suite (nœuds sortis du
//     disque : rendent la mémoire, un retard laisserait des fantômes) ;
//   - builds   : nœuds reçus dont RIEN n'est à l'écran — posés au fil de
//     l'eau, c'est l'horizon qui avance (~1,4 ms chacun, par rafales de
//     dizaines, d'où le budget) ;
//   - swaps    : nœuds reçus dont un mesh est DÉJÀ à l'écran (`replaced`,
//     #31 : même chemin, autre `exclude`). Différés jusqu'à la vague
//     complète : un grossier rebâti avec un octant en moins, avant que
//     l'enfant fin qui le redessine soit arrivé, c'est un trou — mesuré en
//     vol, le refetch du grossier revient du Cache API bien avant l'enfant ;
//   - covered  : nœuds qu'un AUTRE NIVEAU remplace (LOD par anneaux, #22).
//     Tenus à l'écran jusqu'à la vague complète, puis libérés.
//
// « Vague complète » = plus rien en vol côté réseau (pendingFetches(), le
// pendingCount() de la fenêtre) ET plus aucun build frais en file. La
// version précédente n'attendait que la file de builds — qui EST vide au
// moment même du recentrage, la fenêtre libérant de façon synchrone avant
// qu'aucun fetch n'ait répondu. Mesuré en vol (Champ de Mars, 24 m/s) : 18
// vidages sur 18 avec 190 à 314 fetchs en vol, jusqu'à 7 % du sol absent.
// Deux niveaux du même sol dessinés ensemble une seconde, c'est un
// scintillement ; un trou, c'est le ciel à travers le sol. On préfère le
// scintillement — et plus de meshes à l'écran pendant une vague.

// ~3 ms : ce qui tient dans une frame de 60 fps déjà occupée par la physique
// et le rendu sans la faire déborder de 16,7 ms. Une vague de 800 nœuds
// (~1,1 s de travail) s'étale ainsi sur ~5 s au lieu de geler l'image —
// le tri par distance de rocktree-window.js fait apparaître le proche d'abord.
export const NODE_WORK_BUDGET_MS = 3;
// Budget adaptatif (#189) : quand la file est profonde (recentrage de
// fenêtre en vol), 3 ms/frame étalent une vague de 300 m sur 10-15 s de
// remplissage visible. 8 ms restent sous une frame de 60 fps (steps ~1,6 ms
// + rendu ~5 ms + 8 ≈ 15 ms, mesuré #187) et remplissent ~2,5× plus vite.
// Le seuil évite de payer 8 ms sur le goutte-à-goutte normal (file quasi
// vide : les nœuds arrivent au rythme du réseau).
export const DEEP_QUEUE_JOBS = 50;
export const DEEP_QUEUE_BUDGET_MS = 8;
// Soupape : si la vague ne se termine jamais (réseau plus lent que le vol,
// chaque recentrage relançant des fetchs avant la fin du précédent), les
// échanges et les couverts s'accumulent sans borne. Au-delà de ce délai
// d'attente on échange quand même — un trou passager vaut mieux qu'un onglet
// qui déborde. CHOISI : à 24 m/s une vague se termine en ~2 s (mesuré), 15 s
// c'est un réseau qui ne suit vraiment pas.
export const WAVE_STALL_MS = 15_000;

export class LiveNodeQueue {
	constructor() {
		this.builds = new Map();      // path -> job (opaque pour ce module)
		this.swaps = new Map();       // path -> job, un mesh est déjà à l'écran
		this.releases = [];           // paths dont mesh + collider sont à retirer
		this.covered = new Set();     // paths tenus à l'écran jusqu'à la vague complète
		this._waitingSince = null;    // début de l'attente de vague (swaps/covered non vides)
	}

	// `swap` : un mesh est déjà à l'écran pour ce chemin (l'appelant le sait,
	// pas ce module) — le build attendra la vague complète.
	queueBuild(path, job, { swap = false } = {}) {
		if (swap) { this.builds.delete(path); this.swaps.set(path, job); }
		else { this.swaps.delete(path); this.builds.set(path, job); }
	}
	queueRelease(path) { this.dropBuild(path); this.covered.delete(path); this.releases.push(path); }
	// Un build encore en file pour ce chemin est jeté : le mesh à l'écran
	// suffit jusqu'à la vague, et un build posé après la libération de son
	// entrée serait orphelin — plus rien ne le retirerait jamais.
	queueCovered(path) { this.dropBuild(path); this.covered.add(path); }
	// Jette un build encore en file ; rend vrai s'il y en avait un.
	dropBuild(path) { return this.builds.delete(path) || this.swaps.delete(path); }

	// Le budget de la frame selon la profondeur de la file (voir en tête).
	budgetMs() { return this.builds.size + this.swaps.size > DEEP_QUEUE_JOBS ? DEEP_QUEUE_BUDGET_MS : NODE_WORK_BUDGET_MS; }

	// Rien de différé ne reste : ce que bootLive() attend derrière l'écran de
	// chargement (avec le pendingCount() de la fenêtre, qu'il vérifie aussi).
	idle() { return this.builds.size === 0 && this.swaps.size === 0 && this.releases.length === 0 && this.covered.size === 0; }

	// Draine sous budget (voir l'ordre en tête).
	//   pendingFetches() : fetchs encore en vol dans la fenêtre.
	//   build(path, job) : construit et pose le nœud (échange si déjà en scène).
	//   dispose(path)    : retire mesh + collider.
	drain({ budgetMs = this.budgetMs(), pendingFetches, build, dispose, now = () => performance.now() }) {
		const start = now();
		while (now() - start < budgetMs) {
			if (this.releases.length > 0) { dispose(this.releases.shift()); continue; }
			const fresh = this.builds.entries().next();
			if (!fresh.done) {
				const [path, job] = fresh.value;
				this.builds.delete(path);
				build(path, job);
				continue;
			}
			// Plus de build frais : la vague est-elle complète ?
			if (this.swaps.size === 0 && this.covered.size === 0) { this._waitingSince = null; break; }
			if (this._waitingSince === null) this._waitingSince = start;
			if (pendingFetches() > 0 && start - this._waitingSince < WAVE_STALL_MS) break;
			// Oui (ou soupape) : on échange, puis on libère les couverts.
			const swap = this.swaps.entries().next();
			if (!swap.done) {
				const [path, job] = swap.value;
				this.swaps.delete(path);
				// Un couvert que la fenêtre redemande (demi-tour) est
				// reconstruit ici : le mesh neuf reprend le chemin, le vidage
				// des couverts ne doit plus le retirer.
				this.covered.delete(path);
				build(path, job);
				continue;
			}
			this.releases.push(...this.covered);
			this.covered.clear();
			this._waitingSince = null;
		}
	}
}
