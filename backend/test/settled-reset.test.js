import test from 'node:test';
import assert from 'node:assert/strict';
import { SplitTrackService } from '../src/core/service.js';
import { pairId } from '../src/core/money.js';
import { MemoryRepository } from './support/memoryRepository.js';

const alice = { uid: 'resetAlice', email: 'alice@example.invalid', name: 'Alice' };
const bob = { uid: 'resetBob', email: 'bob@example.invalid', name: 'Bob' };
const charlie = { uid: 'resetCharlie', email: 'charlie@example.invalid', name: 'Charlie' };
let sequence = 0;
const request = () => `settled_reset_${++sequence}`;
const ledger = id => ({ ledgerId: id, recordId: 'STATE' });
async function setup() {
  const repo = new MemoryRepository(), app = new SplitTrackService(repo);
  for (const user of [alice, bob, charlie]) {
    await app.bootstrap(user);
    await app.updateProfile(user, request(), { username: user.uid.toLowerCase(), displayName: user.name });
    await app.saveEntity(user, request(), 'accounts', `account-${user.uid}`, { title: `${user.name} UPI`, kind: 'upi', upiId: `${user.uid.toLowerCase()}@okaxis` });
  }
  for (const peer of [bob, charlie]) await app.saveEntity(alice, request(), 'friends', peer.uid, { userId: peer.uid });
  return { app, repo };
}
const shared = (peer, amount = 100) => ({ title: 'Shared expense', amount: -amount, type: 'expense', paidBy: 'user', date: '2026-11-22', splits: [{ friendId: 'user', paidAmount: amount }, { friendId: peer.uid, paidAmount: 0 }] });

test('reset removes settled history and keeps separate owing and owed members with exact claims', async () => {
  const { app, repo } = await setup();
  const settled = await app.transaction(alice, request(), shared(bob));
  await app.settle(alice, request(), { friendId: bob.uid, amount: 50 });
  const owed = await app.transaction(alice, request(), shared(charlie, 60));
  const owing = await app.transaction(bob, request(), shared(alice, 40));
  const before = await app.snapshot(alice.uid);
  const claims = await repo.many('ledger', [ledger(pairId(alice.uid, bob.uid)), ledger(pairId(alice.uid, charlie.uid))]);
  const reset = await app.erase(alice, request(), { mode: 'settled-only' });
  assert.equal(reset.state.resetPolicy, 'settled-only');
  assert.deepEqual(reset.state.transactions.map(row => row.id).sort(), [owed.result.id, owing.result.id].sort());
  assert.deepEqual(reset.state.friends, before.friends);
  assert.equal(reset.state.friends.find(peer => peer.id === bob.uid).netBalance, -20);
  assert.equal(reset.state.friends.find(peer => peer.id === charlie.uid).netBalance, 30);
  assert.deepEqual(await repo.many('ledger', [ledger(pairId(alice.uid, bob.uid)), ledger(pairId(alice.uid, charlie.uid))]), claims);
  assert.equal(reset.result.removedTransactions, 2);
  assert.equal(reset.result.retainedTransactions, 2);
  await assert.rejects(app.getTransaction(alice, settled.result.id), error => error.status === 404);
  assert.equal((await app.getTransaction(bob, settled.result.id)).id, settled.result.id);
  await app.settle(bob, request(), { friendId: alice.uid, amount: 20 });
  await app.settle(alice, request(), { friendId: charlie.uid, amount: 30 });
  assert.ok((await app.snapshot(alice.uid)).friends.every(peer => peer.netBalance === 0));
  const again = await app.erase(alice, request());
  assert.equal(again.state.transactions.length, 0);
});

test('a partial payment preserves both its expense and consolidated payment record', async () => {
  const { app, repo } = await setup();
  const expense = await app.transaction(alice, request(), shared(bob, 70.3));
  const payment = await app.settle(alice, request(), { friendId: bob.uid, amount: 10 });
  const beforePair = await repo.get('ledger', ledger(pairId(alice.uid, bob.uid)));
  const reset = await app.erase(alice, request());
  assert.deepEqual(reset.state.transactions.map(row => row.id).sort(), [expense.result.id, payment.result.id].sort());
  assert.equal(reset.state.friends.find(peer => peer.id === bob.uid).netBalance, 25.15);
  assert.deepEqual(await repo.get('ledger', ledger(pairId(alice.uid, bob.uid))), beforePair);
  assert.equal(reset.result.retainedTransactions, 2);
  assert.equal(reset.state.summary.totalExpenses, 35.15);
  assert.equal(reset.state.accounts[0].totalSpent, 70.3);
  const second = await app.erase(alice, request());
  assert.equal(second.state.summary.totalExpenses, 35.15);
  assert.equal(second.state.accounts[0].totalSpent, 70.3);
  assert.equal(second.state.transactions.length, 2);
});

