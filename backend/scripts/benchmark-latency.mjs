import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { MemoryRepository } from "../test/support/memoryRepository.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
for (const key of Object.keys(options)) assert.ok(["baseline", "output", "samples", "read-ms", "commit-ms"].includes(key), `Unknown option: ${key}`);
const samples = Number(options.samples || 12), readMs = Number(options["read-ms"] || 3), commitMs = Number(options["commit-ms"] || 15);
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 50, "Use 3–50 samples.");
assert.ok(Number.isFinite(readMs) && readMs > 0 && readMs <= 50);
assert.ok(Number.isFinite(commitMs) && commitMs > 0 && commitMs <= 100);
process.env.PERFORMANCE_LOG_SAMPLE_RATE = "0";
process.env.PERFORMANCE_SLOW_MS = "60000";

// One delay represents one SDK call, including BatchGet. Synthetic test data
// stays in memory; this script never connects to AWS or authenticates a user.
class DelayedRepository extends MemoryRepository {
  constructor() { super(); this.enabled = false; this.reset(); }
  reset() { this.counts = { get: 0, batchGet: 0, query: 0, commit: 0, keysRead: 0 }; }
  async get(...args) {
    if (this.enabled) { this.counts.get++; this.counts.keysRead++; await wait(readMs); }
    return super.get(...args);
  }
  async many(table, keys) {
    if (!keys.length) return [];
    if (this.enabled) { this.counts.batchGet++; this.counts.keysRead += keys.length; await wait(readMs); }
    return (await Promise.all(keys.map(key => super.get(table, key)))).filter(Boolean);
  }
  async query(...args) {
    if (this.enabled) { this.counts.query++; await wait(readMs); }
    return super.query(...args);
  }
  async transact(...args) {
    if (this.enabled) { this.counts.commit++; await wait(commitMs); }
    return super.transact(...args);
  }
}

const user = index => ({ uid: `benchmark-user-${index}`, name: `Benchmark User ${index}`, email: `benchmark-${index}@example.invalid` });
const event = (path, auth, method = "GET", body, id = "benchmark-request-0001", query = {}) => ({
  rawPath: path, requestContext: { http: { method } }, queryStringParameters: query,
  headers: { "idempotency-key": id }, body: body === undefined ? undefined : JSON.stringify(body),
  benchmarkAuth: auth,
});
const transaction = (title, amount = 10) => ({ title, amount, type: "income", category: "Other", date: "2026-11-24", upiAccountId: "account", durableRetry: true });

async function run(source, label) {
  const { createHandler } = await import(pathToFileURL(path.join(source, "core/handler.js")));
  const { SplitTrackService } = await import(pathToFileURL(path.join(source, "core/service.js")));
  const repo = new DelayedRepository(), service = new SplitTrackService(repo);
  const users = Array.from({ length: 20 }, (_, index) => user(index));
  for (const auth of users) {
    await service.updateProfile(auth, "benchmark-profile-0001", { displayName: auth.name, username: `benchmark_user_${auth.uid.split("-").at(-1)}` });
    await service.saveEntity(auth, "benchmark-account-0001", "accounts", "account", { title: "Test", kind: "upi", provider: "bank", upiId: "benchmark@bank" });
  }
  await service.saveEntity(users[0], "benchmark-friend-0001", "friends", users[1].uid, {});
  const handle = createHandler(service, async request => request.benchmarkAuth, repo, async () => {});
  repo.enabled = true;
  const rows = [];
  async function benchmark(name, execute, requestsPerSample = 1) {
    repo.reset();
    const durations = [];
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      const result = await execute(index);
      const responses = Array.isArray(result) ? result : [result];
      for (const response of responses) assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${name}: ${response.body}`);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const percentile = ratio => Number(durations[Math.max(0, Math.ceil(samples * ratio) - 1)].toFixed(2));
    rows.push({ name, samples, requestsPerSample, p50Ms: percentile(0.5), p95Ms: percentile(0.95), callsPerRequest: Object.fromEntries(Object.entries(repo.counts).map(([key, count]) => [key, Number((count / samples / requestsPerSample).toFixed(2))])) });
  }
  const revision = (await repo.get("ledger", { ledgerId: users[0].uid, recordId: "STATE" })).revision;
  await benchmark("unchanged-sync", () => handle(event("/state", users[0], "GET", undefined, undefined, { after: String(revision) })));
  await benchmark("full-snapshot", () => handle(event("/state", users[0])));
  await benchmark("own-income", index => handle(event("/transactions", users[0], "POST", transaction(`Income ${index}`), `benchmark-income-${String(index).padStart(4, "0")}`)));
  await benchmark("shared-expense", index => handle(event("/transactions", users[0], "POST", {
    ...transaction(`Shared ${index}`, 20), type: "expense", paidBy: "user", splitType: "equal",
    splits: [{ friendId: "user", paidAmount: 20 }, { friendId: users[1].uid, paidAmount: 0 }],
  }, `benchmark-shared-${String(index).padStart(4, "0")}`)));
  await benchmark("ten-entry-import", index => handle(event("/transactions/batch", users[0], "POST", {
    transactions: Array.from({ length: 10 }, (_, entry) => transaction(`Import ${index} ${entry}`, entry + 1)),
  }, `benchmark-import-${String(index).padStart(4, "0")}`)));
  await benchmark("twenty-concurrent-snapshots", () => Promise.all(users.map(auth => handle(event("/state", auth)))), 20);
  const final = await service.snapshot(users[0].uid);
  assert.equal(final.summary.totalIncome, samples * 65);
  assert.equal(final.transactions.length, 50);
  return { label, rows };
}

const report = {
  experiment: "Synthetic repository-delay benchmark; these are not AWS latency or load-capacity measurements.",
  createdAt: new Date().toISOString(), readDelayMs: readMs, atomicCommitDelayMs: commitMs,
  baseline: options.baseline ? await run(path.resolve(root, options.baseline), "baseline") : undefined,
  optimized: await run(path.join(root, "src"), "optimized"),
};
if (report.baseline) report.comparison = report.optimized.rows.map((row, index) => ({
  scenario: row.name, baselineP50Ms: report.baseline.rows[index].p50Ms, optimizedP50Ms: row.p50Ms,
  reductionPercent: Number((100 * (1 - row.p50Ms / report.baseline.rows[index].p50Ms)).toFixed(1)),
  baselineCalls: report.baseline.rows[index].callsPerRequest, optimizedCalls: row.callsPerRequest,
}));
if (options.output) {
  const output = path.resolve(root, options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report.comparison || report.optimized.rows, null, 2));
