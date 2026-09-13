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
// name would undo a pseudonym the repository keeps everywhere else.

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

// What the screen says above the list. Written in the terminal's own voice: the
// game is free and stays free, and this asks for nothing.
export const SUPPORT_LINES = [
	'THIS PROGRAM IS FREE, AND STAYS FREE.',
	'NOTHING HERE IS PAYWALLED, COUNTED, OR REMEMBERED ABOUT YOU.',
	'IF IT GAVE YOU SOMETHING, YOU CAN GIVE SOMETHING BACK.',
];

export function paymentUri({ uri, address }) {
	return `${uri}${address}`;
}
