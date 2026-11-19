import test from "node:test";
import assert from "node:assert/strict";
import { SplitTrackService } from "../src/core/service.js";
import { createHandler } from "../src/core/handler.js";
import { ApiError } from "../src/core/errors.js";
import { expenseShares, amount, pairId } from "../src/core/money.js";
import { MemoryRepository } from "./support/memoryRepository.js";

const alice = {
    uid: "aliceTestUid",
    email: "alice@example.invalid",
    name: "Alex Lee",
  },
  bob = { uid: "bobTestUid", email: "bob@example.invalid", name: "Alex Zhao" };
let sequence = 0;
const request = () => `request_test_${++sequence}`;
async function setup() {
  const repo = new MemoryRepository(),
    app = new SplitTrackService(repo);
  for (const [user, handle] of [
    [alice, "alex_lee"],
    [bob, "alex_zhao"],
  ]) {
    await app.bootstrap(user);
    await app.updateProfile(user, request(), {
      displayName: user.name,
      username: handle,
    });
    await app.saveEntity(user, request(), "accounts", `account-${user.uid}`, {
      title: "Test UPI",
      kind: "upi",
      provider: "bank",
      upiId: `${handle}@okaxis`,
      isDefault: true,
    });
  }
  await app.saveEntity(alice, request(), "friends", bob.uid, {
    handle: "@alex_zhao",
  });
  return { repo, app };
}
const expense = {
  title: "Shared stay",
  amount: -70.3,
  type: "expense",
  category: "Stay",
  paidBy: "user",
  splitType: "equal",
  splits: [
    { friendId: "user", paidAmount: 70.3 },
    { friendId: bob.uid, paidAmount: 0 },
  ],
  date: "2026-11-18",
};
const balance = (state, uid) =>
  state.friends.find((friend) => friend.id === uid)?.netBalance || 0;

