import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoFirestoreAdapter } from '../src/db/dynamoStore.js';
import { requestContextStorage } from '../src/config/firebase.js';
import {
  addTransaction,
  rectifyAllStats,
  settleAllTransactions,
} from '../src/services/transactionService.js';
import { handler as apiHandler } from '../src/handlers/api.js';

function createMockClient() {
  const store = new Map();
  return {
    async send(cmd) {
      const name = cmd.constructor.name;
      const { TableName, Key, Item, KeyConditionExpression, ExpressionAttributeValues } = cmd.input;

      if (name === 'PutCommand') {
        const pk = Item.ledgerId || Item.userId;
        const sk = Item.transactionId || Item.recurringId || Item.templateId || Item.recordId;
        store.set(`${TableName}::${pk}::${sk}`, JSON.parse(JSON.stringify(Item)));
        return {};
      }

      if (name === 'GetCommand') {
        const pk = Key.ledgerId || Key.userId;
        const sk = Key.transactionId || Key.recurringId || Key.templateId || Key.recordId;
        const item = store.get(`${TableName}::${pk}::${sk}`);
        return { Item: item ? JSON.parse(JSON.stringify(item)) : undefined };
      }

      if (name === 'DeleteCommand') {
        const pk = Key.ledgerId || Key.userId;
        const sk = Key.transactionId || Key.recurringId || Key.templateId || Key.recordId;
        store.delete(`${TableName}::${pk}::${sk}`);
        return {};
      }

      if (name === 'QueryCommand') {
        const targetPk = ExpressionAttributeValues[':pk'];
        const prefix = ExpressionAttributeValues[':prefix'];
        const items = [];
        for (const [k, val] of store.entries()) {
          if (k.startsWith(`${TableName}::${targetPk}::`)) {
            const sk = k.split('::')[2];
            if (!prefix || sk.startsWith(prefix)) {
              items.push(JSON.parse(JSON.stringify(val)));
            }
          }
        }
        return { Items: items };
      }

      return {};
    },
    rawStore: store,
  };
}

test('settleAllTransactions: Full settlement across multiple transactions', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_settle_full', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_settle_full', adapter: testAdapter }, async () => {
    // 1. Create two expenses where alice owes me money (300 + 200 = 500)
    const t1 = await addTransaction({
      expenseName: 'Dinner at Bistro',
      amount: 600,
      payer: 'me',
      splits: { me: 300, alice: 300 },
    });

    const t2 = await addTransaction({
      expenseName: 'Movie Tickets',
      amount: 400,
      payer: 'me',
      splits: { me: 200, alice: 200 },
    });

    // Verify initial balance
    const initialStats = await rectifyAllStats([{ uniqueId: 'alice', name: 'Alice' }]);
    assert.equal(initialStats.myPersonalBalances.alice, 500);

    // 2. Perform Full Settle with default amount (auto-settles 500)
    const settleRes = await settleAllTransactions({
      participantId: 'alice',
      paymentMode: 'UPI',
    });

    assert.equal(settleRes.amount, 500);
    assert.equal(settleRes.payer, 'alice');
    assert.equal(settleRes.settlementStatus, 'settled');
    assert.equal(settleRes.remainingAmount, 0);
    assert.equal(settleRes.settlementDeficit, 0);
    assert.equal(settleRes.overpaidAmount, 0);
    assert.equal(settleRes.participantRemaining.alice, 0);
    assert.equal(settleRes.participantStatuses.alice, 'settled');
    assert.equal(settleRes.summary.currentNetBalance, 0);

    // Verify parents are linked
    assert.ok(settleRes.parentTransactionIds.includes(t1.id));
    assert.ok(settleRes.parentTransactionIds.includes(t2.id));
  });
});

test('settleAllTransactions: Partial payment updates status and logs deficit', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_settle_partial', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_settle_partial', adapter: testAdapter }, async () => {
    // Bob owes me 1000
    const t1 = await addTransaction({
      expenseName: 'Weekend Resort Stay',
      amount: 2000,
      payer: 'me',
      splits: { me: 1000, bob: 1000 },
    });

    // Bob only pays 400 (deficit of 600)
    const settleRes = await settleAllTransactions({
      participantId: 'bob',
      amount: 400,
      paymentMode: 'Cash',
    });

    assert.equal(settleRes.amount, 400);
    assert.equal(settleRes.settlementStatus, 'partial');
    assert.equal(settleRes.settlementDeficit, 600);
    assert.equal(settleRes.remainingAmount, 600);
    assert.equal(settleRes.participantRemaining.bob, 600);
    assert.equal(settleRes.participantStatuses.bob, 'partial');
    assert.equal(settleRes.summary.currentNetBalance, 600);
  });
});

test('settleAllTransactions: Overpayment updates status to overpay/settled with negative balance credit', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_settle_overpay', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_settle_overpay', adapter: testAdapter }, async () => {
    // Charlie owes me 300
    const t1 = await addTransaction({
      expenseName: 'Pizza Night',
      amount: 600,
      payer: 'me',
      splits: { me: 300, charlie: 300 },
    });

    // Charlie overpays: gives 500 (overpay of 200)
    const settleRes = await settleAllTransactions({
      participantId: 'charlie',
      amount: 500,
      paymentMode: 'Online',
    });

    assert.equal(settleRes.amount, 500);
    assert.equal(settleRes.settlementStatus, 'settled');
    assert.equal(settleRes.settlementDeficit, 0);
    assert.equal(settleRes.remainingAmount, 0);
    assert.equal(settleRes.overpaidAmount, -200);
    assert.equal(settleRes.participantRemaining.charlie, -200);
    assert.equal(settleRes.participantStatuses.charlie, 'overpaid');

    // Charlie now has a credit of 200 (I owe charlie 200 => netBalance = -200)
    assert.equal(settleRes.summary.currentNetBalance, -200);
  });
});

