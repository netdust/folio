// Tier-A security-guard tests for lib/crypto.ts (AES-256-GCM, @noble/ciphers).
// Closes audit H9: a framing refactor must not silently pass while bricking every
// customer's stored AI key. Cites ARCHITECTURE-INVARIANTS.md inv. 2 & 7 (fail-closed
// crypto posture) — these tests are the proof those paths hold.
// NOTE: crypto.ts reads FOLIO_MASTER_KEY at MODULE LOAD. The test env (test/env-setup.ts)
// supplies '0123456789abcdef'×4. The hardcoded known-good ciphertext below MUST be
// generated under that exact key (see the generation command in the task).
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { describe, expect, test } from 'bun:test';
import { decryptSecret, encryptSecret } from './crypto.ts';

describe('crypto round-trip', () => {
  test('encrypt→decrypt returns the original (ascii, unicode, empty)', () => {
    for (const s of ['hello', 'sk-ant-апи-🔑-key', '']) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  test('two encryptions of the same plaintext differ (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
});

describe('crypto tamper detection', () => {
  test('flipping a ciphertext byte makes decrypt throw (GCM tag)', () => {
    const ct = encryptSecret('tamper-me');
    const buf = Buffer.from(ct, 'base64');
    // Flip the last byte — part of the 16-byte GCM tag (@noble appends it to the
    // ciphertext), so any flip breaks authentication. Buffer is always non-empty
    // (iv[12] + ct[>=16-byte tag]); the index assert satisfies noUncheckedIndexedAccess.
    const last = buf.length - 1;
    expect(buf[last]).toBeDefined();
    buf[last] = (buf[last] as number) ^ 0xff;
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });
});

describe('crypto wrong-key failure', () => {
  test('ciphertext from a different key fails to decrypt', () => {
    // Frame a ciphertext under a DIFFERENT 32-byte key, identical iv||ct layout,
    // then ask decryptSecret (env key) to open it. GCM auth must reject it.
    const otherKey = randomBytes(32);
    const iv = randomBytes(12);
    const ct = gcm(otherKey, iv).encrypt(new TextEncoder().encode('secret'));
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    expect(() => decryptSecret(Buffer.from(combined).toString('base64'))).toThrow();
  });
});

describe('crypto key-length guard', () => {
  test('a non-32-byte FOLIO_MASTER_KEY makes the module throw at load', async () => {
    // The guard is a top-level throw at import, so exercise it by importing crypto.ts
    // fresh in a child Bun process under a bad key. 'ab'×8 = 16 hex = 8 bytes ≠ 32.
    const proc = Bun.spawn(
      ['bun', '-e', "import('./src/lib/crypto.ts').then(()=>process.exit(0)).catch(()=>process.exit(7))"],
      {
        cwd: import.meta.dir.replace(/\/src\/lib$/, ''),
        env: { ...process.env, FOLIO_MASTER_KEY: 'ab'.repeat(8) },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    expect(await proc.exited).toBe(7);
  });
});

describe('crypto ciphertext-format stability', () => {
  // Generated under the PUBLIC test key (test/env-setup.ts) via:
  //   FOLIO_MASTER_KEY=0123...def bun -e "import('./src/lib/crypto.ts')
  //     .then(m=>console.log(m.encryptSecret('folio-known-good-secret')))"
  // Not a real customer secret — committing it is the whole point of the fixture:
  // a framing refactor that would brick stored keys turns this RED.
  const KNOWN_GOOD = 'TaoPYOz2IhOmEmTUqYLBSzT226sOEWGERvt4vRAqTq4Ggn0FlRED3UCUcKNAwL25TR+8';
  const KNOWN_PLAINTEXT = 'folio-known-good-secret';

  test('a previously-encrypted ciphertext still decrypts to the known plaintext', () => {
    expect(decryptSecret(KNOWN_GOOD)).toBe(KNOWN_PLAINTEXT);
  });
});
