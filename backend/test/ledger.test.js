import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransaction, applyTransactions } from '../src/domain/ledger.js';

test('applies expense transaction balance and split rules', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 100, totalSpent: 20 }],
    friends: [{ id: 'friend-1', netBalance: 0 }],
    trips: [{ id: 'trip-1', totalSpend: 50 }],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-1',
    title: 'Dinner with friend',
    amount: -40,
    type: 'expense',
    upiAccountId: 'acc-1',
    paidBy: 'user',
    tripId: 'trip-1',
    splits: [{ friendId: 'friend-1', amount: 20 }],
  });

  assert.equal(result.accounts[0].balance, 60);
  assert.equal(result.accounts[0].totalSpent, 60);
  assert.equal(result.friends[0].netBalance, 20); // Friend owes user $20
  assert.equal(result.trips[0].totalSpend, 90);
  assert.equal(result.transactions[0].id, 'tx-1');
});

test('applies friend-paid expense where user owes friend', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 100, totalSpent: 0 }],
    friends: [{ id: 'friend-1', netBalance: 0 }],
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-2',
    title: 'Groceries paid by friend',
    amount: -50,
    type: 'expense',
    upiAccountId: 'acc-1',
    paidBy: 'friend-1',
    splits: [
      { friendId: 'user', amount: 25 },
      { friendId: 'friend-1', amount: 25 },
    ],
  });

  // User owes friend 25 => friend's netBalance is -25
  assert.equal(result.friends[0].netBalance, -25);
  // User account was not deducted since friend paid
  assert.equal(result.accounts[0].balance, 100);
});

test('friend pays for user where friend is not in splits reduces friend debt', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 500, totalSpent: 0 }],
    friends: [{ id: 'friend-3', name: 'James Davis', netBalance: 650 }], // James owes user 650
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-test1',
    title: 'test1',
    amount: -100,
    type: 'expense',
    upiAccountId: 'acc-1',
    paidBy: 'friend-3',
    splits: [
      { friendId: 'user', amount: 100 }, // James is not in splits, only user
    ],
  });

  // James paid 100 for user, so James's debt to user reduces from 650 to 550
  assert.equal(result.friends[0].netBalance, 550);
  // User bank account is untouched
  assert.equal(result.accounts[0].balance, 500);
});

test('friend pays for user exceeding previous debt turns into user owing friend', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 500, totalSpent: 0 }],
    friends: [{ id: 'friend-3', name: 'James Davis', netBalance: 50 }], // James owes user 50
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-exceed',
    title: 'Big Dinner',
    amount: -150,
    type: 'expense',
    upiAccountId: 'acc-1',
    paidBy: 'friend-3',
    splits: [
      { friendId: 'user', amount: 150 },
    ],
  });

  // 50 - 150 = -100 (user now owes James 100)
  assert.equal(result.friends[0].netBalance, -100);
});

test('applies income transaction properly', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 50, totalSpent: 10 }],
    friends: [],
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-inc',
    title: 'Salary / Allowance',
    amount: 200,
    type: 'income',
    upiAccountId: 'acc-1',
  });

  assert.equal(result.accounts[0].balance, 250);
  assert.equal(result.accounts[0].totalSpent, 10);
});

test('applies settlement when friend settles debt to user', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 50, totalSpent: 10 }],
    friends: [{ id: 'friend-1', netBalance: 30 }], // friend owes user $30
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-settle-1',
    title: 'Settled with friend-1',
    amount: 30,
    type: 'settlement',
    paidBy: 'friend-1',
    upiAccountId: 'acc-1',
  });

  assert.equal(result.accounts[0].balance, 80); // User received $30
  assert.equal(result.friends[0].netBalance, 0);  // Friend's debt is cleared
});

test('applies settlement when user settles debt to friend', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 100, totalSpent: 10 }],
    friends: [{ id: 'friend-2', netBalance: -40 }], // user owes friend $40
    trips: [],
    transactions: [],
  };

  const result = applyTransaction(state, {
    id: 'tx-settle-2',
    title: 'Settled with friend-2',
    amount: -40,
    type: 'settlement',
    paidBy: 'user',
    splits: [{ friendId: 'friend-2', amount: 40 }],
    upiAccountId: 'acc-1',
  });

  assert.equal(result.accounts[0].balance, 60); // User paid $40
  assert.equal(result.friends[0].netBalance, 0); // Settled to 0
});

test('applies batch transaction import (multi-app import)', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 500, totalSpent: 0 }],
    friends: [],
    trips: [],
    transactions: [],
  };

  const importedList = [
    { title: 'Item 1', amount: -20, type: 'expense', upiAccountId: 'acc-1' },
    { title: 'Item 2', amount: -30, type: 'expense', upiAccountId: 'acc-1' },
    { title: 'Income 1', amount: 100, type: 'income', upiAccountId: 'acc-1' },
  ];

  const result = applyTransactions(state, importedList);

  assert.equal(result.accounts[0].balance, 550); // 500 - 20 - 30 + 100
  assert.equal(result.accounts[0].totalSpent, 50); // 20 + 30
  assert.equal(result.transactions.length, 3);
});

test('applies transaction-wise settlement and marks target transaction settled', () => {
  const state = {
    accounts: [{ id: 'acc-1', balance: 500, totalSpent: 100 }],
    friends: [{ id: 'friend-1', netBalance: 50 }],
    trips: [],
    transactions: [
      {
        id: 'tx-lunch',
        title: 'Team Lunch',
        amount: -100,
        type: 'expense',
        paidBy: 'user',
        settled: false,
        splits: [{ friendId: 'friend-1', amount: 50 }],
      },
    ],
  };

  const result = applyTransaction(state, {
    id: 'tx-settle-lunch',
    title: 'Settled: Team Lunch',
    amount: 50,
    type: 'settlement',
    paidBy: 'friend-1',
    targetFriendId: 'friend-1',
    settledTransactionId: 'tx-lunch',
    upiAccountId: 'acc-1',
  });

  assert.equal(result.accounts[0].balance, 550); // Received 50
  assert.equal(result.friends[0].netBalance, 0); // Settled
  const originalTx = result.transactions.find((t) => t.id === 'tx-lunch');
  assert.equal(originalTx.settled, true); // Marked settled
});

