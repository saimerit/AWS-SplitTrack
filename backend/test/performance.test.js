import test from "node:test";
import assert from "node:assert/strict";
import { RequestRepository } from "../src/core/requestRepository.js";
import { withRequestTiming, measure, databaseCall, routeLabel } from "../src/core/performance.js";
import { SplitTrackService } from "../src/core/service.js";
import { createHandler } from "../src/core/handler.js";
import { MemoryRepository } from "./support/memoryRepository.js";
import { ApiError } from "../src/core/errors.js";

const user = { uid: "performance-user", email: "performance@example.invalid", name: "Performance User" };
const profileKey = uid => ({ userId: `USER#${uid}`, recordId: "PROFILE" });
const event = (path, method = "GET", body, id = "performance-request-0001") => ({
  rawPath: path, requestContext: { http: { method } },
  headers: { "idempotency-key": id }, body: body === undefined ? undefined : JSON.stringify(body),
});
function countedRepository() {
  const repo = new MemoryRepository(), counts = { gets: [], many: [], queries: 0, commits: 0 };
  const get = repo.get.bind(repo), many = repo.many.bind(repo), query = repo.query.bind(repo), transact = repo.transact.bind(repo);
  repo.get = async (table, key) => { counts.gets.push({ table, key }); return get(table, key); };
  repo.many = async (table, keys) => { counts.many.push({ table, keys }); return many(table, keys); };
  repo.query = async (...args) => { counts.queries++; return query(...args); };
  repo.transact = async (...args) => { counts.commits++; return transact(...args); };
  return { repo, counts };
}

test("request reads share pending work, preserve key identity, and never leak into another request", async () => {
  const { repo, counts } = countedRepository();
  await repo.transact([{ type: "put", table: "data", item: { ...profileKey(user.uid), name: "First" } }]);
  const scoped = new RequestRepository(repo), key = profileKey(user.uid);
  const [first, second] = await Promise.all([scoped.get("data", key), scoped.get("data", { recordId: "PROFILE", userId: key.userId })]);
  assert.equal(first.name, "First"); assert.equal(second.name, "First");
  assert.equal(counts.gets.length, 1);
  await repo.transact([{ type: "put", table: "data", item: { ...key, name: "Changed" } }]);
  assert.equal((await new RequestRepository(repo).get("data", key)).name, "Changed");
  assert.equal(await new RequestRepository(repo).get("data", profileKey("someone-else")), undefined);
});

test("overlapping batch reads reuse pending keys and cache missing rows only for the request", async () => {
  const { repo, counts } = countedRepository();
  for (const uid of ["a", "b"]) await repo.transact([{ type: "put", table: "data", item: { ...profileKey(uid), uid } }]);
  const scoped = new RequestRepository(repo);
  const [a, b, absent] = await Promise.all([
    scoped.many("data", [profileKey("a"), profileKey("b")]),
    scoped.many("data", [profileKey("b"), profileKey("missing")]),
    scoped.get("data", profileKey("missing")),
  ]);
  assert.deepEqual(a.map(row => row.uid).sort(), ["a", "b"]);
  assert.deepEqual(b.map(row => row.uid), ["b"]); assert.equal(absent, undefined);
  assert.equal(counts.gets.filter(row => row.key.userId === "USER#b").length, 1);
  assert.equal(counts.gets.filter(row => row.key.userId === "USER#missing").length, 1);
});

test("both successful and failed transactions invalidate the request read set", async () => {
  const { repo } = countedRepository(), key = profileKey(user.uid), scoped = new RequestRepository(repo);
  await scoped.transact([{ type: "put", table: "data", item: { ...key, name: "First" } }]);
  assert.equal((await scoped.get("data", key)).name, "First");
  await scoped.transact([{ type: "put", table: "data", item: { ...key, name: "Second" } }]);
  assert.equal((await scoped.get("data", key)).name, "Second");
  repo.failNext = true;
  await assert.rejects(scoped.transact([{ type: "put", table: "data", item: { ...key, name: "Not saved" } }]), /Injected/);
  await repo.transact([{ type: "put", table: "data", item: { ...key, name: "Other device" } }]);
  assert.equal((await scoped.get("data", key)).name, "Other device");
});

test("state bootstrap and snapshot share the profile read without persisting it across requests", async () => {
  const { repo, counts } = countedRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user); counts.gets.length = 0;
  const handle = createHandler(service, async () => user, repo);
  const first = await handle(event("/state"));
  assert.equal(JSON.parse(first.body).profile.name, user.name);
  assert.equal(counts.gets.filter(row => row.key.userId === `USER#${user.uid}`).length, 1);
  await repo.transact([{ type: "put", table: "data", item: { ...(await repo.get("data", profileKey(user.uid))), name: "Updated elsewhere" } }]);
  assert.equal(JSON.parse((await handle(event("/state"))).body).profile.name, "Updated elsewhere");
});