test("new authenticated account starts empty, with category configuration only", async () => {
  const repo = new MemoryRepository(),
    app = new SplitTrackService(repo);
  await app.bootstrap(alice);
  const state = await app.snapshot(alice.uid);
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.friends, []);
  assert.deepEqual(state.trips, []);
  assert.deepEqual(state.transactions, []);
  assert.equal(state.summary.totalExpenses, 0);
  assert.equal(state.categories.length, 9);
});
test("all split modes allocate exact paise and reject invalid totals", () => {
  assert.equal(
    expenseShares(
      {
        amount: 35.15,
        splitType: "equal",
        splits: [{ friendId: "user" }, { friendId: "a" }, { friendId: "b" }],
      },
      alice.uid,
    ).participants.reduce((n, p) => n + p.shareCents, 0),
    3515,
  );
  assert.equal(
    expenseShares(
      {
        amount: 35.15,
        splitType: "percentage",
        splits: [
          { friendId: "user", percentage: 50 },
          { friendId: "a", percentage: 50 },
        ],
      },
      alice.uid,
    ).participants[1].shareCents,
    1757,
  );
  assert.throws(
    () =>
      expenseShares(
        {
          amount: 35.15,
          splitType: "exact",
          splits: [{ friendId: "user", amount: 35.14 }],
        },
        alice.uid,
      ),
    /add up/,
  );
  assert.throws(() => expenseShares({ amount: 35.151 }, alice.uid), /decimal/);
});
test("expense, partial payment and deletion preserve both users and trip totals", async () => {
  const { repo, app } = await setup();
  await app.saveEntity(alice, request(), "trips", "trip-test", {
    name: "Test trip",
    members: ["user", bob.uid],
  });
  const created = await app.transaction(alice, request(), {
    ...expense,
    tripId: "trip-test",
  });
  assert.equal(balance(created.state, bob.uid), 35.15);
  assert.equal(created.state.summary.totalExpenses, 35.15);
  assert.equal(created.state.accounts[0].balance, -70.3);
  assert.equal(created.state.trips[0].totalSpend, 70.3);
  const payment = await app.settle(bob, request(), {
    friendId: alice.uid,
    amount: 30.15,
  });
  assert.equal(balance(payment.state, alice.uid), -5);
  const aliceState = await app.snapshot(alice.uid);
  assert.equal(balance(aliceState, bob.uid), 5);
  assert.equal(aliceState.accounts[0].balance, -40.15);
  assert.equal(
    (await app.getTransaction(alice, created.result.id)).settled,
    false,
  );
  assert.equal(
    (await app.getTransaction(alice, created.result.id)).remainingAmount,
    5,
  );
  await app.deleteTransaction(alice, request(), created.result.id);
  const afterAlice = await app.snapshot(alice.uid),
    afterBob = await app.snapshot(bob.uid);
  assert.equal(balance(afterAlice, bob.uid), -30.15);
  assert.equal(balance(afterBob, alice.uid), 30.15);
  assert.equal(afterAlice.summary.totalExpenses, 0);
  assert.equal(afterBob.summary.totalExpenses, 0);
  assert.equal(afterAlice.trips[0].totalSpend, 0);
  await app.deleteTransaction(bob, request(), payment.result.id);
  assert.equal(balance(await app.snapshot(alice.uid), bob.uid), 0);
  assert.equal(balance(await app.snapshot(bob.uid), alice.uid), 0);
  const pair = await repo.get("ledger", {
    ledgerId: pairId(alice.uid, bob.uid),
    recordId: "STATE",
  });
  assert.equal(
    pair.claims.reduce((n, c) => n + c.remainingCents, 0),
    0,
  );
});
test("concurrent expenses are atomic and repeated requests do not double charge", async () => {
  const { repo, app } = await setup(),
    key = request();
  const first = await app.transaction(alice, key, expense);
  const again = await app.transaction(alice, key, expense);
  assert.equal(first.result.id, again.result.id);
  assert.equal(again.state.accounts[0].totalSpent, 70.3);
  await Promise.all([
    app.transaction(alice, request(), expense),
    app.transaction(alice, request(), expense),
  ]);
  assert.equal((await app.snapshot(alice.uid)).accounts[0].totalSpent, 210.9);
  assert.equal(balance(await app.snapshot(alice.uid), bob.uid), 105.45);
  assert.ok(repo.conflicts > 0);
  await assert.rejects(
    app.transaction(alice, key, { ...expense, amount: -72 }),
    (error) => error.status === 409,
  );
});
test("failed writes commit neither balances nor transaction projections", async () => {
  const { repo, app } = await setup();
  repo.failNext = true;
  await assert.rejects(app.transaction(alice, request(), expense), /Injected/);
  const a = await app.snapshot(alice.uid),
    b = await app.snapshot(bob.uid);
  assert.equal(a.accounts[0].balance, 0);
  assert.equal(a.transactions.length, 0);
  assert.equal(balance(a, bob.uid), 0);
  assert.equal(balance(b, alice.uid), 0);
});
test("name search permits duplicate names and username claims are unique", async () => {
  const { app } = await setup();
  const names = await app.search("Alex", "viewerOther");
  assert.equal(names.length, 2);
  assert.equal((await app.search("@alex_lee", bob.uid)).length, 1);
  await assert.rejects(
    app.updateProfile(bob, request(), {
      displayName: "Name",
      username: "alex_lee",
    }),
    (error) => error.status === 409,
  );
});
test("membership changes remove access without deleting historical debts", async () => {
  const { app } = await setup();
  await app.saveEntity(alice, request(), "trips", "members-test", {
    name: "Members",
    members: ["user", bob.uid],
  });
  const tx = await app.transaction(alice, request(), {
    ...expense,
    tripId: "members-test",
  });
  await assert.rejects(
    app.member(bob, request(), "members-test", alice.uid, true),
    (error) => error.status === 403,
  );
  await app.member(alice, request(), "members-test", bob.uid, true);
  assert.equal((await app.snapshot(bob.uid)).trips.length, 0);
  assert.equal(balance(await app.snapshot(bob.uid), alice.uid), -35.15);
  await assert.rejects(
    app.tripHistory(bob, "members-test", {}),
    (error) => error.status === 404,
  );
  assert.equal((await app.getTransaction(bob, tx.result.id)).id, tx.result.id);
});
test("default receiving UPI stays private and survives selecting a bank card", async () => {
  const { app } = await setup();
  await app.saveEntity(alice, request(), "accounts", "card-test", {
    title: "Card",
    kind: "credit",
    cardNumber: "•••• 1234",
    isDefault: true,
  });
  const profile = await app.profile(alice);
  assert.equal(profile.upiId, "alex_lee@okaxis");
  const result = await app.search("@alex_lee", bob.uid);
  assert.equal(result[0].email, undefined);
  assert.equal(result[0].accounts, undefined);
  await assert.rejects(
    app.saveEntity(alice, request(), "accounts", "full-pan", {
      title: "Bad card",
      kind: "credit",
      cardNumber: "1234567812345678",
    }),
    /last four/,
  );
});
test("fresh start deletes private history and keeps unrelated financial data unchanged", async () => {
  const { app, repo } = await setup();
  const tx = await app.transaction(alice, request(), {
    title: "Income",
    amount: 100,
    type: "income",
    date: "2026-11-18",
  });
  const before = await repo.get("ledger", {
    ledgerId: bob.uid,
    recordId: "STATE",
  });
  await app.erase(alice, request());
  const after = await app.snapshot(alice.uid);
  assert.equal(after.accounts.length, 0);
  assert.equal(after.transactions.length, 0);
  assert.equal(after.summary.totalIncome, 0);
  await assert.rejects(
    app.getTransaction(alice, tx.result.id),
    (error) => error.status === 404,
  );
  assert.deepEqual(
    await repo.get("ledger", { ledgerId: bob.uid, recordId: "STATE" }),
    before,
  );
  assert.equal((await app.snapshot(bob.uid)).friends[0].upiId, undefined);
  assert.equal((await repo.query("transactions", "ledgerId", alice.uid)).items.length, 0);
  assert.equal(await repo.get("data", { userId: alice.uid, recordId: `TX#${tx.result.id}` }), undefined);
  assert.equal(await repo.get("ledger", { ledgerId: `JOURNAL#${tx.result.id}`, recordId: "STATE" }), undefined);
});

