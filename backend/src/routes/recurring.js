import { Router } from 'express';
import {
  getRecurringRules,
  checkDueRecurring,
  processRecurringTransaction,
  skipRecurringTransaction,
  addRecurringTransaction,
  updateRecurringTransaction,
  deleteRecurringTransaction
} from '../services/recurringService.js';

const router = Router();

// GET /api/recurring
router.get('/', async (req, res) => {
  try {
    const rules = await getRecurringRules();
    res.json({ success: true, data: rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/recurring/due
router.get('/due', async (req, res) => {
  try {
    const due = await checkDueRecurring();
    res.json({ success: true, data: due });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recurring
router.post('/', async (req, res) => {
  try {
    const result = await addRecurringTransaction(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/recurring/:id
router.put('/:id', async (req, res) => {
  try {
    const result = await updateRecurringTransaction(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/recurring/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteRecurringTransaction(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recurring/:id/process
router.post('/:id/process', async (req, res) => {
  try {
    const result = await processRecurringTransaction(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recurring/:id/skip
router.post('/:id/skip', async (req, res) => {
  try {
    const { currentDueDate, frequency } = req.body;
    const result = await skipRecurringTransaction(req.params.id, currentDueDate, frequency);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