test("an optimized profile mutation immediately returns its newly committed profile", async () => {
  const { repo } = countedRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user);
  const handle = createHandler(service, async () => user, repo);
  const result = await handle(event("/api/profile", "PUT", { displayName: "New Name", username: "performance_user" }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).state.profile.name, "New Name");
  assert.equal(JSON.parse(result.body).state.profile.handle, "@performance_user");
});

test("an update cannot overwrite a newer profile using a bootstrap read from before its revision", async () => {
  const repo = new MemoryRepository(), service = new SplitTrackService(repo);
  await service.updateProfile(user, "profile-before-race-0001", { displayName: user.name, username: "performance_user" });
  const get = repo.get.bind(repo);
  let racing = true;
  repo.get = async (table, key) => {
    if (racing && table === "ledger" && key.ledgerId === user.uid && key.recordId === "STATE") {
      racing = false;
      await service.updateProfile(user, "profile-other-device-0001", { displayName: "Other Device", username: "changed_username", avatarRef: "cartoon:test" });
    }
    return get(table, key);
  };
  const result = await createHandler(service, async () => user, repo)(
    event("/api/profile", "PUT", { displayName: "Requested Name" }, "profile-current-device-0001"),
  );
  assert.equal(result.statusCode, 200);
  const saved = await get("data", profileKey(user.uid));
  assert.equal(saved.name, "Requested Name");
  assert.equal(saved.username, "changed_username");
  assert.equal(saved.avatarRef, "cartoon:test");
  assert.equal(JSON.parse(result.body).state.profile.handle, "@changed_username");
});

test("full state reads the revision before the profile so concurrent profile changes remain discoverable", async () => {
  const repo = new MemoryRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user);
  const get = repo.get.bind(repo);
  let stateRead = false, racing = true;
  repo.get = async (table, key) => {
    if (table === "ledger" && key.ledgerId === user.uid && key.recordId === "STATE") stateRead = true;
    if (racing && table === "data" && key.userId === `USER#${user.uid}`) {
      racing = false;
      assert.ok(stateRead);
      await service.updateProfile(user, "state-other-profile-0001", { displayName: "Other Device", username: "changed_username" });
    }
    return get(table, key);
  };
  const handle = createHandler(service, async () => user, repo);
  const state = JSON.parse((await handle(event("/state"))).body);
  assert.equal(state.profile.name, "Other Device");
  const syncEvent = event("/state");
  syncEvent.queryStringParameters = { after: String(state.revision) };
  assert.equal(JSON.parse((await handle(syncEvent)).body).changed, true);
});

test("conflict retries reload profile and revisions after another device changes them", async () => {
  const repo = new MemoryRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user);
  const transact = repo.transact.bind(repo);
  let first = true;
  repo.transact = async actions => {
    if (first) {
      first = false;
      const profile = await repo.get("data", profileKey(user.uid));
      await transact([{ type: "put", table: "data", item: { ...profile, name: "Other device" } }]);
      throw Object.assign(new Error("Concurrent update"), { name: "TransactionConflictException" });
    }
    return transact(actions);
  };
  const handle = createHandler(service, async () => user, repo);
  const result = await handle(event("/api/settings", "PUT", { themeMode: "light" }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).state.profile.name, "Other device");
  assert.equal(JSON.parse(result.body).state.settings.themeMode, "light");
});

test("a retry marker observed after a parallel old state read returns the committed revision", async () => {
  const repo = new MemoryRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user);
  const markerId = "performance-race-0001", get = repo.get.bind(repo);
  let racing = true;
  repo.get = async (table, key) => {
    if (racing && table === "ledger" && key.recordId === `REQUEST#${markerId}`) {
      racing = false;
      // Another device commits between this request's state and marker reads.
      await Promise.resolve();
      await service.settings(user, markerId, { themeMode: "light" });
    }
    return get(table, key);
  };
  const result = await createHandler(service, async () => user, repo)(
    event("/api/settings", "PUT", { themeMode: "light" }, markerId),
  );
  assert.equal(result.statusCode, 200);
  const state = JSON.parse(result.body).state;
  assert.equal(state.settings.themeMode, "light");
  assert.equal(state.revision, (await get("ledger", { ledgerId: user.uid, recordId: "STATE" })).revision);
});

