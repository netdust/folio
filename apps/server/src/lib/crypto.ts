/**
 * Authenticated encryption for AI provider keys stored at rest.
 * Uses AES-256-GCM via @noble/ciphers (pure JS, no native deps).
 *
 * Format: base64(iv || ciphertext || tag), each chunk separated for clarity.
 */

import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { env } from '../env.ts';

const KEY = Uint8Array.from(Buffer.from(env.FOLIO_MASTER_KEY, 'hex'));

if (KEY.length !== 32) {
  throw new Error('FOLIO_MASTER_KEY must decode to exactly 32 bytes');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = gcm(KEY, iv);
  const ct = cipher.encrypt(new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return Buffer.from(combined).toString('base64');
}

export function decryptSecret(ciphertext: string): string {
  const combined = Uint8Array.from(Buffer.from(ciphertext, 'base64'));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const cipher = gcm(KEY, iv);
  const pt = cipher.decrypt(ct);
  return new TextDecoder().decode(pt);
}
