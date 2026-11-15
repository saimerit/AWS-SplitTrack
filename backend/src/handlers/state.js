import { applyTransaction, applyTransactions } from '../domain/ledger.js';
import { fail, ok, parseBody, userIdFrom, verifyApiKey } from '../http.js';
import {
  clearState,
  deleteEntity,
  loadState,
  saveEntities,
  saveEntity,
} from '../repository.js';

const allowedEntityTypes = new Set(['accounts', 'friends', 'trips', 'categories', 'transactions']);

export async function handler(event) {
  try {
    if (!verifyApiKey(event)) {
      return fail('Invalid or missing API key.', 401);
    }

    const userId = userIdFrom(event);
    if (!userId) {
      return fail('Authorization token or valid x-user-id is required.', 401);
    }

    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.rawPath || event.path || event.requestContext?.http?.path || '';
    const pathParameters = event.pathParameters || {};

    // 1. Full state routes: /state
    if (path === '/state' || path === '/state/') {
      if (method === 'GET') {
        const state = await loadState(userId);
        return ok(state);
      }
      if (method === 'PUT' || method === 'POST') {
        const body = parseBody(event);
        const entities = [];
        for (const type of ['accounts', 'friends', 'trips', 'categories', 'transactions']) {
          if (Array.isArray(body[type])) {
            for (const item of body[type]) {
              if (item?.id) {
                entities.push({ entityType: type, entityId: item.id, data: item });
              }
            }
          }
        }
        await saveEntities(userId, entities);
        return ok({ success: true, count: entities.length });
      }
      if (method === 'DELETE') {
        const result = await clearState(userId);
        return ok({ success: true, ...result });
      }
    }

    // 2. Erase / Fresh Start route: /state/erase
    if (path === '/state/erase' && (method === 'POST' || method === 'DELETE')) {
      const result = await clearState(userId);
      return ok({ success: true, ...result });
    }

    // 3. Batch transaction import: /transactions/batch
    if (path === '/transactions/batch' && method === 'POST') {
      const body = parseBody(event);
      const incomingList = Array.isArray(body) ? body : (body.transactions || []);
      if (!Array.isArray(incomingList) || incomingList.length === 0) {
        return fail('transactions array is required for batch import.');
      }

      const currentState = await loadState(userId);
      const nextState = applyTransactions(currentState, incomingList);

      const entitiesToSave = [
        ...(nextState.accounts || []).map((data) => ({ entityType: 'accounts', entityId: data.id, data })),
        ...(nextState.friends || []).map((data) => ({ entityType: 'friends', entityId: data.id, data })),
        ...(nextState.trips || []).map((data) => ({ entityType: 'trips', entityId: data.id, data })),
        ...(nextState.transactions || []).map((data) => ({ entityType: 'transactions', entityId: data.id, data })),
      ];

      await saveEntities(userId, entitiesToSave);
      return ok({ success: true, importedCount: incomingList.length }, 201);
    }

    // 4. Single transaction routes: /transactions/{transactionId}
    if (pathParameters.transactionId) {
      const { transactionId } = pathParameters;
      if (method === 'DELETE') {
        await deleteEntity(userId, 'transactions', transactionId);
        return ok({ success: true, deleted: transactionId });
      }
      if (method === 'GET') {
        const state = await loadState(userId);
        const tx = (state.transactions || []).find((t) => t.id === transactionId);
        if (!tx) return fail('Transaction not found.', 404);
        return ok(tx);
      }
    }

    // 5. Transactions collection routes: /transactions
    if (path === '/transactions' || path === '/transactions/') {
      if (method === 'GET') {
        const state = await loadState(userId);
        return ok(state.transactions || []);
      }
      if (method === 'POST') {
        const body = parseBody(event);
        const transaction = body.transaction || body;
        if (!transaction?.title || !Number.isFinite(Number(transaction.amount))) {
          return fail('A transaction title and numeric amount are required.');
        }

        const currentState = await loadState(userId);
        const nextState = applyTransaction(currentState, transaction);
        const createdTx = nextState.transactions[0];

        // Check if any existing transactions were marked settled by this transaction
        const updatedTransactions = [];
        if (transaction.type === 'settlement') {
          for (let i = 1; i < nextState.transactions.length; i++) {
            const tx = nextState.transactions[i];
            const oldTx = (currentState.transactions || []).find((t) => t.id === tx.id);
            if (oldTx && oldTx.settled !== tx.settled) {
              updatedTransactions.push({ entityType: 'transactions', entityId: tx.id, data: tx });
            }
          }
        }

        await saveEntities(userId, [
          ...(nextState.accounts || []).map((data) => ({ entityType: 'accounts', entityId: data.id, data })),
          ...(nextState.friends || []).map((data) => ({ entityType: 'friends', entityId: data.id, data })),
          ...(nextState.trips || []).map((data) => ({ entityType: 'trips', entityId: data.id, data })),
          { entityType: 'transactions', entityId: createdTx.id, data: createdTx },
          ...updatedTransactions,
        ]);

        return ok(createdTx, 201);
      }
    }

    // 6. Generic Entity CRUD: /entities/{entityType}/{entityId}
    if (pathParameters.entityType && pathParameters.entityId) {
      const { entityType, entityId } = pathParameters;
      if (!allowedEntityTypes.has(entityType)) {
        return fail(`Unsupported entity type: ${entityType}.`);
      }

      if (method === 'PUT') {
        const data = parseBody(event);
        await saveEntity(userId, entityType, entityId, data);
        return ok(data, 200);
      }

      if (method === 'DELETE') {
        await deleteEntity(userId, entityType, entityId);
        return ok({ success: true, deleted: entityId });
      }
    }

    return fail('Endpoint or method not supported.', 404);
  } catch (error) {
    return fail(error.message || 'Unable to process state.', 500);
  }
}
