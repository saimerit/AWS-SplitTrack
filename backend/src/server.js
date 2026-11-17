import express from 'express';
import cors from 'cors';
import apiRouter from './routes/index.js';
import { initFirebase, requestContextStorage } from './config/firebase.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Tenant & Ledger isolation context middleware
app.use((req, res, next) => {
  const userId = req.headers['x-user-id'] || req.query.userId || req.query.user_id || process.env.LEDGER_ID || 'main-ledger';
  const ledgerScope = String(userId).startsWith('USER#') ? String(userId).slice(5) : String(userId);
  requestContextStorage.run({ ledgerId: ledgerScope, userId: ledgerScope }, () => {
    next();
  });
});


// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// API Routes
app.use('/api', apiRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[ServerError]', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

// Start Server
if (process.env.NODE_ENV !== 'test') {
  initFirebase();
  app.listen(PORT, () => {
    console.log(`🚀 SplitTrack Backend API Server running on http://localhost:${PORT}`);
    console.log(`📋 API Health check: http://localhost:${PORT}/api/health`);
  });
}

export default app;
