const { test } = require("node:test");
const assert = require("node:assert");
const { generateTotp, base32Decode } = require("../dist/abode/totp");

// RFC 6238 Appendix B test vectors (SHA-1). Secret is ASCII "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const vectors = [
	[59, "94287082"],
	[1111111109, "07081804"],
	[1111111111, "14050471"],
	[1234567890, "89005924"],
	[2000000000, "69279037"],
	[20000000000, "65353130"],
];

test("matches RFC 6238 SHA-1 vectors", () => {
	for (const [seconds, expected] of vectors) {
		assert.strictEqual(generateTotp(RFC_SECRET, seconds * 1000, 30, 8), expected);
	}
});

test("6-digit codes are the last 6 digits of the 8-digit ones", () => {
	assert.strictEqual(generateTotp(RFC_SECRET, 59 * 1000), "287082");
});

test("accepts lowercase, spaces and padding", () => {
	assert.deepStrictEqual(base32Decode("gezd gnbv gy3t qojq===="), base32Decode("GEZDGNBVGY3TQOJQ"));
});

test("rejects non-base32 input", () => {
	assert.throws(() => base32Decode("123456"), /Invalid character/);
});

const { normalizeMfaSecret } = require("../dist/abode/totp");

test("normalizes a setup key with spaces and lowercase", () => {
	assert.strictEqual(normalizeMfaSecret(" jbsw y3dp ehpk 3pxp "), "JBSWY3DPEHPK3PXP");
});

test("extracts the secret from an otpauth:// link", () => {
	assert.strictEqual(
		normalizeMfaSecret("otpauth://totp/Abode:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Abode"),
		"JBSWY3DPEHPK3PXP",
	);
});

test("rejects a 6-digit one-time code with a clear message", () => {
	assert.throws(() => normalizeMfaSecret("482913"), /one-time code.*setup key/s);
	assert.throws(() => normalizeMfaSecret("482 913"), /one-time code/);
});

test("rejects keys that are too short or not base32", () => {
	assert.throws(() => normalizeMfaSecret("JBSWY3DP"), /only 8 characters/);
	assert.throws(() => normalizeMfaSecret("JBSWY3DPEHPK3PX1"), /A-Z and digits 2-7/);
});
