import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 string (the format authenticator apps use for their setup keys).
 * Spaces, dashes and padding are ignored and the input is case-insensitive.
 */
export const base32Decode = (input: string): Buffer => {
	const cleaned = input.replace(/[\s=-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];

	for (const char of cleaned) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) {
			throw new Error(`Invalid character "${char}" in 2FA secret. Expected a base32 setup key (A-Z, 2-7).`);
		}
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}

	if (out.length === 0) {
		throw new Error("2FA secret is empty.");
	}

	return Buffer.from(out);
};

/**
 * Generate an RFC 6238 time-based one-time password (SHA-1, 6 digits, 30 second step),
 * the same code an authenticator app shows for this secret.
 */
export const generateTotp = (secret: string, timestampMs: number = Date.now(), step = 30, digits = 6): string => {
	const key = base32Decode(secret);
	const counter = Math.floor(timestampMs / 1000 / step);

	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeBigUInt64BE(BigInt(counter));

	const hmac = createHmac("sha1", key).update(counterBuffer).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary =
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff);

	return String(binary % 10 ** digits).padStart(digits, "0");
};

/** Seconds left before the current code rolls over. */
export const totpSecondsRemaining = (timestampMs: number = Date.now(), step = 30): number => {
	return step - (Math.floor(timestampMs / 1000) % step);
};
