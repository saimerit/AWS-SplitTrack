import { Router } from 'express';
import { isFirebaseInitialized } from '../config/firebase.js';
import transactionsRouter from './transactions.js';
import recurringRouter from './recurring.js';
import templatesRouter from './templates.js';
import adminRouter from './admin.js';

const router = Router();

router.get('/health', (req, res) => {
  const ready = isFirebaseInitialized();
  res.json({
    status: 'ok',
    service: 'splittrack-backend',
    firebase: ready ? 'connected' : 'unconfigured (missing backend/service-account.json)',
    timestamp: new Date().toISOString()
  });
});

// Middleware: Return clean 503 instead of crashing when Firebase Admin credentials are not provided
const requireFirebase = (req, res, next) => {
  if (!isFirebaseInitialized()) {
    return res.status(503).json({
      success: false,
      error: "Firebase Admin is unconfigured: 'service-account.json' not found in backend/. Client fallback active.",
      fallback: true
    });
  }
  next();
};

router.use('/transactions', requireFirebase, transactionsRouter);
router.use('/recurring', requireFirebase, recurringRouter);
router.use('/templates', requireFirebase, templatesRouter);
router.use('/admin', requireFirebase, adminRouter);

export default router;
