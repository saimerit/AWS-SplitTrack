import crypto from 'node:crypto';

const DEFAULT_JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.API_KEY ||
  'splittrack-secure-jwt-signing-secret-key-32chars';

/**
 * Hash a password using scrypt with a unique random salt.
 * Returns salt:derivedKey hex string.
 */
export function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored salt:derivedKey hash.
 * Uses timing-safe equality comparison.
 */
export function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string') {
    return false;
  }
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, key] = parts;
  try {
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    if (keyBuffer.length !== derivedKey.length) {
      return false;
    }
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Encode an object or string to base64url without padding.
 */
function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Decode a base64url string to Buffer.
 */
function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

/**
 * Sign a standard HS256 JWT.
 * Defaults to 30 days expiration.
 */
export function signJwt(payload, secret = DEFAULT_JWT_SECRET, expiresInDays = 30) {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: nowSec,
    exp: nowSec + expiresInDays * 86400,
  };

  const headerB64 = base64UrlEncode(header);
  const payloadB64 = base64UrlEncode(fullPayload);
  const dataToSign = `${headerB64}.${payloadB64}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest();

  const signatureB64 = base64UrlEncode(signature);
  return `${dataToSign}.${signatureB64}`;
}

/**
 * Verify and decode an HS256 JWT.
 * Throws or returns null if expired or signature mismatch.
 */
export function verifyJwt(token, secret = DEFAULT_JWT_SECRET) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const dataToSign = `${headerB64}.${payloadB64}`;

  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest();
    const providedSignature = base64UrlDecode(signatureB64);

    if (expectedSignature.length !== providedSignature.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(expectedSignature, providedSignature)) {
      return null;
    }

    const payloadJson = base64UrlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadJson);

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

