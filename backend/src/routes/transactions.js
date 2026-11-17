import { Router } from 'express';
import {
  addTransaction,
  updateTransaction,
  deleteTransaction,
  restoreTransaction,
  permanentDeleteTransaction,
  bulkUpdateTransactions,
  rectifyAllStats,
  repairAllTransactionStats
} from '../services/transactionService.js';
import { getDb, LEDGER_ID } from '../config/firebase.js';

const router = Router();
const COLLECTION_PATH = `ledgers/${LEDGER_ID}/transactions`;

// GET /api/transactions (list active transactions)
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const limit = parseInt(req.query.limit, 10) || 50;
    const includeDeleted = req.query.deleted === 'true';

    let q = db.collection(COLLECTION_PATH).orderBy('timestamp', 'desc');
    if (!includeDeleted) {
      q = q.where('isDeleted', '==', false);
    }
    q = q.limit(limit);

    const snap = await q.get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, count: transactions.length, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions (create transaction)
router.post('/', async (req, res) => {
  try {
    const txnData = req.body;
    if (!txnData || !txnData.expenseName || txnData.amount === undefined) {
      return res.status(400).json({ success: false, error: 'expenseName and amount are required' });
    }
    const result = await addTransaction(txnData);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/transactions/:id (update transaction)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { oldParentId, ...txnData } = req.body;
    const result = await updateTransaction(id, txnData, oldParentId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/transactions/:id (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { parentId } = req.query;
    const result = await deleteTransaction(id, parentId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/:id/restore (restore soft deleted)
router.post('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await restoreTransaction(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/transactions/:id/permanent (hard delete)
router.delete('/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await permanentDeleteTransaction(id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/bulk (bulk update)
router.post('/bulk', async (req, res) => {
  try {
    const { ids, updateData } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ success: false, error: 'ids array required' });
    }
    const result = await bulkUpdateTransactions(ids, updateData);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/rectify (recompute balances)
router.post('/rectify', async (req, res) => {
  try {
    const { participants = [] } = req.body;
    const result = await rectifyAllStats(participants);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/repair (deep repair)
router.post('/repair', async (req, res) => {
  try {
    const result = await repairAllTransactionStats();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
