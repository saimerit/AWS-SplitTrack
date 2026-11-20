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
const isDuplicate = error => error.code === "DUPLICATE_TRANSACTION" && error.status === 409;
function removeDuplicateIndex(repo) {
  for (const [key, row] of repo.rows) if (key.startsWith("ledger:") && (row.ledgerId.startsWith("DUPLICATE#") || row.recordId.startsWith("DUPLICATE_INDEX"))) repo.rows.delete(key);
}

test("duplicate warning compares paise, canonical payer and unordered participants without changing finances", async () => {
  const { repo, app } = await setup();
  const created = await app.transaction(alice, request(), expense);
  const key = request();
  await assert.rejects(app.transaction(alice, key, { ...expense, title: "Different title", date: "2026-11-19", splits: [...expense.splits].reverse() }), error => {
    assert.ok(isDuplicate(error));
    assert.equal(error.details.existingTransaction.id, created.result.id);
    assert.equal(error.details.existingTransaction.paidBy, "user");
    assert.equal(error.details.existingTransaction.splits[0].friendId, "user");
    return true;
  });
  const after = await app.snapshot(alice.uid);
  assert.equal(after.revision, created.state.revision);
  assert.equal(after.accounts[0].totalSpent, 70.3);
  assert.equal(await repo.get("ledger", { ledgerId: alice.uid, recordId: `REQUEST#${key}` }), undefined);
  const allowed = await app.transaction(alice, request(), { ...expense, confirmDuplicate: true });
  assert.equal(allowed.state.transactions.length, 2);
  assert.equal(allowed.state.accounts[0].totalSpent, 140.6);
  const changedAmount = { ...expense, amount: -70.31, splits: [{ friendId: "user", paidAmount: 70.31 }, { friendId: bob.uid }] };
  await app.transaction(alice, request(), changedAmount);
  await app.transaction(alice, request(), { ...expense, paidBy: bob.uid, splits: [{ friendId: "user" }, { friendId: bob.uid, paidAmount: 70.3 }] });
  await app.transaction(alice, request(), { ...expense, splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: carol.uid }] });
});

test("duplicates match either the same group or the same people across groups", async () => {
  const { app } = await setup();
  for (const id of ["first-group", "second-group"]) await app.saveEntity(alice, request(), "trips", id, { name: id, members: ["user", bob.uid, carol.uid] });
  await app.transaction(alice, request(), { ...expense, tripId: "first-group" });
  await assert.rejects(app.transaction(alice, request(), { ...expense, tripId: "first-group", splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: carol.uid }] }), isDuplicate);
  await assert.rejects(app.transaction(alice, request(), { ...expense, tripId: "second-group" }), isDuplicate);
  // Bob can see the canonical group transaction although he was not a split
  // participant in the next expense; group warnings remain privacy scoped.
  await app.transaction(alice, request(), { ...expense, tripId: "first-group", amount: -80, splits: [{ friendId: "user", paidAmount: 80 }, { friendId: carol.uid }] });
  await assert.rejects(app.transaction(bob, request(), { ...expense, amount: -80, paidBy: alice.uid, tripId: "first-group", splits: [{ friendId: alice.uid, paidAmount: 80 }, { friendId: "user" }] }), isDuplicate);
});

