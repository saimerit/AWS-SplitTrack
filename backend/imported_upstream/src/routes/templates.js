import { Router } from 'express';
import {
  getTemplates,
  addTemplate,
  updateTemplate,
  deleteTemplate
} from '../services/templateService.js';

const router = Router();

// GET /api/templates
router.get('/', async (req, res) => {
  try {
    const templates = await getTemplates();
    res.json({ success: true, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/templates
router.post('/', async (req, res) => {
  try {
    const result = await addTemplate(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/templates/:id
router.put('/:id', async (req, res) => {
  try {
    const result = await updateTemplate(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
