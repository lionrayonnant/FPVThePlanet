// The ways to support the project, as data.
//
// Pure and Node-safe so `tools/support-selftest.mjs` can verify every address
// by CHECKSUM. That test is the reason this file exists as a module rather than
// as a few strings inside a screen: an address is not a label. A typo in a
// caption is embarrassing; a typo here sends a stranger's money into an
// unspendable void, and the repository and every shipped binary would carry it
// for the life of the release.
//
// Crypto only, deliberately. The fiat rails were considered and dropped: they
// all require identity verification of the recipient, which is the one thing
// this project's author is not offering — and a payment page under a legal
// name would undo a pseudonym the repository keeps everywhere else. The screen
// does NOT say so: explaining the absence of a card button turns a small offer
// into an argument, and the README is where the reasoning belongs.

// A Cake Wallet handle. It resolves to the addresses below, and it is the only
// line here a human can read out loud or type without copying. It goes FIRST
// for that reason: ninety-five characters of base58 is not a user interface.
export const HANDLE = 'fpvtp@cake.cash';

export const ADDRESSES = [
	{
		id: 'xmr',
		label: 'MONERO',
		note: 'Private by construction. The one the author would pick.',
		uri: 'monero:',
		address: '42RnnFdtNasaiUQGEASPGRXjHcr2pDocwXCwGUAhwyp7KbAhbKwCHrEfeYMkUMpo7gQdEABWy9LoRd4iEUFMq2SXKdHPqKt',
	},
	{
		id: 'btc-sp',
		label: 'BITCOIN · SILENT PAYMENT',
		// BIP352. Reusable without the usual cost of reuse: the sender derives a
		// fresh output every time, so nothing on chain ties two donations
		// together. Listed above the plain address for exactly that reason.
		note: 'Reusable, and every payment lands somewhere new.',
		uri: 'bitcoin:',
		address: 'sp1qq2tuvemuzgu6hudsu7jf2h90gl6xemav67s3x3f34l76qtfl6dzgcq43r30lvckcz4qat2x8ju5a36sdqr2r3fe72cqpudvlqh797agdkcvkvkl4',
	},
	{
		id: 'btc',
		label: 'BITCOIN',
		// Kept for wallets that do not speak BIP352 yet, which is most of them.
		note: 'For wallets that do not know silent payments yet.',
		uri: 'bitcoin:',
		address: 'bc1qmwm3rcvzkwaft40yrtynym3yww20t2atfr45yg',
	},
];

// What the footer says above the three marks. One line, in the author's own
// voice rather than the terminal's: the ask is small and it should sound small.
export const SUPPORT_TAGLINE = 'HELP ME FEED CLAUDE CODE AND BUY COFFEE';

// What a tip window says under its own title, once it is open. Written in the
// terminal's voice: the game is free and stays free, and this asks for nothing.
export const SUPPORT_LINES = [
	'THIS PROGRAM IS FREE, AND STAYS FREE.',
	'NOTHING HERE IS PAYWALLED, COUNTED, OR REMEMBERED ABOUT YOU.',
];

// The footer's three marks, and what each one opens.
//
// A mark, not a word: a logo is read before it is decoded, and "SUPPORT" was a
// word a player had to open to understand. One button per CURRENCY, not per
// address — the two Bitcoin addresses are one decision for a donor (which
// wallet they hold), so they share a window rather than splitting the row.
//
// `icon` names an entry of src/pixel-icons.js; `alt` is what a screen reader
// and the render selftest read instead of the picture.
export const TIP_BUTTONS = [
	{
		id: 'cake',
		icon: 'cake',
		alt: 'CAKE WALLET',
		title: 'CAKE WALLET',
		note: 'One line, any coin. It resolves to the addresses in the other two windows.',
		entries: [{ id: 'handle', label: 'ONE LINE, ANY COIN', address: HANDLE, uri: null }],
	},
	{
		id: 'btc',
		icon: 'bitcoin',
		alt: 'BITCOIN',
		title: 'BITCOIN',
		note: null,
		entries: ADDRESSES.filter((a) => a.id.startsWith('btc')),
	},
	{
		id: 'xmr',
		icon: 'monero',
		alt: 'MONERO',
		title: 'MONERO',
		note: null,
		entries: ADDRESSES.filter((a) => a.id === 'xmr'),
	},
];

// The wallet-openable form of an address, or null for the handle, which is not
// a URI scheme and must not be dressed up as one.
export function paymentUri({ uri, address }) {
	return uri ? `${uri}${address}` : null;
}
