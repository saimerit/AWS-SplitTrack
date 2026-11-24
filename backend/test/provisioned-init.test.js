import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("provisioned initialization prepares the signing cache used by the first authenticated request", async () => {
  const code = `
    import assert from "node:assert/strict";
    import { generateKeyPairSync, sign } from "node:crypto";
    import { repository } from "./src/core/awsRepository.js";
    process.env.AWS_LAMBDA_INITIALIZATION_TYPE = "provisioned-concurrency";
    process.env.FIREBASE_PROJECT_ID = "provisioned-test";
    process.env.PERFORMANCE_LOG_SAMPLE_RATE = "0";
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let fetches = 0, databaseReads = 0;
    globalThis.fetch = async () => {
      fetches++;
      return { ok: true, headers: new Headers({ "cache-control": "max-age=3600" }), json: async () => ({ test: publicKey.export({ type: "spki", format: "pem" }) }) };
    };
    repository.client.send = async command => {
      databaseReads++;
      assert.deepEqual(command.input.Key, { userId: "WARMUP#connection", recordId: "NOT_FOUND" });
      assert.equal(command.input.ConsistentRead, true);
      return {};
    };
    const { handler } = await import("./src/core/handler.js");
    assert.equal(fetches, 1);
    assert.equal(databaseReads, 1);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ aud: "provisioned-test", iss: "https://securetoken.google.com/provisioned-test", sub: "synthetic-user", iat: now, auth_time: now, exp: now + 3600 })).toString("base64url");
    const token = header + "." + payload + "." + sign("RSA-SHA256", Buffer.from(header + "." + payload), privateKey).toString("base64url");
    const response = await handler({ rawPath: "/state", requestContext: { http: { method: "PUT" } }, headers: { authorization: "Bearer " + token }, body: "{}" });
    assert.equal(response.statusCode, 405);
    assert.equal(fetches, 1);
    assert.equal(databaseReads, 1);
    console.log("Shared provisioned initialization passed.");
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000 });
  assert.match(stdout, /Shared provisioned initialization passed/);
});