test('settleAllTransactions: Bidirectional debts (what payee has to pay and what payee is owed) including past partials', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_settle_bidirectional', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_settle_bidirectional', adapter: testAdapter }, async () => {
    // 1. I paid 1000 for hotel (David owes me 500)
    await addTransaction({
      expenseName: 'Hotel',
      amount: 1000,
      payer: 'me',
      splits: { me: 500, david: 500 },
    });

    // 2. David paid 400 for dinner (I owe David 200)
    await addTransaction({
      expenseName: 'Dinner',
      amount: 400,
      payer: 'david',
      splits: { me: 200, david: 200 },
    });

    // 3. David previously made a partial payment of 100
    await addTransaction({
      expenseName: 'Old partial payment',
      amount: 100,
      type: 'settlement',
      isReturn: true,
      payer: 'david',
      participants: ['david'],
    });

    // Net balance:
    // David owes me 500 from Hotel
    // I owe David 200 from Dinner
    // David paid 100 partial
    // Net: 500 - 200 - 100 = 200 owed by David
    const stats = await rectifyAllStats([{ uniqueId: 'david', name: 'David' }]);
    assert.equal(stats.myPersonalBalances.david, 200);

    // Full settle with auto-detected amount (200)
    const settleRes = await settleAllTransactions({
      participantId: 'david',
    });

    assert.equal(settleRes.amount, 200);
    assert.equal(settleRes.settlementStatus, 'settled');
    assert.equal(settleRes.summary.netBalanceBefore, 200);
    assert.equal(settleRes.summary.currentNetBalance, 0);
  });
});

test('apiHandler: POST /api/transactions/settle-all routes correctly', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_api_settle', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_api_settle', adapter: testAdapter }, async () => {
    await addTransaction({
      expenseName: 'Coffee & Snacks',
      amount: 300,
      payer: 'me',
      splits: { me: 150, emma: 150 },
    });

    const res = await apiHandler({
      rawPath: '/api/transactions/settle-all',
      requestContext: { http: { method: 'POST', path: '/api/transactions/settle-all' } },
      body: JSON.stringify({
        participantId: 'emma',
        amount: 150,
      }),
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.data.amount, 150);
    assert.equal(body.data.settlementStatus, 'settled');
    assert.equal(body.data.summary.currentNetBalance, 0);
  });
});

test('settleAllTransactions: User scenario (lent 400, cold coffee 170/2, overpay 500, goods 100, partial 45)', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('ledger_user_aryan_test', mockClient);

  await requestContextStorage.run({ ledgerId: 'ledger_user_aryan_test', adapter: testAdapter }, async () => {
    // 1. I lent 400 to Aryan
    const t1 = await addTransaction({
      expenseName: 'Lent to Aryan',
      amount: 400,
      payer: 'me',
      splits: { aryan: 400 }
    });

    // 2. Cold coffee 170 split equally (Aryan owes 85)
    const t2 = await addTransaction({
      expenseName: 'Cold Coffee',
      amount: 170,
      payer: 'me',
      splits: { me: 85, aryan: 85 }
    });

    // 3. Aryan settled lent 400 by paying 500 (overpaid by 100)
    const t3 = await addTransaction({
      expenseName: 'Settlement for Lent',
      amount: 500,
      type: 'settlement',
      isReturn: true,
      payer: 'aryan',
      participants: ['aryan'],
      parentTransactionIds: [t1.id]
    });

    // 4. I bought 100 worth goods for Aryan (Aryan owes 100)
    const t4 = await addTransaction({
      expenseName: 'Goods for Aryan',
      amount: 100,
      payer: 'me',
      splits: { aryan: 100 }
    });

    // 5. Aryan partially settled cold coffee (paid 45 of 85, 40 remains)
    const t5 = await addTransaction({
      expenseName: 'Cold Coffee Partial Payment',
      amount: 45,
      type: 'settlement',
      isReturn: true,
      payer: 'aryan',
      participants: ['aryan'],
      parentTransactionIds: [t2.id]
    });

    // Net balance check:
    // +400 (lent) + 85 (coffee) - 500 (repaid) + 100 (goods) - 45 (repaid) = 40
    const statsBefore = await rectifyAllStats([{ uniqueId: 'aryan', name: 'Aryan' }]);
    assert.equal(statsBefore.myPersonalBalances.aryan, 40);

    // 6. Full Settle is clicked -> automatically calculates and settles 40
    const settleRes = await settleAllTransactions({ participantId: 'aryan' });
    assert.equal(settleRes.amount, 40);
    assert.equal(settleRes.payer, 'aryan');
    assert.equal(settleRes.settlementStatus, 'settled');
    assert.equal(settleRes.remainingAmount, 0);
    assert.equal(settleRes.overpaidAmount, 0);
    assert.equal(settleRes.summary.currentNetBalance, 0);
  });
});

