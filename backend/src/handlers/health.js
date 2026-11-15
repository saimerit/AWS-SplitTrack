import { ok } from '../http.js';

export const handler = async () =>
  ok({
    status: 'ok',
    service: 'splittrack-api',
    version: '1.2.0',
    timestamp: new Date().toISOString(),
  });
