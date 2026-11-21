import test from "node:test";
import assert from "node:assert/strict";
import { SplitTrackService } from "../src/core/service.js";
import { createHandler } from "../src/core/handler.js";
import { MemoryRepository } from "./support/memoryRepository.js";

const alice = { uid: "duplicateAlice", name: "Alice", email: "alice@example.invalid" };
const bob = { uid: "duplicateBob", name: "Bob", email: "bob@example.invalid" };
const carol = { uid: "duplicateCarol", name: "Carol", email: "carol@example.invalid" };
let sequence = 0;
const request = () => `duplicate_test_${++sequence}`;
const expense = {
  title: "Dinner", type: "expense", amount: -70.3, paidBy: "user", date: "2026-11-18",
  splitType: "equal", splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: bob.uid }],
  duplicateCheck: true, ledgerGeneration: 0,
};
async function setup() {
  const repo = new MemoryRepository(), app = new SplitTrackService(repo);
  for (const user of [alice, bob, carol]) {
    await app.bootstrap(user);
    await app.updateProfile(user, request(), { displayName: user.name, username: user.uid.toLowerCase() });
    await app.saveEntity(user, request(), "accounts", `account-${user.uid}`, { title: "UPI", kind: "upi", upiId: `${user.uid.toLowerCase()}@okaxis`, isDefault: true });
  }
  await app.saveEntity(alice, request(), "friends", bob.uid, { userId: bob.uid });
  await app.saveEntity(alice, request(), "friends", carol.uid, { userId: carol.uid });
  return { repo, app };
}
test("independent expenses with equal amounts, payers and participants are all accepted", async () => {
  const { repo, app } = await setup();
  const first = await app.transaction(alice, request(), expense);
  const second = await app.transaction(alice, request(), { ...expense, title: "Different dinner", date: "2026-11-19", splits: [...expense.splits].reverse() });
  const third = await app.transaction(alice, request(), expense);
  assert.equal(new Set([first.result.id, second.result.id, third.result.id]).size, 3);
  assert.equal(third.state.transactions.length, 3);
  assert.equal(third.state.accounts[0].totalSpent, 210.9);
  assert.equal(third.state.friends.find(friend => friend.id === bob.uid).netBalance, 105.45);
  assert.equal([...repo.rows.values()].filter(row => row.ledgerId?.startsWith("DUPLICATE#") || row.recordId?.startsWith("DUPLICATE_INDEX")).length, 0);
});

test("equal expenses in the same trip or with the same members in different trips remain separate", async () => {
  const { app } = await setup();
  for (const id of ["first-group", "second-group"]) await app.saveEntity(alice, request(), "trips", id, { name: id, members: ["user", bob.uid, carol.uid] });
  await app.transaction(alice, request(), { ...expense, tripId: "first-group" });
  await app.transaction(alice, request(), { ...expense, tripId: "first-group", splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: carol.uid }] });
  const result = await app.transaction(alice, request(), { ...expense, tripId: "second-group" });
  assert.equal(result.state.transactions.length, 3);
  assert.equal(result.state.trips.find(trip => trip.id === "first-group").totalSpend, 140.6);
});

test("concurrent independent keys succeed while concurrent retries write financial effects once", async () => {
  const { app } = await setup();
  const results = await Promise.all([app.transaction(alice, request(), expense), app.transaction(alice, request(), expense)]);
  assert.notEqual(results[0].result.id, results[1].result.id);
  const key = request(), input = { ...expense, durableRetry: true };
  const repeated = await Promise.all([app.transaction(alice, key, input), app.transaction(alice, key, input)]);
  assert.equal(repeated[0].result.id, repeated[1].result.id);
  assert.equal((await app.snapshot(alice.uid)).accounts[0].totalSpent, 210.9);
  await assert.rejects(app.transaction(alice, key, { ...input, amount: -99 }), error => error.code === "IDEMPOTENCY_CONFLICT");
});

for (const durableOption of ["durableRetry", "duplicateCheck"]) test(`${durableOption} requests survive uncertain replies, marker expiry, deletion and ledger reset`, async () => {
  const { repo, app } = await setup();
  const input = { ...expense }; delete input.duplicateCheck; input[durableOption] = true;
  const key = request(), created = await app.transaction(alice, key, input);
  assert.equal(created.state.transactions[0].clientRequestId, key);
  const markerKey = { ledgerId: alice.uid, recordId: `REQUEST#${key}` };
  assert.equal((await repo.get("ledger", markerKey)).expiresAt, undefined);
  repo.rows.delete(repo.key("ledger", markerKey));
  const replay = await app.transaction(alice, key, input);
  assert.equal(replay.result.id, created.result.id);
  assert.equal(replay.state.accounts[0].totalSpent, 70.3);
  await assert.rejects(app.transaction(alice, key, { ...input, title: "Changed payload" }), error => error.code === "IDEMPOTENCY_CONFLICT");
  await app.deleteTransaction(alice, request(), created.result.id);
  await app.transaction(alice, key, input);
  assert.equal((await app.snapshot(alice.uid)).transactions.length, 0);
  await app.erase(alice, request());
  const erasedReplay = await app.transaction(alice, key, input);
  assert.equal(erasedReplay.result.id, created.result.id);
  assert.equal(erasedReplay.state.transactions.length, 0);
  await assert.rejects(app.transaction(alice, request(), input), error => error.code === "LEDGER_GENERATION_CHANGED");
});