test("fresh ledger removes unsettled splits and trips without blocking or replaying", async () => {
  const { repo, app } = await setup();
  await app.settings(alice, request(), { selectionStyle: "dropdown", themeMode: "light" });
  await app.saveEntity(alice, request(), "trips", "fresh-trip", { name: "Test trip", startDate: "2026-11-18", members: ["user", bob.uid], coverGradient: ["#123456", "#654321"] });
  const tx = await app.transaction(alice, request(), { ...expense, tripId: "fresh-trip" });
  await app.settle(bob, request(), { friendId: alice.uid, amount: 10 });
  await app.saveEntity(alice, request(), "templates", "old-template", { name: "Saved expense", amount: 10, transactionType: "expense" });
  const id = request();
  const reset = await app.erase(alice, id);
  assert.equal(reset.result.erased, true);
  assert.equal(reset.result.needsContinue, false);
  assert.deepEqual(reset.state.transactions, []);
  assert.deepEqual(reset.state.friends, []);
  assert.deepEqual(reset.state.trips, []);
  assert.equal(reset.state.settings.selectionStyle, "dropdown");
  assert.equal(reset.state.settings.themeMode, "light");
  assert.equal((await app.snapshot(bob.uid)).friends[0].netBalance, 0);
  assert.deepEqual((await app.snapshot(bob.uid)).trips, []);
  assert.deepEqual((await repo.get("ledger", { ledgerId: pairId(alice.uid, bob.uid), recordId: "STATE" })).claims, []);
  assert.equal((await app.records(alice, "templates")).items.length, 0);
  assert.equal((await repo.query("transactions", "ledgerId", alice.uid)).items.length, 0);
  assert.equal((await repo.query("ledger", "ledgerId", alice.uid, { prefix: "DAY#" })).items.length, 0);
  assert.equal((await repo.get("ledger", { ledgerId: `JOURNAL#${tx.result.id}`, recordId: "STATE" })).participantIds.includes(alice.uid), false);
  const repeated = await app.erase(alice, id);
  assert.equal(repeated.state.generation, reset.state.generation);
  assert.deepEqual(repeated.result, reset.result);
  const next = await app.saveEntity(alice, request(), "accounts", "new-upi", { title: "Fresh UPI", kind: "upi", upiId: "new@okaxis" });
  assert.equal(next.state.accounts.length, 1);
});

