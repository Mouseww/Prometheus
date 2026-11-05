const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BITS = 80n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function randomBits(): bigint {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	return n;
}

function encode(value: bigint, length: number): string {
	let out = "";
	let v = value;
	for (let i = 0; i < length; i++) {
		out = ALPHABET[Number(v & 31n)] + out;
		v >>= 5n;
	}
	return out;
}

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. Monotonic within a process so ids sort by creation order (audit cursors rely on it). */
export function ulid(now: number = Date.now()): string {
	let time = now;
	let rand: bigint;
	if (time <= lastTime) {
		time = lastTime;
		rand = (lastRandom + 1n) & RANDOM_MASK;
	} else {
		rand = randomBits();
	}
	lastTime = time;
	lastRandom = rand;
	return encode(BigInt(time), 10) + encode(rand, 16);
}
