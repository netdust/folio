/**
 * Session-based auth. Cookies hold an opaque session ID; the server looks up
 * the session row to find the user. Simpler than JWT for a self-hosted app.
 */

import { sha256 } from '@noble/hashes/sha256';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { authSessions, users } from '../db/schema.ts';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'argon2id' });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = nanoid(40);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(authSessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function readSession(sessionId: string) {
  const row = await db.query.authSessions.findFirst({
    where: eq(authSessions.id, sessionId),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  return user ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId));
}

/** Hash a token (magic-link token, API bearer token) for storage. */
export function hashToken(token: string): string {
  return Buffer.from(sha256(token)).toString('hex');
}

/** Generate a random magic-link token (returned to email, not stored). */
export function newMagicToken(): string {
  return nanoid(32);
}

/** Generate a customer-facing API token like `folio_pat_xxxx`. */
export function newApiToken(): { token: string; hash: string } {
  const token = `folio_pat_${nanoid(40)}`;
  return { token, hash: hashToken(token) };
}