test("interrupted ledger cleanup resumes and rejects concurrent shared writes", async () => {
  const { repo, app } = await setup();
  await app.transaction(alice, request(), expense);
  const transact = repo.transact.bind(repo);
  let commits = 0;
  repo.transact = async actions => { if (++commits === 2) throw new Error("Connection interrupted"); return transact(actions); };
  const id = request();
  await assert.rejects(app.erase(alice, id), /Connection interrupted/);
  assert.ok((await repo.get("ledger", { ledgerId: alice.uid, recordId: "STATE" })).resetting);
  await assert.rejects(app.transaction(bob, request(), { ...expense, splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: alice.uid, paidAmount: 0 }] }), error => error.code === "LEDGER_RESETTING");
  repo.transact = transact;
  const resumed = await app.erase(alice, id);
  assert.equal(resumed.result.erased, true);
  assert.equal(resumed.state.generation, 1);
  assert.equal(balance(await app.snapshot(bob.uid), alice.uid), 0);
});

test("sync skips unchanged snapshots and includes both sides of a new split", async () => {
  const { app, repo } = await setup();
  const before = await app.snapshot(bob.uid);
  const reads = repo.queryReads;
  assert.deepEqual(await app.sync(bob.uid, before.revision), { changed: false, revision: before.revision });
  assert.equal(repo.queryReads, reads);
  await app.transaction(alice, request(), expense);
  const changed = await app.sync(bob.uid, before.revision);
  assert.equal(changed.changed, true);
  assert.equal(changed.state.transactions.length, 1);
  assert.equal(changed.state.friends[0].upiId, "alex_lee@okaxis");
  assert.equal(changed.state.friends[0].paymentName, "Test UPI");
  await assert.rejects(app.settings(alice, request(), { selectionStyle: "other" }), /selection style/);
});

test("fresh ledger physically deletes paginated analytics, private journals and archived trip records", async () => {
  const { repo, app } = await setup();
  const ids = [];
  for (let index = 0; index < 125; index++) {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    const result = await app.transaction(alice, request(), { title: `Private entry ${index}`, type: "income", amount: 1, date });
    ids.push(result.result.id);
  }
  await app.saveEntity(alice, request(), "trips", "archived-reset-trip", { name: "Old trip", members: ["user", bob.uid] });
  const shared = await app.transaction(bob, request(), { ...expense, tripId: "archived-reset-trip", splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: alice.uid, paidAmount: 0 }] });
  await app.deleteEntity(alice, request(), "trips", "archived-reset-trip");
  assert.equal((await app.snapshot(alice.uid)).trips.length, 0);
  await app.erase(alice, request());
  for (const id of ids) assert.equal(await repo.get("ledger", { ledgerId: `JOURNAL#${id}`, recordId: "STATE" }), undefined);
  assert.equal((await repo.query("ledger", "ledgerId", `ANALYTICS#${alice.uid}`, { prefix: "DAY#" })).items.length, 0);
  assert.equal((await repo.query("transactions", "ledgerId", alice.uid)).items.length, 0);
  assert.equal((await repo.query("data", "userId", alice.uid, { prefix: "TX#" })).items.length, 0);
  assert.equal(await repo.get("ledger", { ledgerId: "TRIP#archived-reset-trip", recordId: "STATE" }), undefined);
  assert.equal((await repo.query("transactions", "ledgerId", "TRIP#archived-reset-trip")).items.length, 0);
  // The peer can still remove their shared entry after its old trip was purged.
  await app.deleteTransaction(bob, request(), shared.result.id);
  assert.equal((await app.snapshot(bob.uid)).summary.totalExpenses, 0);
  assert.equal(balance(await app.snapshot(bob.uid), alice.uid), 0);
});

