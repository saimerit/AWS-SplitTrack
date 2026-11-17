import { Router } from 'express';
import { exportFullBackup, importFromBackup, nukeCollection } from '../services/adminService.js';

const router = Router();

// GET /api/admin/backup (Full database dump)
router.get('/backup', async (req, res) => {
  try {
    const backup = await exportFullBackup();
    res.json(backup);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/restore (Restore database from dump)
router.post('/restore', async (req, res) => {
  try {
    const result = await importFromBackup(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/nuke/:collection (Clear a collection)
router.post('/nuke/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const result = await nukeCollection(collection);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
