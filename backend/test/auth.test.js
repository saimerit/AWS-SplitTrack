import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
} from '../src/domain/auth.js';

test('hashes password with random salt and verifies correctly', () => {
  const password = 'SuperSecretPassword123!';
  const hash = hashPassword(password);

  assert.ok(hash.includes(':'), 'Hash must contain salt delimiter');
  assert.equal(verifyPassword(password, hash), true, 'Valid password must verify');
  assert.equal(verifyPassword('WrongPassword', hash), false, 'Wrong password must fail');
  assert.equal(verifyPassword('', hash), false, 'Empty password must fail');
  assert.equal(verifyPassword(password, 'invalid-hash'), false, 'Corrupted hash must fail');
});

test('generates different hashes for the same password due to salting', () => {
  const pwd = 'ConsistentPassword';
  const hash1 = hashPassword(pwd);
  const hash2 = hashPassword(pwd);

  assert.notEqual(hash1, hash2, 'Salts must be unique per hash');
  assert.equal(verifyPassword(pwd, hash1), true);
  assert.equal(verifyPassword(pwd, hash2), true);
});

test('signs and verifies standard HS256 JWT correctly', () => {
  const payload = {
    sub: 'user_alex_123',
    email: 'alex@example.com',
    name: 'Alex Smith',
    provider: 'email',
  };

  const secret = 'test-secret-key-32chars-for-signing';
  const token = signJwt(payload, secret);

  assert.ok(token);
  assert.equal(token.split('.').length, 3);

  const decoded = verifyJwt(token, secret);
  assert.ok(decoded);
  assert.equal(decoded.sub, payload.sub);
  assert.equal(decoded.email, payload.email);
  assert.equal(decoded.name, payload.name);
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000));
});

test('rejects tampered or forged JWT tokens', () => {
  const secret = 'real-secret-12345678901234567890';
  const token = signJwt({ sub: 'user_1' }, secret);

  // Wrong secret
  assert.equal(verifyJwt(token, 'wrong-secret'), null);

  // Tampered payload
  const [h, p, s] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'user_admin' })).toString('base64url');
  const tamperedToken = `${h}.${tamperedPayload}.${s}`;
  assert.equal(verifyJwt(tamperedToken, secret), null);

  // Corrupted token format
  assert.equal(verifyJwt('not-a-token', secret), null);
});

test('userIdFrom and verifyApiKey recognize valid Bearer JWT', async () => {
  const { userIdFrom, verifyApiKey } = await import('../src/http.js');
  const token = signJwt({ sub: 'user_jwt_456', email: 'jwt@example.com' });

  const eventWithJwt = {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };

  assert.equal(userIdFrom(eventWithJwt), 'user_jwt_456');
  assert.equal(verifyApiKey(eventWithJwt), true);

  const eventWithBadJwt = {
    headers: {
      authorization: 'Bearer bad.token.value',
      'x-user-id': 'fallback-user',
    },
  };

  assert.equal(userIdFrom(eventWithBadJwt), 'fallback-user');
});