test("resetting a joined trip preserves other members and old reversals cannot revive erased debts", async () => {
  const { app, repo } = await setup();
  const charlie = { uid: "charlieTestUid", email: "charlie@example.invalid", name: "Charlie" };
  await app.bootstrap(charlie);
  await app.updateProfile(charlie, request(), { username: "charlie_test", displayName: charlie.name });
  await app.saveEntity(bob, request(), "trips", "joined-reset-trip", { name: "Peer trip", members: ["user", alice.uid, charlie.uid] });
  const shared = await app.transaction(bob, request(), { ...expense, tripId: "joined-reset-trip", splits: [{ friendId: "user", paidAmount: 70.3 }, { friendId: alice.uid, paidAmount: 0 }] });
  await app.erase(alice, request());
  const trip = await repo.get("ledger", { ledgerId: "TRIP#joined-reset-trip", recordId: "STATE" });
  assert.deepEqual(trip.members.sort(), [bob.uid, charlie.uid].sort());
  assert.equal((await app.snapshot(bob.uid)).trips.length, 1);
  assert.equal((await app.snapshot(charlie.uid)).trips.length, 1);
  await app.saveEntity(alice, request(), "accounts", "after-reset", { title: "New UPI", kind: "upi", upiId: "fresh@okaxis" });
  await app.transaction(bob, request(), { ...expense, amount: -20, tripId: "joined-reset-trip", splits: [{ friendId: "user", paidAmount: 20 }, { friendId: charlie.uid, paidAmount: 0 }] });
  await app.transaction(bob, request(), { ...expense, amount: -10, splits: [{ friendId: "user", paidAmount: 10 }, { friendId: alice.uid, paidAmount: 0 }] });
  await app.deleteTransaction(bob, request(), shared.result.id);
  assert.equal(balance(await app.snapshot(alice.uid), bob.uid), -5);
  assert.equal(balance(await app.snapshot(bob.uid), alice.uid), 5);
  assert.equal(balance(await app.snapshot(bob.uid), charlie.uid), 10);
  assert.equal((await repo.get("ledger", { ledgerId: "TRIP#joined-reset-trip", recordId: "STATE" })).totalSpendCents, 2000);
});

test("overlapping and repeated fresh-ledger requests finish once per generation", async () => {
  const { app } = await setup();
  await app.transaction(alice, request(), expense);
  const keys = [request(), request()];
  const results = await Promise.all([app.erase(alice, keys[0]), app.erase(alice, keys[0]), app.erase(bob, keys[1])]);
  assert.ok(results.every(result => result.result.erased));
  assert.equal((await app.snapshot(alice.uid)).generation, 1);
  assert.equal((await app.snapshot(bob.uid)).generation, 1);
  assert.deepEqual((await app.snapshot(alice.uid)).transactions, []);
  assert.deepEqual((await app.snapshot(bob.uid)).transactions, []);
  assert.equal((await app.erase(alice, keys[0])).state.generation, 1);
});

test("a reset request joining another device stays idempotent after a new ledger starts", async () => {
  const { app, repo } = await setup();
  await app.transaction(alice, request(), expense);
  const first = request(), joined = request();
  const transact = repo.transact.bind(repo);
  let commits = 0;
  repo.transact = async actions => { if (++commits === 2) throw new Error("Interrupted reset"); return transact(actions); };
  await assert.rejects(app.erase(alice, first), /Interrupted reset/);
  commits = 0;
  await assert.rejects(app.erase(alice, joined), /Interrupted reset/);
  repo.transact = transact;
  await app.erase(alice, first);
  await app.transaction(alice, request(), { title: "Fresh income", amount: 10, type: "income" });
  const repeated = await app.erase(alice, joined);
  assert.equal(repeated.state.generation, 1);
  assert.equal(repeated.state.summary.totalIncome, 10);
  assert.equal(repeated.result.erased, true);
  assert.equal(repeated.state.ledgerResetId, null);
});

test("history fills visible pages when deleted entries precede them", async () => {
  const { app } = await setup();
  const visible = await app.transaction(alice, request(), { title: "Visible income", amount: 10, type: "income", date: "2026-11-01" });
  for (let index = 0; index < 3; index++) {
    const deleted = await app.transaction(alice, request(), { title: "Deleted income", amount: 1, type: "income", date: "2026-11-18" });
    await app.deleteTransaction(alice, request(), deleted.result.id);
  }
  const page = await app.history(alice.uid, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, visible.result.id);
  assert.equal(page.cursor, null);
});
test("recurring processing validates server state and commits the due date atomically", async () => {
  const { app } = await setup();
  await app.saveEntity(alice, request(), "recurring", "due-test", {
    name: "Monthly",
    amount: 5,
    nextDueDate: "2026-01-31T00:00:00.000Z",
    frequency: "monthly",
  });
  const result = await app.processRecurring(alice, "due-test");
  assert.equal(result.state.summary.totalExpenses, 5);
  assert.equal(
    (await app.records(alice, "recurring")).items[0].nextDueDate,
    "2026-02-28T00:00:00.000Z",
  );
  assert.equal(
    app.nextDue("2024-02-29T00:00:00.000Z", "yearly"),
    "2025-02-28T00:00:00.000Z",
  );
});
test("route authentication ignores forged user IDs and prevents state overwrite", async () => {
  const { app, repo } = await setup();
  const handler = createHandler(
    app,
    async (event) => {
      if (event.headers?.authorization !== "Bearer test-alice")
        throw new ApiError(401, "Sign in.");
      return alice;
    },
    repo,
  );
  const event = {
    rawPath: "/state",
    requestContext: { http: { method: "GET" } },
    headers: { "x-user-id": bob.uid, "x-api-key": "old-shared-key" },
  };
  assert.equal((await handler(event)).statusCode, 401);
  const valid = await handler({
    ...event,
    headers: { ...event.headers, authorization: "Bearer test-alice" },
  });
  assert.equal(JSON.parse(valid.body).userId, alice.uid);
  const overwrite = await handler({
    ...event,
    requestContext: { http: { method: "PUT" } },
    headers: { authorization: "Bearer test-alice" },
    body: JSON.stringify({ accounts: [{ balance: 999999 }] }),
  });
  assert.equal(overwrite.statusCode, 405);
});