test("API accepts legacy duplicate flags without warnings or content-based conflicts", async () => {
  const { repo, app } = await setup();
  await app.transaction(alice, request(), expense);
  const handler = createHandler(app, async () => alice, repo);
  const response = await handler({ rawPath: "/transactions", requestContext: { http: { method: "POST" } }, headers: { "idempotency-key": request() }, body: JSON.stringify(expense) });
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).state.transactions.length, 2);
  const legacy = { ...expense }; delete legacy.duplicateCheck;
  const old = await app.transaction(alice, request(), legacy);
  assert.equal(old.state.transactions.length, 3);
});

test("new saves do not backfill legacy history or read, write and lock retired matching scopes", async () => {
  const { repo, app } = await setup();
  const legacyKey = { ledgerId: "DUPLICATE#old-content-hash", recordId: "TX#old-entry" };
  await repo.transact([{ type: "put", table: "ledger", item: { ...legacyKey, id: "old-entry" } }]);
  const read = repo.get.bind(repo), query = repo.query.bind(repo), transact = repo.transact.bind(repo);
  repo.get = async (table, key) => { assert.ok(!key.ledgerId?.startsWith("DUPLICATE#")); assert.ok(!key.recordId?.startsWith("DUPLICATE_INDEX")); return read(table, key); };
  repo.query = async (table, partition, value, options) => { assert.ok(!String(value).startsWith("DUPLICATE#")); return query(table, partition, value, options); };
  repo.transact = async actions => { assert.ok(!actions.some(action => action.item?.ledgerId?.startsWith("DUPLICATE#") || action.item?.recordId?.startsWith("DUPLICATE_INDEX"))); return transact(actions); };
  const created = await app.transaction(alice, request(), { ...expense, durableRetry: true });
  assert.equal(created.state.transactions.length, 1);
  assert.equal((await read("ledger", legacyKey)).id, "old-entry", "retired unrelated data is inert; no unbounded migration on the write path");
});

test("editing and deleting old journals remove stored retired index pointers without recreating them on restore", async () => {
  const { repo, app } = await setup();
  const created = await app.transaction(alice, request(), expense);
  const journalKey = { ledgerId: `JOURNAL#${created.result.id}`, recordId: "STATE" };
  const legacyKey = { ledgerId: "DUPLICATE#old-content-hash", recordId: `TX#${created.result.id}` };
  async function seedLegacy() {
    const journal = await repo.get("ledger", journalKey);
    await repo.transact([{ type: "put", table: "ledger", item: { ...journal, duplicateKeys: [legacyKey], duplicateParticipantIds: [alice.uid, bob.uid] } }, { type: "put", table: "ledger", item: { ...legacyKey, id: created.result.id } }]);
  }
  await seedLegacy();
  await app.editTransaction(alice, request(), created.result.id, { title: "Edited dinner" });
  assert.equal(await repo.get("ledger", legacyKey), undefined);
  assert.equal((await repo.get("ledger", journalKey)).duplicateKeys, undefined);
  await seedLegacy();
  await app.deleteTransaction(alice, request(), created.result.id);
  assert.equal(await repo.get("ledger", legacyKey), undefined);
  await app.restoreTransaction(alice, request(), created.result.id);
  assert.equal(await repo.get("ledger", legacyKey), undefined);
  assert.equal((await repo.get("ledger", journalKey)).duplicateKeys, undefined);
  assert.equal((await app.snapshot(alice.uid)).accounts[0].totalSpent, 70.3);
});

test("bulk transaction cleanup stays within DynamoDB's atomic action limit", async () => {
  const { repo, app } = await setup();
  for (let index = 0; index < 25; index++) await app.transaction(alice, request(), {
    title: `Private expense ${index}`, type: "expense", amount: index + 1,
    durableRetry: true, ledgerGeneration: 0,
  });
  const transact = repo.transact.bind(repo);
  repo.transact = async actions => { assert.ok(actions.length <= 100); return transact(actions); };
  const result = await app.erase(alice, request());
  assert.equal(result.result.erased, true);
  assert.equal(result.state.transactions.length, 0);
});
