// Pack de secours du moteur de dialogue (PHASE 21, D2). Minuscule et sans
// aucun `requires` : c'est ce qui s'affiche quand le shard n'a pas pu être
// chargé. Un écran muet serait pire qu'un écran répétitif.
export const FALLBACK = [
	{ id: 'fallback/0001', events: ['AREA_SEARCH', 'PROBE_AREA'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'anything down there' },
	          { speaker: 'mikhail', text: 'define anything' }] },
	{ id: 'fallback/0002', events: ['ACQUIRE_AREA', 'TERRAIN_PROGRESS'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'ship it' },
	          { speaker: 'mikhail', text: 'no' }] },
	{ id: 'fallback/0003', events: ['ACQUIRE_AREA', 'TERRAIN_PROGRESS'], rarity: 'COMMON',
	  characters: ['cron'], requires: [],
	  lines: [{ speaker: 'cron', text: 'cache warm' }] },
	{ id: 'fallback/0004', events: ['TARGET_SCAN', 'TARGET_SELECTED', 'WEATHER'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'mikhail', text: 'that one is not worth the trip' },
	          { speaker: 'root', text: 'noted' }] },
	{ id: 'fallback/0005', events: ['TARGET_ANALYSIS', 'HACK', 'MANUAL_OVERRIDE', 'JACK_IN'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'channel is open' },
	          { speaker: 'mikhail', text: 'it is not the same thing as ready' }] },
];
