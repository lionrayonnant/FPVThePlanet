// Tableau typé à croissance amortie (doublement de capacité). Générique, sans
// rapport avec un format de tuile particulier : utilisé par les décodeurs pour
// accumuler leurs sorties (vx/vy/vz/tu/tv/triByMat...) et par prep.mjs côté
// rebuild pour les buffers par chunk (pos/uv/lay/idx). Vit ici plutôt que dans
// un décodeur précis pour que le rebuild — la partie que ce refactor rend
// justement indépendante du format d'entrée — n'ait pas à importer un décodeur
// pour un simple utilitaire (issue #18).
export class Growable {
	constructor(Type, initial = 1 << 16) {
		this.Type = Type;
		this.buf = new Type(initial);
		this.length = 0;
	}
	_room(n) {
		if (this.length + n <= this.buf.length) return;
		let cap = this.buf.length;
		while (cap < this.length + n) cap *= 2;
		const next = new this.Type(cap);
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
	}
	push(...vals) {
		this._room(vals.length);
		for (const v of vals) this.buf[this.length++] = v;
	}
	view() { return this.buf.subarray(0, this.length); }
	get array() { return this.buf; }
}
