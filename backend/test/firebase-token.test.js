import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  validateFirebaseToken,
  FirebaseKeyCache,
} from "../src/core/firebaseAuth.js";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const now = Math.floor(Date.now() / 1000),
  claims = {
    sub: "testFirebaseUid",
    aud: "test-project",
    iss: "https://securetoken.google.com/test-project",
    exp: now + 3600,
    iat: now,
    auth_time: now,
  };
function token(overrides = {}, header = { alg: "RS256", kid: "test-key" }) {
  const a = Buffer.from(JSON.stringify(header)).toString("base64url"),
    b = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString(
      "base64url",
    ),
    signed = `${a}.${b}`;
  return `${signed}.${crypto.sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}
test("verified token derives the authenticated Firebase UID", () =>
  assert.equal(
    validateFirebaseToken(token(), "test-project", { "test-key": publicKey })
      .uid,
    claims.sub,
  ));
test("rejects expired, wrong-project and altered token claims", () => {
  for (const bad of [
    token({ exp: now - 1 }),
    token({ aud: "other-project" }),
    token({ iss: "https://securetoken.google.com/other-project" }),
    token({ auth_time: now + 300 }),
    token({ exp: undefined }),
  ])
    assert.throws(
      () =>
        validateFirebaseToken(bad, "test-project", { "test-key": publicKey }),
      (error) => error.status === 401,
    );
  const t = token().split(".");
  t[1] = Buffer.from(
    JSON.stringify({ ...claims, sub: "someone-else" }),
  ).toString("base64url");
  assert.throws(
    () =>
      validateFirebaseToken(t.join("."), "test-project", {
        "test-key": publicKey,
      }),
    (error) => error.status === 401,
  );
});
test("rejects unsigned and HS256 tokens even with plausible claims", () => {
  assert.throws(
    () =>
      validateFirebaseToken(
        token({}, { alg: "HS256", kid: "test-key" }),
        "test-project",
        { "test-key": publicKey },
      ),
    (error) => error.status === 401,
  );
  assert.throws(
    () =>
      validateFirebaseToken(
        `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
        "test-project",
        { "test-key": publicKey },
      ),
    (error) => error.status === 401,
  );
});

test("signing keys cache warm requests, accept rotation and limit unknown-key refreshes", async () => {
  let clock = 100000,
    requests = 0,
    keys = { "old-key": publicKey.export({ type: "spki", format: "pem" }) };
  const cache = new FirebaseKeyCache(
    async () => {
      requests++;
      return {
        ok: true,
        headers: new Headers({ "cache-control": "public, max-age=3600" }),
        json: async () => keys,
      };
    },
    () => clock,
  );
  await Promise.all([cache.get("old-key"), cache.get("old-key")]);
  assert.equal(requests, 1);
  await cache.get("old-key");
  await cache.get("forged-key");
  assert.equal(requests, 1);
  clock += 61000;
  keys = {
    ...keys,
    "new-key": publicKey.export({ type: "spki", format: "pem" }),
  };
  const refreshed = await cache.get("new-key");
  assert.equal(requests, 2);
  assert.ok(refreshed["new-key"]);
  await cache.get("another-forged-key");
  assert.equal(requests, 2);
  clock += 3600001;
  await cache.get("old-key");
  assert.equal(requests, 3);
});
test("certificate service errors return a retryable authentication error", async () => {
  const cache = new FirebaseKeyCache(async () => {
    throw new Error("Unavailable");
  });
  await assert.rejects(
    cache.get("test-key"),
    (error) => error.status === 503 && error.code === "AUTH_UNAVAILABLE",
  );
});
