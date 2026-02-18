import crypto from 'crypto';
import { ensureUser, getUserByEmail, updateProfile } from './storage.js';

export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export async function seedTestUser() {
  const testEmail = 'a@b.c';
  const testPasswordHash = hashPassword('3087');
  const existing = await getUserByEmail(testEmail);
  if (!existing) {
    await ensureUser({
      email: testEmail,
      passwordHash: testPasswordHash,
      planTier: 'free',
      consent: { privacy: true, terms: true }
    });
    return;
  }

  // Keep test credentials stable on every startup.
  await updateProfile(testEmail, {
    passwordHash: testPasswordHash,
    consent: { privacy: true, terms: true }
  });
}

export async function resolveUserFromRequest(req) {
  const email = req.body?.user || req.query?.user || '';
  const password = req.body?.password || req.query?.password || '';
  if (!email || !password) return null;

  const user = await getUserByEmail(email);
  if (!user) return null;
  if (user.passwordHash !== hashPassword(password)) return null;

  return { email, via: 'password' };
}
