import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Timestamp,
  FieldValue,
  resolvePath,
  DynamoFirestoreAdapter,
} from '../src/db/dynamoStore.js';
import { handler as apiHandler } from '../src/handlers/api.js';

test('Timestamp behaves identically to Firestore Timestamp', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');
  const ts = Timestamp.fromDate(now);

  assert.equal(ts.toDate().toISOString(), '2026-11-17T12:00:00.000Z');
  assert.equal(ts.toMillis(), now.getTime());
  assert.equal(ts.toISOString(), '2026-11-17T12:00:00.000Z');

  const tsNow = Timestamp.now();
  assert.ok(tsNow.seconds > 0);
  assert.ok(tsNow.toDate() instanceof Date);
});

test('resolvePath routes collections to dedicated DynamoDB tables', () => {
  // 1. Transactions collection
  const txCol = resolvePath('ledgers/user_abc/transactions');
  assert.equal(txCol.tableName, 'SplitTrackTransactions');
  assert.equal(txCol.partitionKey.name, 'ledgerId');
  assert.equal(txCol.partitionKey.value, 'user_abc');
  assert.equal(txCol.sortKeyName, 'transactionId');

  // 2. Transaction single document
  const txDoc = resolvePath('ledgers/user_abc/transactions/txn_123');
  assert.equal(txDoc.tableName, 'SplitTrackTransactions');
  assert.equal(txDoc.partitionKey.value, 'user_abc');
  assert.equal(txDoc.sortKey.value, 'txn_123');

  // 3. Recurring collection
  const recCol = resolvePath('ledgers/user_abc/recurring');
  assert.equal(recCol.tableName, 'SplitTrackRecurring');
  assert.equal(recCol.sortKeyName, 'recurringId');

  // 4. Templates collection
  const tplCol = resolvePath('ledgers/user_abc/templates');
  assert.equal(tplCol.tableName, 'SplitTrackTemplates');
  assert.equal(tplCol.sortKeyName, 'templateId');

  // 5. Metadata / Settings / Aggregates in SplitTrackLedgerData
  const aggDoc = resolvePath('ledgers/user_abc/aggregates/balances');
  assert.equal(aggDoc.tableName, 'SplitTrackLedgerData');
  assert.equal(aggDoc.sortKey.value, 'aggregates#balances');

  const settingsDoc = resolvePath('ledgers/user_abc/settings/user_preferences');
  assert.equal(settingsDoc.tableName, 'SplitTrackLedgerData');
  assert.equal(settingsDoc.sortKey.value, 'settings#user_preferences');

  const catDoc = resolvePath('ledgers/user_abc/categories/food');
  assert.equal(catDoc.tableName, 'SplitTrackLedgerData');
  assert.equal(catDoc.sortKey.value, 'categories#food');
});

test('Mock in-memory DynamoFirestoreAdapter executes CRUD, filters, and batches', async () => {
  const memoryStore = new Map();

  // Simple in-memory mock client implementing send()
  const mockClient = {
    async send(cmd) {
      const name = cmd.constructor.name;
      const { TableName, Key, Item, KeyConditionExpression, ExpressionAttributeValues } = cmd.input;

      if (name === 'PutCommand') {
        const pk = Item.ledgerId || Item.userId;
        const sk = Item.transactionId || Item.recurringId || Item.templateId || Item.recordId;
        memoryStore.set(`${TableName}::${pk}::${sk}`, Item);
        return {};
      }

      if (name === 'GetCommand') {
        const pk = Key.ledgerId || Key.userId;
        const sk = Key.transactionId || Key.recurringId || Key.templateId || Key.recordId;
        const item = memoryStore.get(`${TableName}::${pk}::${sk}`);
        return { Item: item || undefined };
      }

      if (name === 'DeleteCommand') {
        const pk = Key.ledgerId || Key.userId;
        const sk = Key.transactionId || Key.recurringId || Key.templateId || Key.recordId;
        memoryStore.delete(`${TableName}::${pk}::${sk}`);
        return {};
      }

      if (name === 'QueryCommand') {
        const targetPk = ExpressionAttributeValues[':pk'];
        const prefix = ExpressionAttributeValues[':prefix'];
        const items = [];
        for (const [k, val] of memoryStore.entries()) {
          if (k.startsWith(`${TableName}::${targetPk}::`)) {
            const sk = k.split('::')[2];
            if (!prefix || sk.startsWith(prefix)) {
              items.push(val);
            }
          }
        }
        return { Items: items };
      }

      return {};
    },
  };

  const adapter = new DynamoFirestoreAdapter('ledger_test_1', mockClient);

  // 1. Add document to collection
  const colRef = adapter.collection('ledgers/ledger_test_1/transactions');
  const docRef = await colRef.add({
    expenseName: 'Dinner at Taj',
    amount: 1200,
    isDeleted: false,
    timestamp: '2026-11-17T14:00:00.000Z',
    payer: 'me',
    splits: { 'friend_1': 600, 'me': 600 },
  });

  assert.ok(docRef.id);

  // 2. Query documents
  const snap = await colRef.where('isDeleted', '==', false).get();
  assert.equal(snap.size, 1);
  const tx = snap.docs[0].data();
  assert.equal(tx.expenseName, 'Dinner at Taj');
  assert.equal(tx.amount, 1200);

  // 3. Update document
  await docRef.update({ expenseName: 'Grand Dinner at Taj' });
  const updatedSnap = await docRef.get();
  assert.equal(updatedSnap.data().expenseName, 'Grand Dinner at Taj');

  // 4. Batch operations
  const batch = adapter.batch();
  const docRef2 = colRef.doc('txn_custom_99');
  batch.set(docRef2, { expenseName: 'Coffee', amount: 150, isDeleted: false });
  await batch.commit();

  const snap2 = await colRef.where('isDeleted', '==', false).get();
  assert.equal(snap2.size, 2);

  // 5. Delete document
  await docRef.delete();
  const snap3 = await colRef.where('isDeleted', '==', false).get();
  assert.equal(snap3.size, 1);
});

test('apiHandler handles /api/health and routing correctly', async () => {
  // 1. Health check
  const healthRes = await apiHandler({
    rawPath: '/api/health',
    requestContext: { http: { method: 'GET', path: '/api/health' } },
  });
  assert.equal(healthRes.statusCode, 200);
  const healthBody = JSON.parse(healthRes.body);
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.service, 'splittrack-backend');
  assert.equal(healthBody.database, 'dynamodb');

  // 2. Auth rejection on protected route without key
  process.env.API_KEY = 'test_secret_key';
  const noAuthRes = await apiHandler({
    rawPath: '/api/transactions',
    requestContext: { http: { method: 'GET', path: '/api/transactions' } },
  });
  assert.equal(noAuthRes.statusCode, 401);

  // Clean up
  delete process.env.API_KEY;
});
