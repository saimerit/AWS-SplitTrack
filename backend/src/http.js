import { verifyJwt } from './domain/auth.js';

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
  'access-control-allow-headers': 'content-type,x-user-id,x-api-key,x-admin-key,authorization',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export const ok = (body, statusCode = 200) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

export const fail = (message, statusCode = 400) =>
  ok({ message: typeof message === 'string' ? message : message?.message || 'Request failed' }, statusCode);

export const parseBody = (event) => {
  if (!event.body) return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
};

const getHeader = (headersObj = {}, name) => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headersObj)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
};

export const userIdFrom = (event) => {
  const jwtSub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (jwtSub) return jwtSub;

  const authHeader = getHeader(event.headers, 'authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const decoded = verifyJwt(token);
    if (decoded?.sub) return decoded.sub;
  }

  const userHeader = getHeader(event.headers, 'x-user-id');
  if (userHeader && userHeader.trim()) return userHeader.trim();

  const queryUserId = event.queryStringParameters?.userId || event.queryStringParameters?.user_id;
  if (queryUserId && queryUserId.trim()) return queryUserId.trim();

  return null;
};

export const apiKeyFrom = (event) =>
  getHeader(event.headers, 'x-api-key') ||
  event.queryStringParameters?.apiKey ||
  event.queryStringParameters?.api_key;

export const verifyApiKey = (event) => {
  const authHeader = getHeader(event.headers, 'authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const decoded = verifyJwt(token);
    if (decoded?.sub) return true;
  }

  const expectedKey = process.env.API_KEY;
  if (!expectedKey) return true; // Open if no key configured

  const providedKey = apiKeyFrom(event);
  const adminKey = getHeader(event.headers, 'x-admin-key');

  if (providedKey === expectedKey) return true;
  if (adminKey && adminKey === process.env.ADMIN_API_KEY) return true;

  return false;
};

export const verifyAdminKey = (event) => {
  const expectedAdmin = process.env.ADMIN_API_KEY;
  if (!expectedAdmin) return true; // Open if unconfigured
  const adminKey = getHeader(event.headers, 'x-admin-key') || event.queryStringParameters?.adminKey;
  return adminKey === expectedAdmin;
};

