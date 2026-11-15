import crypto from 'node:crypto';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from '../domain/auth.js';
import { fail, ok, parseBody, verifyApiKey } from '../http.js';
import { FIREBASE_PROJECT_ID, FIREBASE_TOKEN_ISSUER } from '../config/firebase.js';
import {
  createUser,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  updateUser,
} from '../repository.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.rawPath || event.path || event.requestContext?.http?.path || '';

    // Handle CORS preflight OPTIONS
    if (method === 'OPTIONS') {
      return ok({ status: 'ok' }, 200);
    }

    // 1. Sign Up (Password based)
    if (path === '/auth/signup' && method === 'POST') {
      const body = parseBody(event);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : email.split('@')[0];
      const dob = typeof body.dob === 'string' ? body.dob.trim() : '';

      if (!email || !EMAIL_REGEX.test(email)) {
        return fail('Please provide a valid email address.', 400);
      }
      if (!password || password.length < 6) {
        return fail('Password must be at least 6 characters long.', 400);
      }

      // Check if user already exists
      const existingUser = await getUserByEmail(email);
      if (existingUser) {
        return fail('An account with this email address already exists. Please sign in.', 409);
      }

      const id = `usr_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const passwordHash = hashPassword(password);

      const newUser = await createUser({
        id,
        email,
        name,
        dob,
        provider: 'email',
        passwordHash,
      });

      const token = signJwt({
        sub: newUser.id,
        email: newUser.email,
        name: newUser.name,
        provider: 'email',
      });

      return ok(
        {
          success: true,
          user: {
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            dob: newUser.dob || '',
            provider: 'email',
          },
          token,
        },
        201
      );
    }

    // 2. Sign In (Password based)
    if (path === '/auth/signin' && method === 'POST') {
      const body = parseBody(event);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!email || !password) {
        return fail('Email and password are required.', 400);
      }

      const user = await getUserByEmail(email);
      if (!user) {
        return fail('Invalid email or password.', 401);
      }

      if (user.provider === 'google' && !user.passwordHash) {
        return fail(
          'This account was created with Google Sign-In. Please tap "Continue with Google".',
          400
        );
      }

      const isPasswordValid = verifyPassword(password, user.passwordHash);
      if (!isPasswordValid) {
        return fail('Invalid email or password.', 401);
      }

      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider || 'email',
      });

      return ok(
        {
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            dob: user.dob || '',
            provider: user.provider || 'email',
          },
          token,
        },
        200
      );
    }

    // 3. Sign In with Google / Firebase Auth
    if (path === '/auth/google' && method === 'POST') {
      const body = parseBody(event);
      let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      let name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '';
      let avatar = typeof body.avatar === 'string' ? body.avatar : '';
      let googleId = typeof body.googleId === 'string' ? body.googleId : '';
      const dob = typeof body.dob === 'string' ? body.dob.trim() : '';

      // If Firebase ID token is provided, decode and verify claims
      if (body.idToken && typeof body.idToken === 'string') {
        try {
          const parts = body.idToken.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (payload.aud === FIREBASE_PROJECT_ID || payload.iss === FIREBASE_TOKEN_ISSUER) {
              if (payload.email) email = payload.email.toLowerCase();
              if (payload.name) name = payload.name;
              if (payload.picture) avatar = payload.picture;
              if (payload.sub) googleId = payload.sub;
            }
          }
        } catch {
          // Fall back to body parameters
        }
      }

      if (!name) name = email ? email.split('@')[0] : 'Google User';

      if (!email || !EMAIL_REGEX.test(email)) {
        return fail('A valid Google email is required.', 400);
      }

      let user = null;
      if (googleId) {
        user = await getUserByGoogleId(googleId);
      }
      if (!user) {
        user = await getUserByEmail(email);
      }

      if (user) {
        // Link or refresh Google details if needed
        const updates = {};
        if (googleId && user.googleId !== googleId) updates.googleId = googleId;
        if (avatar && user.avatar !== avatar) updates.avatar = avatar;
        if (name && user.name !== name) updates.name = name;
        if (dob && user.dob !== dob) updates.dob = dob;
        if (Object.keys(updates).length > 0) {
          user = await updateUser(user.id, updates);
        }
      } else {
        // Create new Google user
        const id = `usr_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
        user = await createUser({
          id,
          email,
          name,
          avatar,
          dob,
          provider: 'google',
          googleId: googleId || `gid_${Date.now()}`,
        });
      }

      const token = signJwt({
        sub: user.id,
        email: user.email,
        name: user.name,
        provider: 'google',
      });

      return ok(
        {
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            dob: user.dob || '',
            provider: 'google',
          },
          token,
        },
        200
      );
    }

    // 4. Session Validation (Me)
    if (path === '/auth/me' && method === 'GET') {
      const authHeader =
        event.headers?.authorization ||
        event.headers?.Authorization ||
        '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (!token) {
        return fail('Authorization Bearer token is required.', 401);
      }

      const decoded = verifyJwt(token);
      if (!decoded || !decoded.sub) {
        return fail('Session expired or invalid token. Please sign in again.', 401);
      }

      const user = await getUserById(decoded.sub);
      if (!user) {
        return fail('User account not found.', 404);
      }

      return ok(
        {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            dob: user.dob || '',
            provider: user.provider,
          },
        },
        200
      );
    }

    return fail('Endpoint not found.', 404);
  } catch (error) {
    return fail(error.message || 'Authentication processing error.', 500);
  }
}