test('regular Delete remains available and correctly reverses an unpaid migrated transaction', async () => {
  const { app } = await setup();
  const expense = await app.transaction(alice, request(), shared(bob));
  await app.erase(alice, request());
  await app.deleteTransaction(alice, request(), expense.result.id);
  assert.equal((await app.snapshot(alice.uid)).friends.find(peer => peer.id === bob.uid).netBalance, 0);
  assert.equal((await app.snapshot(bob.uid)).friends.find(peer => peer.id === alice.uid).netBalance, 0);
});

test('reset preserves a refund debt and the deleted journal and restore record behind it', async () => {
  const { app, repo } = await setup();
  const expense = await app.transaction(alice, request(), shared(bob));
  await app.settle(alice, request(), { friendId: bob.uid, amount: 50 });
  await app.deleteTransaction(alice, request(), expense.result.id);
  const before = await repo.get('ledger', ledger(pairId(alice.uid, bob.uid)));
  const reset = await app.erase(alice, request());
  assert.equal(reset.state.friends.find(peer => peer.id === bob.uid).netBalance, -50);
  assert.deepEqual(await repo.get('ledger', ledger(pairId(alice.uid, bob.uid))), before);
  assert.ok(await repo.get('ledger', ledger(`JOURNAL#${expense.result.id}`)));
  assert.ok((await app.transactionBin(alice)).items.some(row => row.id === expense.result.id));
  await app.settle(bob, request(), { friendId: alice.uid, amount: 50 });
  assert.equal((await app.snapshot(alice.uid)).friends.find(peer => peer.id === bob.uid).netBalance, 0);
});

test('private reset hides settled trip rows only for the caller and leaves membership intact', async () => {
  const { app } = await setup();
  await app.saveEntity(alice, request(), 'trips', 'settled-reset-trip', { name: 'Trip', members: ['user', bob.uid] });
  const settled = await app.transaction(alice, request(), { ...shared(bob), tripId: 'settled-reset-trip' });
  await app.settle(alice, request(), { friendId: bob.uid, amount: 50 });
  const unpaid = await app.transaction(alice, request(), { ...shared(bob, 20), tripId: 'settled-reset-trip' });
  await app.erase(alice, request());
  const own = await app.tripHistory(alice, 'settled-reset-trip');
  const peer = await app.tripHistory(bob, 'settled-reset-trip');
  assert.deepEqual(own.items.map(row => row.id), [unpaid.result.id]);
  assert.ok(peer.items.some(row => row.id === settled.result.id));
  assert.equal((await app.snapshot(alice.uid)).trips.length, 1);
});

test('reset still rejects pre-reset unsynced drafts and exact reset retries remain idempotent', async () => {
  const { app } = await setup();
  const expense = await app.transaction(alice, request(), shared(bob));
  const key = request(), reset = await app.erase(alice, key);
  await assert.rejects(app.transaction(alice, request(), { title: 'Old offline draft', type: 'income', amount: 1, ledgerGeneration: 0 }), error => error.code === 'LEDGER_GENERATION_CHANGED');
  assert.deepEqual((await app.erase(alice, key)).result, reset.result);
  assert.equal((await app.getTransaction(alice, expense.result.id)).id, expense.result.id);
});

test('two devices joining one reset receive the same counts without wiping unpaid entries', async () => {
  const { app } = await setup();
  await app.transaction(alice, request(), { title: 'Settled income', type: 'income', amount: 1 });
  await app.transaction(alice, request(), shared(bob));
  const ids = [request(), request()];
  const results = await Promise.all(ids.map(id => app.erase(alice, id)));
  assert.ok(results.every(response => response.result.erased && response.result.removedTransactions === 1 && response.result.retainedTransactions === 1));
  assert.ok(results.every(response => response.state.generation === 1));
  assert.ok((await app.snapshot(alice.uid)).transactions.length === 1);
  for (const id of ids) assert.equal((await app.erase(alice, id)).result.retainedTransactions, 1);
});

test('invalid reset modes and unverifiable debts cannot erase data or advance the ledger', async () => {
  const { app, repo } = await setup();
  const expense = await app.transaction(alice, request(), shared(bob));
  const before = await app.snapshot(alice.uid);
  for (const body of [null, [], { mode: 'all' }]) await assert.rejects(app.erase(alice, request(), body), error => error.status === 400);
  const pairKey = ledger(pairId(alice.uid, bob.uid));
  const pair = await repo.get('ledger', pairKey);
  pair.claims = [];
  await repo.transact([{ type: 'put', table: 'ledger', item: pair }]);
  await assert.rejects(app.erase(alice, request()), error => error.code === 'LEDGER_BALANCE_REVIEW_REQUIRED');
  assert.equal((await app.snapshot(alice.uid)).generation, before.generation);
  assert.equal((await app.getTransaction(alice, expense.result.id)).id, expense.result.id);
});