test("retrying a complete settlement returns the original payment even after balance reaches zero", async () => {
  const { app } = await setup();
  await app.transaction(alice, request(), expense);
  const key = request(),
    body = { friendId: alice.uid };
  const first = await app.settle(bob, key, body),
    again = await app.settle(bob, key, body);
  assert.equal(first.result.id, again.result.id);
  assert.equal(balance(again.state, alice.uid), 0);
  assert.equal(
    again.state.transactions.filter((tx) => tx.type === "settlement").length,
    1,
  );
});
test("creation endpoints and profile changes retain durable identities across retries", async () => {
  const { app, repo } = await setup();
  const handle = createHandler(app, async () => alice, repo),
    id = request(),
    event = {
      rawPath: "/templates",
      requestContext: { http: { method: "POST" } },
      headers: { "idempotency-key": id },
      body: JSON.stringify({ name: "Lunch", amount: 10 }),
    };
  const first = await handle(event),
    again = await handle(event);
  assert.equal(first.statusCode, 201);
  assert.equal(again.statusCode, 201);
  assert.equal(
    JSON.parse(first.body).result.id,
    JSON.parse(again.body).result.id,
  );
  await app.updateProfile(alice, request(), {
    displayName: "Updated Alex",
    username: "alex_lee",
  });
  assert.equal((await app.profile(alice)).name, "Updated Alex");
  assert.equal((await app.search("@alex_", bob.uid))[0].upiId, undefined);
});
test("analytics uses each participant share and excludes payments and transfers", async () => {
  const { app } = await setup();
  const tx = await app.transaction(alice, request(), {
    ...expense,
    time: "09:30",
  });
  await app.settle(bob, request(), { friendId: alice.uid, amount: 30.15 });
  let month = await app.analytics(alice, {
    period: "Month",
    year: 2026,
    month: 11,
  });
  assert.equal(month.totalExpenses, 35.15);
  assert.equal(month.totalIncome, 0);
  assert.equal(month.categories.Stay, 35.15);
  const day = await app.analytics(bob, { period: "Date", date: "2026-11-18" });
  assert.equal(day.points.at(-1).expense, 35.15);
  await app.deleteTransaction(alice, request(), tx.result.id);
  month = await app.analytics(alice, { period: "Year", year: 2026 });
  assert.equal(month.totalExpenses, 0);
  assert.deepEqual(month.categories, {});
});
test("payments cannot exceed a debt and fresh start disables old recurring rules", async () => {
  const { app } = await setup();
  await app.transaction(alice, request(), expense);
  await assert.rejects(
    app.settle(bob, request(), { friendId: alice.uid, amount: 40 }),
    /exceeds/,
  );
  await app.settle(bob, request(), { friendId: alice.uid });
  await app.saveEntity(alice, request(), "recurring", "old-rule", {
    name: "Old",
    amount: 5,
    nextDueDate: "2026-01-01T00:00:00.000Z",
  });
  await app.erase(alice, request());
  assert.equal((await app.records(alice, "recurring")).items.length, 0);
  await assert.rejects(
    app.processRecurring(alice, "old-rule"),
    (error) => error.status === 404,
  );
});