test("concurrent checked submissions record once and deliberate overrides retain retry safety", async () => {
  const { app } = await setup();
  const results = await Promise.allSettled([app.transaction(alice, request(), expense), app.transaction(alice, request(), expense)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(isDuplicate(results.find(result => result.status === "rejected").reason));
  assert.equal((await app.snapshot(alice.uid)).accounts[0].totalSpent, 70.3);
  const key = request(), input = { ...expense, confirmDuplicate: true };
  const repeated = await Promise.all([app.transaction(alice, key, input), app.transaction(alice, key, input)]);
  assert.equal(repeated[0].result.id, repeated[1].result.id);
  assert.equal((await app.snapshot(alice.uid)).accounts[0].totalSpent, 140.6);
});

test("legacy history is indexed once and deleted or edited entries do not cause stale warnings", async () => {
  const { repo, app } = await setup();
  const legacy = { ...expense }; delete legacy.duplicateCheck;
  const created = await app.transaction(alice, request(), legacy);
  removeDuplicateIndex(repo);
  await assert.rejects(app.transaction(alice, request(), expense), isDuplicate);
  await app.editTransaction(alice, request(), created.result.id, { amount: -90, splits: [{ friendId: "user", paidAmount: 90 }, { friendId: bob.uid }] });
  const next = await app.transaction(alice, request(), expense);
  await app.deleteTransaction(alice, request(), next.result.id);
  const afterDelete = await app.transaction(alice, request(), expense);
  assert.ok(afterDelete.result.id);
  await app.restoreTransaction(alice, request(), next.result.id);
  await assert.rejects(app.transaction(alice, request(), expense), isDuplicate);
  const before = repo.queryReads;
  await assert.rejects(app.transaction(alice, request(), expense), isDuplicate);
  assert.equal(repo.queryReads - before, 1, "indexed duplicates require no history query");
});

test("durable Android requests survive uncertain replies, expiry, deletion and ledger reset", async () => {
  const { repo, app } = await setup();
  const key = request(), created = await app.transaction(alice, key, expense);
  assert.equal(created.state.transactions[0].clientRequestId, key);
  const markerKey = { ledgerId: alice.uid, recordId: `REQUEST#${key}` };
  assert.equal((await repo.get("ledger", markerKey)).expiresAt, undefined);
  // Journal fallback also protects older requests if their short-lived marker
  // has already been removed by DynamoDB TTL.
  repo.rows.delete(repo.key("ledger", markerKey));
  const replay = await app.transaction(alice, key, expense);
  assert.equal(replay.result.id, created.result.id);
  assert.equal(replay.state.accounts[0].totalSpent, 70.3);
  await assert.rejects(app.transaction(alice, key, { ...expense, title: "Changed payload" }), error => error.code === "IDEMPOTENCY_CONFLICT");
  await app.deleteTransaction(alice, request(), created.result.id);
  await app.transaction(alice, key, expense);
  assert.equal((await app.snapshot(alice.uid)).transactions.length, 0);
  await app.erase(alice, request());
  const erasedReplay = await app.transaction(alice, key, expense);
  assert.equal(erasedReplay.result.id, created.result.id);
  assert.equal(erasedReplay.state.transactions.length, 0);
  await assert.rejects(app.transaction(alice, request(), expense), error => error.code === "LEDGER_GENERATION_CHANGED");
});

test("duplicate errors expose caller-visible details through the API and legacy clients keep their behavior", async () => {
  const { repo, app } = await setup();
  await app.transaction(alice, request(), expense);
  const handler = createHandler(app, async () => alice, repo);
  const response = await handler({ rawPath: "/transactions", requestContext: { http: { method: "POST" } }, headers: { "idempotency-key": request() }, body: JSON.stringify(expense) });
  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  assert.equal(body.code, "DUPLICATE_TRANSACTION");
  assert.equal(body.details.existingTransaction.title, "Dinner");
  assert.equal(body.details.existingTransaction.paidBy, "user");
  const legacy = { ...expense }; delete legacy.duplicateCheck;
  await app.transaction(alice, request(), legacy);
  assert.equal((await app.snapshot(alice.uid)).transactions.length, 2);
});

test("legacy backfill resumes after interruption and finds older history beyond the first page", async () => {
  const { repo, app } = await setup();
  const legacy = { ...expense }; delete legacy.duplicateCheck;
  await app.transaction(alice, request(), legacy);
  for (let index = 0; index < 45; index++) await app.transaction(alice, request(), {
    title: `Later income ${index}`, type: "income", amount: index + 1, date: "2026-11-19",
  });
  removeDuplicateIndex(repo);
  const transact = repo.transact.bind(repo);
  let pages = 0;
  repo.transact = async actions => {
    if (actions.some(action => action.item?.recordId === "DUPLICATE_INDEX#0") && ++pages === 2) throw new Error("Interrupted index migration");
    return transact(actions);
  };
  await assert.rejects(app.transaction(alice, request(), expense), /Interrupted index migration/);
  const progress = await repo.get("ledger", { ledgerId: alice.uid, recordId: "DUPLICATE_INDEX#0" });
  assert.ok(progress.cursor);
  assert.equal(progress.complete, false);
  repo.transact = transact;
  await assert.rejects(app.transaction(alice, request(), expense), isDuplicate);
  assert.equal((await repo.get("ledger", { ledgerId: alice.uid, recordId: "DUPLICATE_INDEX#0" })).complete, true);
});

test("duplicate candidates cannot reveal another user's private or erased history", async () => {
  const { repo, app } = await setup();
  // Deliberately put a misleading ID into Alice's matching hash bucket. The
  // warning still requires a visible projection and matching financial data.
  const created = await app.transaction(alice, request(), expense);
  const ownJournal = await repo.get("ledger", { ledgerId: `JOURNAL#${created.result.id}`, recordId: "STATE" });
  await app.deleteTransaction(alice, request(), created.result.id);
  const privateEntry = await app.transaction(carol, request(), { title: "Private income", type: "income", amount: 70.3 });
  for (const key of ownJournal.duplicateKeys) await repo.transact([{ type: "put", table: "ledger", item: { ...key, recordId: `TX#${privateEntry.result.id}`, id: privateEntry.result.id } }]);
  const visible = await app.transaction(alice, request(), expense);
  assert.equal(visible.state.transactions.length, 1);
  assert.equal(visible.state.transactions[0].title, "Dinner");
  await app.erase(alice, request());
  await app.saveEntity(alice, request(), "accounts", "new-upi", { title: "UPI", kind: "upi", upiId: "new@okaxis", isDefault: true });
  await app.saveEntity(alice, request(), "friends", bob.uid, { userId: bob.uid });
  const next = await app.transaction(alice, request(), { ...expense, ledgerGeneration: 1 });
  assert.equal(next.state.transactions.length, 1);
});

test("indexed transaction cleanup remains within DynamoDB's atomic action limit", async () => {
  const { repo, app } = await setup();
  for (let index = 0; index < 25; index++) await app.transaction(alice, request(), {
    title: `Private expense ${index}`, type: "expense", amount: index + 1,
    duplicateCheck: true, ledgerGeneration: 0,
  });
  const transact = repo.transact.bind(repo);
  repo.transact = async actions => { assert.ok(actions.length <= 100); return transact(actions); };
  const result = await app.erase(alice, request());
  assert.equal(result.result.erased, true);
  assert.equal(result.state.transactions.length, 0);
});
