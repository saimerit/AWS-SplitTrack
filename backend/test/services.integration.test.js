import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoFirestoreAdapter, Timestamp } from '../src/db/dynamoStore.js';
import { requestContextStorage } from '../src/config/firebase.js';
import {
  addTransaction,
  updateTransaction,
  deleteTransaction,
  restoreTransaction,
  permanentDeleteTransaction,
  bulkUpdateTransactions,
  rectifyAllStats,
} from '../src/services/transactionService.js';
import {
  addRecurringTransaction,
  getRecurringRules,
  checkDueRecurring,
  processRecurringTransaction,
  skipRecurringTransaction,
  deleteRecurringTransaction,
} from '../src/services/recurringService.js';
import {
  addTemplate,
  getTemplates,
  updateTemplate,
  deleteTemplate,
} from '../src/services/templateService.js';
import {
  exportFullBackup,
  importFromBackup,
  nukeCollection,
} from '../src/services/adminService.js';

// Setup in-memory mock client for full service lifecycle testing
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

test('Full lifecycle integration: Transactions, Recurring, Templates, and Admin services', async () => {
  const mockClient = createMockClient();
  const testAdapter = new DynamoFirestoreAdapter('test_ledger_42', mockClient);

  // Monkey-patch getDb or run within requestContextStorage with custom adapter
  await requestContextStorage.run({ ledgerId: 'test_ledger_42', adapter: testAdapter }, async () => {
    // 1. Templates lifecycle
    const tpl = await addTemplate({
      name: 'Weekend Movie',
      amount: 500,
      category: 'Entertainment',
      splits: { me: 250, friend_a: 250 },
    });
    assert.ok(tpl.id);

    const templates = await getTemplates();
    assert.equal(templates.length, 1);
    assert.equal(templates[0].name, 'Weekend Movie');

    await updateTemplate(tpl.id, { amount: 600 });
    const updatedTemplates = await getTemplates();
    assert.equal(updatedTemplates[0].amount, 600);

    // 2. Recurring lifecycle
    const now = new Date();
    const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago (due)
    const rec = await addRecurringTransaction({
      name: 'Netflix Subscription',
      amount: 499,
      category: 'Subscription',
      nextDueDate: pastDate,
      frequency: 'monthly',
    });
    assert.ok(rec.id);

    const rules = await getRecurringRules();
    assert.equal(rules.length, 1);

    const dueList = await checkDueRecurring();
    assert.equal(dueList.length, 1);
    assert.equal(dueList[0].name, 'Netflix Subscription');

    const processRes = await processRecurringTransaction(rec.id, dueList[0]);
    assert.ok(processRes.id);
    assert.ok(processRes.nextDueDate > now);

    // 3. Transactions lifecycle
    const txn1 = await addTransaction({
      expenseName: 'Groceries',
      amount: 1000,
      category: 'Food',
      payer: 'me',
      splits: { me: 500, friend_a: 500 },
    });
    assert.ok(txn1.id);
    assert.equal(txn1.expenseName, 'Groceries');

    // Update
    await updateTransaction(txn1.id, { expenseName: 'Weekly Groceries' });

    // Rectify stats
    const stats = await rectifyAllStats([{ uniqueId: 'friend_a', name: 'Friend A' }]);
    assert.equal(stats.myPersonalBalances.friend_a, 500);
    assert.equal(stats.totals.totalOwedToMe, 500);

    // Soft delete
    const delRes = await deleteTransaction(txn1.id);
    assert.equal(delRes.success, true);

    // Restore
    const restoreRes = await restoreTransaction(txn1.id);
    assert.equal(restoreRes.success, true);

    // Permanent delete
    const permRes = await permanentDeleteTransaction(txn1.id);
    assert.equal(permRes.success, true);

    // Clean up template & recurring
    await deleteTemplate(tpl.id);
    const afterDeleteTemplates = await getTemplates();
    assert.equal(afterDeleteTemplates.length, 0);

    await deleteRecurringTransaction(rec.id);
    const afterDeleteRec = await getRecurringRules();
    assert.equal(afterDeleteRec.length, 0);
  });
});
