const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { AbodeClient } = require("../dist/abode/client");
const { generateTotp } = require("../dist/abode/totp");

const SECRET = "JBSWY3DPEHPK3PXP";
const log = { info() {}, warn() {}, error() {}, debug() {} };

let server;
let baseURL;
const requests = [];

before(async () => {
	server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const json = body ? JSON.parse(body) : undefined;
			requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
			res.setHeader("Content-Type", "application/json");

			if (req.url === "/api/auth2/login") {
				if (!json.mfa_code) return res.end(JSON.stringify({ mfa_type: "google_authenticator" }));
				if (json.mfa_code !== generateTotp(SECRET)) {
					res.statusCode = 400;
					return res.end(JSON.stringify({ message: "Invalid code" }));
				}
				res.setHeader("Set-Cookie", ["SESSION=sess123; Path=/; HttpOnly"]);
				return res.end(JSON.stringify({ token: "apikey123" }));
			}
			if (req.url === "/api/auth2/claims") return res.end(JSON.stringify({ access_token: "oauth123" }));
			if (req.url === "/api/v1/devices") {
				return res.end(JSON.stringify([{ id: "ZW:1", type_tag: "device_type.door_lock", name: "Front", status: "LockClosed" }]));
			}
			if (req.url.startsWith("/api/v1/control/lock/")) return res.end(JSON.stringify({ id: "ZW:1", status: json.status }));
			res.statusCode = 404;
			res.end("{}");
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const makeClient = (mfaSecret) => {
	const client = new AbodeClient({ email: "a@b.c", password: "pw", mfaSecret, deviceUuid: "dev-uuid", userAgent: "test", log });
	client.http.defaults.baseURL = baseURL;
	return client;
};

test("explains that 2FA is required when no secret is configured", async () => {
	await assert.rejects(makeClient().login(), /two-factor authentication enabled.*mfaSecret/);
});

test("signs in with a generated 2FA code and calls the API with all auth headers", async () => {
	requests.length = 0;
	const client = makeClient(SECRET);
	await client.login();

	const login = requests.find((r) => r.url === "/api/auth2/login");
	assert.match(login.body.mfa_code, /^\d{6}$/);
	assert.strictEqual(login.body.remember_me, 1);
	assert.strictEqual(login.body.uuid, "dev-uuid");

	const devices = await client.getDevices();
	assert.strictEqual(devices[0].name, "Front");

	await client.controlLock("ZW:1", 0);
	const control = requests.find((r) => r.url === "/api/v1/control/lock/ZW:1");
	assert.deepStrictEqual(control.body, { status: 0 });
	assert.strictEqual(control.headers["abode-api-key"], "apikey123");
	assert.strictEqual(control.headers.authorization, "Bearer oauth123");
	assert.match(control.headers.cookie, /SESSION=sess123;uuid=dev-uuid/);
});

test("reports a rejected 2FA code clearly", async () => {
	await assert.rejects(makeClient("AAAAAAAAAAAAAAAA").login(), /Invalid code/);
});
