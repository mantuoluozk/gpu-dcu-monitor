const assert = require("assert");
const { AdminAuth, hashPassword, verifyPassword } = require("../admin-auth");

const encoded = hashPassword("correct-horse", "00112233445566778899aabbccddeeff");
assert(verifyPassword("correct-horse", encoded));
assert(!verifyPassword("wrong-password", encoded));

const auth = new AdminAuth({ passwordHash: encoded, sessionTtlMs: 1000, rateWindowMs: 5000, maxAttempts: 2 });
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
assert.deepStrictEqual(auth.status(req, 1000), { configured: true, authenticated: false, expiresAt: null });
assert.strictEqual(auth.login(req, "wrong-password", 1000).status, 401);
assert.strictEqual(auth.login(req, "wrong-password", 1100).status, 401);
assert.strictEqual(auth.login(req, "correct-horse", 1200).status, 429);

const loginReq = { headers: {}, socket: { remoteAddress: "127.0.0.2" } };
const login = auth.login(loginReq, "correct-horse", 2000);
assert(login.ok);
const cookie = auth.sessionCookie(loginReq, login.token).split(";")[0];
const authenticatedReq = { headers: { cookie }, socket: { remoteAddress: "127.0.0.2" } };
assert(auth.isAuthenticated(authenticatedReq, 2500));
assert(!auth.isAuthenticated(authenticatedReq, 3100));

console.log("admin-auth tests passed");
