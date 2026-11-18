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
test("fresh start hides old private history and keeps another user financial data unchanged", async () => {
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