test("batch imports build one response snapshot and remain exactly once on retry", async () => {
  const { repo, counts } = countedRepository(), service = new SplitTrackService(repo);
  await service.bootstrap(user);
  await service.updateProfile(user, "performance-profile-0001", { displayName: user.name, username: "performance_user" });
  await service.saveEntity(user, "performance-account-0001", "accounts", "account", { title: "Test", kind: "upi", provider: "bank", upiId: "performance@bank" });
  counts.queries = 0;
  const handle = createHandler(service, async () => user, repo);
  const body = { transactions: [1, 2, 3].map(value => ({ title: `Entry ${value}`, amount: value, type: "income", category: "Other", date: "2026-11-24", upiAccountId: "account", durableRetry: true })) };
  const first = await handle(event("/transactions/batch", "POST", body));
  assert.equal(first.statusCode, 201);
  assert.equal(JSON.parse(first.body).state.transactions.length, 3);
  assert.equal(counts.queries, 1);
  const retry = await handle(event("/transactions/batch", "POST", body));
  assert.equal(retry.statusCode, 201);
  assert.equal(JSON.parse(retry.body).state.transactions.length, 3);
  assert.equal(JSON.parse(retry.body).state.summary.totalIncome, 6);
});

test("retrying an interrupted batch keeps committed entries and imports only the remainder", async () => {
  const { repo, counts } = countedRepository(), service = new SplitTrackService(repo);
  await service.updateProfile(user, "interrupted-profile-0001", { displayName: user.name, username: "performance_user" });
  await service.saveEntity(user, "interrupted-account-0001", "accounts", "account", { title: "Test", kind: "upi", provider: "bank", upiId: "performance@bank" });
  const handle = createHandler(service, async () => user, repo), transact = repo.transact.bind(repo);
  let fail = true;
  repo.transact = async actions => {
    if (fail && actions.some(action => action.item?.recordId === "REQUEST#interrupted-import-0001_1")) {
      fail = false;
      throw new ApiError(503, "Injected interrupted import", "TEST_UNAVAILABLE");
    }
    return transact(actions);
  };
  const body = { transactions: [1, 2, 3].map(value => ({ title: `Entry ${value}`, amount: value, type: "income", category: "Other", date: "2026-11-24", upiAccountId: "account", durableRetry: true })) };
  const request = event("/transactions/batch", "POST", body, "interrupted-import-0001");
  assert.equal((await handle(request)).statusCode, 503);
  assert.equal((await service.snapshot(user.uid)).transactions.length, 1);
  counts.queries = 0;
  const retry = await handle(request);
  assert.equal(retry.statusCode, 201);
  assert.equal(counts.queries, 1);
  assert.equal(JSON.parse(retry.body).state.transactions.length, 3);
  assert.equal(JSON.parse(retry.body).state.summary.totalIncome, 6);
});

test("state work starts before telemetry completes and the response waits for telemetry safely", async () => {
  let resolveTelemetry, telemetryDone = false, stateStarted = false;
  const telemetry = new Promise(resolve => { resolveTelemetry = () => { telemetryDone = true; resolve(); }; });
  const handle = createHandler({
    sync: async () => { stateStarted = true; resolveTelemetry(); return { changed: false, revision: 3 }; },
  }, async () => user, {}, async () => telemetry);
  const request = event("/state"); request.queryStringParameters = { after: "3" };
  const response = await handle(request);
  assert.ok(stateStarted && telemetryDone);
  assert.deepEqual(JSON.parse(response.body), { changed: false, revision: 3 });
});

test("route timings contain phases and retry counts without user identifiers or payloads", async () => {
  const output = [];
  const handle = withRequestTiming(async () => {
    await measure("auth", async () => {});
    await databaseCall(async () => ({ $metadata: { attempts: 3 } }));
    return { statusCode: 200, body: "secret content" };
  }, { logger: line => output.push(line), sampleRate: 1 });
  await handle({ ...event("/entities/friends/private-user-123?email=hidden"), headers: { authorization: "secret token" }, body: "private financial data" }, { awsRequestId: "test-lambda-request-id" });
  const record = JSON.parse(output[0]);
  assert.equal(record.route, "/entities/friends/:id");
  assert.equal(record.phases.database.retries, 2);
  assert.equal(record.phases.auth.calls, 1);
  assert.equal(record.requestId, "test-lambda-request-id");
  for (const secret of ["private-user", "secret", "financial", "hidden"]) assert.ok(!output[0].includes(secret));
  assert.equal(routeLabel(event("/arbitrary/private-path")), "unknown");
});

test("overlapping requests retain independent timing contexts and logging failure preserves responses", async () => {
  const output = [];
  const handle = withRequestTiming(async request => {
    await measure(request.rawPath === "/state" ? "snapshot" : "commit", async () => {});
    return { statusCode: 200 };
  }, { logger: line => output.push(JSON.parse(line)), sampleRate: 1 });
  await Promise.all([handle(event("/state")), handle(event("/transactions"))]);
  assert.deepEqual(Object.keys(output.find(row => row.route === "/state").phases), ["snapshot"]);
  assert.deepEqual(Object.keys(output.find(row => row.route === "/transactions").phases), ["commit"]);
  assert.equal((await withRequestTiming(async () => ({ statusCode: 200 }), { logger() { throw new Error("log unavailable"); }, sampleRate: 1 })(event("/state"))).statusCode, 200);
});
