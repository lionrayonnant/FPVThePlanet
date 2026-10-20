// Featured LIVE drop points (#200): places with dense Google 3D coverage, one
// click from a first flight. Pure and Node-safe so the selftest can pin the
// list without a map.
//
// Each pin sits on open ground (a square, a park, a forecourt): the drone
// spawns at the pin, and a first take-off should not start inside a facade.

export const FEATURED_DROPS = [
	{ id: 'paris', name: 'PARIS · CHAMP DE MARS', lat: 48.8556, lon: 2.2986 },
	{ id: 'tokyo', name: 'TOKYO · SHIBUYA', lat: 35.6595, lon: 139.7005 },
	{ id: 'new-york', name: 'NEW YORK · BRYANT PARK', lat: 40.7536, lon: -73.9832 },
	{ id: 'san-francisco', name: 'SAN FRANCISCO · EMBARCADERO', lat: 37.7955, lon: -122.3937 },
	{ id: 'rome', name: 'ROME · COLOSSEUM', lat: 41.8902, lon: 12.4922 },
];

// The drop to pin before the operator has chosen anything: the first one, but
// only for an operator who has never flown. Anyone with a session behind them
// has a place of their own, and a pin they did not drop would be noise.
export function firstDropFor(operator) {
	const sessions = Array.isArray(operator?.sessions) ? operator.sessions.length : 0;
	return sessions === 0 ? FEATURED_DROPS[0] : null;
}
