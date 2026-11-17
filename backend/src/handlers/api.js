import { ok, fail, parseBody, userIdFrom, verifyApiKey, verifyAdminKey } from '../http.js';
import { requestContextStorage } from '../config/firebase.js';
import {
  addTransaction,
  updateTransaction,
  deleteTransaction,
  restoreTransaction,
  permanentDeleteTransaction,
  bulkUpdateTransactions,
  rectifyAllStats,
  repairAllTransactionStats,
  settleAllTransactions,
} from '../services/transactionService.js';
import {
  getRecurringRules,
  checkDueRecurring,
  addRecurringTransaction,
  updateRecurringTransaction,
  deleteRecurringTransaction,
  processRecurringTransaction,
  skipRecurringTransaction,
} from '../services/recurringService.js';
import {
  getTemplates,
  addTemplate,
  updateTemplate,
  deleteTemplate,
} from '../services/templateService.js';
import {
  exportFullBackup,
  importFromBackup,
  nukeCollection,
} from '../services/adminService.js';
import { getDb, LEDGER_ID } from '../config/firebase.js';

export async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    if (method === 'OPTIONS') {
      return ok({ message: 'OK' });
    }

    const rawPath = event.rawPath || event.path || event.requestContext?.http?.path || '';
    const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
    const query = event.queryStringParameters || {};

    // Health check - no auth required
    if (normalizedPath === '/health' || normalizedPath === '/api/health') {
      return ok({
        status: 'ok',
        service: 'splittrack-backend',
        database: 'dynamodb',
        timestamp: new Date().toISOString(),
      });
    }

    // Require API Key authentication
    if (!verifyApiKey(event)) {
      return fail('Invalid or missing API key.', 401);
    }

    // Determine tenant / ledger scope
    const userId = userIdFrom(event) || query.userId || query.user_id || LEDGER_ID;
    const ledgerScope = userId.startsWith('USER#') ? userId.slice(5) : userId;

    // Run in requestContextStorage to enforce user isolation across all services
    const existingStore = requestContextStorage.getStore();
    const contextData = {
      ledgerId: ledgerScope,
      userId: ledgerScope,
      ...(existingStore?.adapter ? { adapter: existingStore.adapter } : {}),
    };

    return await requestContextStorage.run(contextData, async () => {
      // -----------------------------------------------------------------------
      // 1. TRANSACTIONS ROUTES
      // -----------------------------------------------------------------------
      // GET /api/transactions or /transactions
      if ((normalizedPath === '/api/transactions' || normalizedPath === '/transactions') && method === 'GET') {
        const db = getDb();
        const limit = parseInt(query.limit, 10) || 50;
        const includeDeleted = query.deleted === 'true';

        let q = db.collection(`ledgers/${ledgerScope}/transactions`).orderBy('timestamp', 'desc');
        if (!includeDeleted) {
          q = q.where('isDeleted', '==', false);
        }
        q = q.limit(limit);

        const snap = await q.get();
        const transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return ok({ success: true, count: transactions.length, data: transactions });
      }

      // POST /api/transactions or /transactions (create)
      if ((normalizedPath === '/api/transactions' || normalizedPath === '/transactions') && method === 'POST') {
        const body = parseBody(event);
        const txnData = body.transaction || body;
        if (!txnData || (!txnData.expenseName && !txnData.title) || txnData.amount === undefined) {
          return fail('expenseName (or title) and amount are required.', 400);
        }
        if (!txnData.expenseName && txnData.title) {
          txnData.expenseName = txnData.title;
        }
        const result = await addTransaction(txnData);
        return ok({ success: true, data: result }, 201);
      }

      // POST /api/transactions/bulk (bulk update)
      if (
        (normalizedPath === '/api/transactions/bulk' || normalizedPath === '/transactions/bulk') &&
        method === 'POST'
      ) {
        const { ids, updateData } = parseBody(event);
        if (!ids || !Array.isArray(ids)) {
          return fail('ids array required.', 400);
        }
        const result = await bulkUpdateTransactions(ids, updateData);
        return ok({ success: true, ...result });
      }

      // POST /api/transactions/rectify (recompute stats)
      if (
        (normalizedPath === '/api/transactions/rectify' || normalizedPath === '/transactions/rectify') &&
        method === 'POST'
      ) {
        const { participants = [] } = parseBody(event);
        const result = await rectifyAllStats(participants);
        return ok({ success: true, data: result });
      }

      // POST /api/transactions/repair (deep repair)
      if (
        (normalizedPath === '/api/transactions/repair' || normalizedPath === '/transactions/repair') &&
        method === 'POST'
      ) {
        const result = await repairAllTransactionStats();
        return ok({ success: true, ...result });
      }

      // Restore soft deleted: POST /api/transactions/:id/restore
      const restoreMatch = normalizedPath.match(/^(?:\/api)?\/transactions\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        const id = restoreMatch[1];
        const result = await restoreTransaction(id);
        return ok(result);
      }

      // Permanent delete: DELETE /api/transactions/:id/permanent
      const permMatch = normalizedPath.match(/^(?:\/api)?\/transactions\/([^/]+)\/permanent$/);
      if (permMatch && method === 'DELETE') {
        const id = permMatch[1];
        const result = await permanentDeleteTransaction(id);
        return ok(result);
      }

      // Settle all / full settle: POST /api/transactions/settle-all
      if (
        (normalizedPath === '/api/transactions/settle-all' ||
          normalizedPath === '/transactions/settle-all' ||
          normalizedPath === '/api/transactions/settle-full' ||
          normalizedPath === '/transactions/settle-full') &&
        method === 'POST'
      ) {
        const body = parseBody(event);
        const { participantId, ...rest } = body;
        if (!participantId) {
          return fail('participantId is required for full settlement.', 400);
        }
        const result = await settleAllTransactions({ participantId, ...rest });
        return ok({ success: true, data: result }, 201);
      }

      // Single transaction: PUT /api/transactions/:id
      const singleTxMatch = normalizedPath.match(/^(?:\/api)?\/transactions\/([^/]+)$/);
      if (singleTxMatch) {
        const id = singleTxMatch[1];
        if (method === 'PUT') {
          const { oldParentId, ...txnData } = parseBody(event);
          const result = await updateTransaction(id, txnData, oldParentId);
          return ok({ success: true, data: result });
        }
        if (method === 'DELETE') {
          const parentId = query.parentId;
          const result = await deleteTransaction(id, parentId);
          return ok(result);
        }
        if (method === 'GET') {
          const db = getDb();
          const docSnap = await db.doc(`ledgers/${ledgerScope}/transactions/${id}`).get();
          if (!docSnap.exists) return fail('Transaction not found.', 404);
          return ok({ success: true, data: { id: docSnap.id, ...docSnap.data() } });
        }
      }

      // -----------------------------------------------------------------------
      // 2. RECURRING ROUTES
      // -----------------------------------------------------------------------
      // GET /api/recurring or /recurring
      if ((normalizedPath === '/api/recurring' || normalizedPath === '/recurring') && method === 'GET') {
        const rules = await getRecurringRules();
        return ok({ success: true, data: rules });
      }

      // GET /api/recurring/due or /recurring/due
      if ((normalizedPath === '/api/recurring/due' || normalizedPath === '/recurring/due') && method === 'GET') {
        const due = await checkDueRecurring();
        return ok({ success: true, data: due });
      }

      // POST /api/recurring or /recurring
      if ((normalizedPath === '/api/recurring' || normalizedPath === '/recurring') && method === 'POST') {
        const body = parseBody(event);
        const result = await addRecurringTransaction(body);
        return ok({ success: true, data: result }, 201);
      }

      // Process recurring: POST /api/recurring/:id/process
      const processRecurMatch = normalizedPath.match(/^(?:\/api)?\/recurring\/([^/]+)\/process$/);
      if (processRecurMatch && method === 'POST') {
        const id = processRecurMatch[1];
        const result = await processRecurringTransaction(id, parseBody(event));
        return ok({ success: true, data: result });
      }

      // Skip recurring: POST /api/recurring/:id/skip
      const skipRecurMatch = normalizedPath.match(/^(?:\/api)?\/recurring\/([^/]+)\/skip$/);
      if (skipRecurMatch && method === 'POST') {
        const id = skipRecurMatch[1];
        const { currentDueDate, frequency } = parseBody(event);
        const result = await skipRecurringTransaction(id, currentDueDate, frequency);
        return ok({ success: true, data: result });
      }

      // Single recurring: PUT / DELETE
      const singleRecurMatch = normalizedPath.match(/^(?:\/api)?\/recurring\/([^/]+)$/);
      if (singleRecurMatch) {
        const id = singleRecurMatch[1];
        if (method === 'PUT') {
          const result = await updateRecurringTransaction(id, parseBody(event));
          return ok({ success: true, data: result });
        }
        if (method === 'DELETE') {
          const result = await deleteRecurringTransaction(id);
          return ok(result);
        }
      }

      // -----------------------------------------------------------------------
      // 3. TEMPLATES ROUTES
      // -----------------------------------------------------------------------
      // GET /api/templates or /templates
      if ((normalizedPath === '/api/templates' || normalizedPath === '/templates') && method === 'GET') {
        const templates = await getTemplates();
        return ok({ success: true, data: templates });
      }

      // POST /api/templates or /templates
      if ((normalizedPath === '/api/templates' || normalizedPath === '/templates') && method === 'POST') {
        const result = await addTemplate(parseBody(event));
        return ok({ success: true, data: result }, 201);
      }

      // Single template: PUT / DELETE
      const singleTemplateMatch = normalizedPath.match(/^(?:\/api)?\/templates\/([^/]+)$/);
      if (singleTemplateMatch) {
        const id = singleTemplateMatch[1];
        if (method === 'PUT') {
          const result = await updateTemplate(id, parseBody(event));
          return ok({ success: true, data: result });
        }
        if (method === 'DELETE') {
          const result = await deleteTemplate(id);
          return ok(result);
        }
      }

      // -----------------------------------------------------------------------
      // 4. ADMIN ROUTES (Protected by Admin API Key)
      // -----------------------------------------------------------------------
      if (normalizedPath.startsWith('/api/admin') || normalizedPath.startsWith('/admin')) {
        if (!verifyAdminKey(event)) {
          return fail('Admin authentication required.', 403);
        }

        // GET /api/admin/backup
        if (normalizedPath === '/api/admin/backup' || normalizedPath === '/admin/backup') {
          const backup = await exportFullBackup();
          return ok(backup);
        }

        // POST /api/admin/restore
        if (normalizedPath === '/api/admin/restore' || normalizedPath === '/admin/restore') {
          const result = await importFromBackup(parseBody(event));
          return ok({ success: true, result });
        }

        // POST /api/admin/nuke/:collection
        const nukeMatch = normalizedPath.match(/^(?:\/api)?\/admin\/nuke\/([^/]+)$/);
        if (nukeMatch && method === 'POST') {
          const collection = nukeMatch[1];
          const result = await nukeCollection(collection);
          return ok({ success: true, ...result });
        }
      }

      return fail(`Endpoint ${method} ${normalizedPath} not found.`, 404);
    });
  } catch (error) {
    console.error('[ApiHandler Error]:', error);
    return fail(error.message || 'Internal server error.', 500);
  }
}
