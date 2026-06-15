import { describe, expect, test } from 'bun:test';
// Tier-A security-guard tests for lib/crypto.ts (AES-256-GCM, @noble/ciphers).
// Closes audit H9: a framing refactor must not silently pass while bricking every
// customer's stored AI key. Cites ARCHITECTURE-INVARIANTS.md inv. 2 & 7 (fail-closed
// crypto posture) — these tests are the proof those paths hold.
// NOTE: crypto.ts reads FOLIO_MASTER_KEY at MODULE LOAD. The test env (test/env-setup.ts)
// supplies '0123456789abcdef'×4. The hardcoded known-good ciphertext below MUST be
// generated under that exact key (see the generation command in the task).
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
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

describe('crypto key-length guard (fail-closed on a bad master key)', () => {
  // The fail-closed posture (ARCHITECTURE-INVARIANTS inv. 2/7) is: an invalid
  // FOLIO_MASTER_KEY must STOP the app at load — never boot with a degraded key.
  // Two guards enforce it in sequence: env.ts's Zod regex /^[0-9a-f]{64}$/ rejects
  // a malformed key FIRST, and crypto.ts's `KEY.length !== 32` is defense-in-depth
  // behind it. We assert the SPECIFIC failure cause (not a bare exit code), so a
  // path typo or unrelated load error can't masquerade as the guard firing — the
  // test-effectiveness blind spot a bare `catch(()=>exit(7))` had.
  async function loadCryptoWithKey(badKey: string): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        "import('./src/lib/crypto.ts').then(()=>process.exit(0)).catch((e)=>{console.error(String(e?.message ?? e));process.exit(7)})",
      ],
      {
        cwd: import.meta.dir.replace(/\/src\/lib$/, ''), // → apps/server
        env: { ...process.env, FOLIO_MASTER_KEY: badKey },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { code, stderr };
  }

  // Matches whichever key-validation guard fired — env.ts's "64 hex" Zod message
  // or crypto.ts's "decode to exactly 32 bytes" — but NOT a module-not-found / path
  // error, so the assertion is honest about WHAT failed closed.
  const KEY_GUARD = /64 hex|32 bytes|FOLIO_MASTER_KEY/i;

  test('a non-hex / short FOLIO_MASTER_KEY fails closed at load with a key-validation error', async () => {
    const { code, stderr } = await loadCryptoWithKey('ab'.repeat(8)); // 16 hex = 8 bytes ≠ 32
    expect(code).toBe(7);
    expect(stderr).toMatch(KEY_GUARD); // the key guard, not a path/import error
    expect(stderr).not.toMatch(/Cannot find module|Module not found|resolve/i);
  });

  test('an empty FOLIO_MASTER_KEY also fails closed with a key-validation error', async () => {
    const { code, stderr } = await loadCryptoWithKey('');
    expect(code).toBe(7);
    expect(stderr).toMatch(KEY_GUARD);
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
