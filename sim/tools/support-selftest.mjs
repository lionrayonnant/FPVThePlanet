// Selftest of the support addresses (tools/support-model.mjs). No DOM, no I/O.
// Run: node tools/support-selftest.mjs
//
// This one is not like the others. Every other selftest protects behaviour; this
// protects MONEY. An address that loses a character still looks like an address,
// the screen still renders, nothing throws — and a stranger's donation is gone
// for good, from a repository and from every binary shipped under that release.
//
// So the checksums are recomputed here from first principles rather than
// compared against a copy: bech32 and bech32m for the Bitcoin addresses, and
// Keccak-256 for Monero, which is the original Keccak and NOT the SHA3-256 that
// node:crypto provides (they differ in one padding byte). The implementation is
// checked against the official Keccak test vector before its verdict is
// trusted — an unverified hash proving an unverified address is worth nothing.
import assert from 'node:assert/strict';
import { ADDRESSES, HANDLE, SUPPORT_LINES, paymentUri } from './support-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- bech32 / bech32m (BIP173, BIP350) --------------------------------------
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(v) {
	let c = 1;
	for (const d of v) {
		const b = c >> 25;
		c = ((c & 0x1ffffff) << 5) ^ d;
		for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= GEN[i];
	}
	return c;
}
function bechVariant(addr) {
	const s = addr.toLowerCase();
	assert.equal(addr, s, `${addr}: mixed case`);
	const pos = s.lastIndexOf('1');
	assert.ok(pos > 0 && pos + 7 <= s.length, `${addr}: misplaced separator`);
	const exp = [];
	for (const c of s.slice(0, pos)) exp.push(c.charCodeAt(0) >> 5);
	exp.push(0);
	for (const c of s.slice(0, pos)) exp.push(c.charCodeAt(0) & 31);
	for (const c of s.slice(pos + 1)) {
		const i = CH.indexOf(c);
		assert.ok(i >= 0, `${addr}: "${c}" is outside the bech32 alphabet`);
		exp.push(i);
	}
	const m = polymod(exp);
	return m === 1 ? 'bech32' : m === 0x2bc830a3 ? 'bech32m' : null;
}

// --- Keccak-256, the original (padding 0x01, not SHA3's 0x06) ---------------
const RC = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
	0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
	0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
	0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
	0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
	0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;
const rol = (x, k) => (k === 0 ? x : ((x << BigInt(k)) | (x >> BigInt(64 - k))) & M64);
function keccak256(bytes) {
	const RATE = 136;
	const pad = new Uint8Array((Math.floor(bytes.length / RATE) + 1) * RATE);
	pad.set(bytes);
	pad[bytes.length] = 0x01;
	pad[pad.length - 1] |= 0x80;
	let A = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);
	for (let off = 0; off < pad.length; off += RATE) {
		for (let i = 0; i < RATE / 8; i++) {
			let w = 0n;
			for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(pad[off + i * 8 + b]);
			A[i % 5][Math.floor(i / 5)] ^= w;
		}
		for (let r = 0; r < 24; r++) {
			const C = [0, 1, 2, 3, 4].map((x) => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
			const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1));
			for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
			const B = [[], [], [], [], []];
			for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rol(A[x][y], ROT[x][y]);
			for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & M64) & B[(x + 2) % 5][y]);
			A[0][0] ^= RC[r];
		}
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) {
		let w = A[i % 5][Math.floor(i / 5)];
		for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(w & 0xffn); w >>= 8n; }
	}
	return out;
}

// Monero base58: 8-byte blocks to 11 characters, a shorter final block.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function moneroDecode(s) {
	const out = [];
	for (let i = 0; i < s.length; i += 11) {
		const chunk = s.slice(i, i + 11);
		const size = BLOCK.indexOf(chunk.length);
		assert.ok(size > 0, `block of invalid length ${chunk.length}`);
		let v = 0n;
		for (const c of chunk) {
			const d = B58.indexOf(c);
			assert.ok(d >= 0, `"${c}" is outside the Monero base58 alphabet`);
			v = v * 58n + BigInt(d);
		}
		const b = new Array(size);
		for (let k = size - 1; k >= 0; k--) { b[k] = Number(v & 0xffn); v >>= 8n; }
		assert.equal(v, 0n, 'block overflows its byte length');
		out.push(...b);
	}
	return Uint8Array.from(out);
}
const hex = (a) => [...a].map((x) => x.toString(16).padStart(2, '0')).join('');

// --- the tests --------------------------------------------------------------

t('Keccak-256 matches the official empty-string vector', () => {
	// Everything the Monero verdict rests on. If this fails, the address check
	// below proves nothing, so it runs first.
	assert.equal(hex(keccak256(new Uint8Array(0))),
		'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

t('the Monero address carries a valid Keccak checksum', () => {
	const { address } = ADDRESSES.find((a) => a.id === 'xmr');
	assert.equal(address.length, 95, 'a standard mainnet address is 95 characters');
	const raw = moneroDecode(address);
	assert.equal(raw.length, 69, '1 network byte + 32 spend + 32 view + 4 checksum');
	assert.equal(raw[0], 18, 'network byte 18 is mainnet standard');
	assert.equal(hex(raw.slice(65)), hex(keccak256(raw.slice(0, 65)).slice(0, 4)));
});

t('the silent payment address is valid bech32m', () => {
	const { address } = ADDRESSES.find((a) => a.id === 'btc-sp');
	assert.ok(address.startsWith('sp1'), 'BIP352 addresses use the sp human-readable part');
	assert.equal(bechVariant(address), 'bech32m', 'checksum');
});

t('the plain Bitcoin address is valid bech32', () => {
	const { address } = ADDRESSES.find((a) => a.id === 'btc');
	assert.ok(address.startsWith('bc1q'), 'mainnet, witness v0');
	assert.equal(bechVariant(address), 'bech32', 'checksum');
});

t('nothing is a placeholder, and nothing repeats', () => {
	// A copied line is how two coins end up sharing one address.
	const seen = new Set();
	for (const a of ADDRESSES) {
		assert.ok(a.address.length > 20, `${a.id}: too short to be real`);
		assert.doesNotMatch(a.address, /x{4}|example|todo|change|your/i, `${a.id}: looks like a placeholder`);
		assert.equal(seen.has(a.address), false, `${a.id}: address already used above`);
		seen.add(a.address);
	}
	assert.match(HANDLE, /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'the handle is a handle');
});

t('every entry renders a payment URI its wallet will recognise', () => {
	for (const a of ADDRESSES) {
		assert.equal(paymentUri(a), `${a.uri}${a.address}`);
		assert.match(paymentUri(a), /^(monero|bitcoin):/);
	}
});

t('the screen has something to say, in the terminal voice', () => {
	assert.ok(SUPPORT_LINES.length >= 2);
	for (const l of SUPPORT_LINES) assert.equal(l, l.toUpperCase(), 'the terminal speaks in upper case');
});

console.log(`\n${n} support tests OK — every address verified by checksum`);
