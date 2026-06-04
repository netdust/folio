import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeBareTestDb } from '../test/harness.ts';
import { instanceSkills } from '../db/schema.ts';
import { getInstanceSkill, seedInstanceSkills } from './instance-skills.ts';
import { canBlessSkill, setSkillTrust } from './skill-trust.ts';

describe('canBlessSkill (T8)', () => {
  test('session user (no token) may bless', () => {
    expect(canBlessSkill(null, { id: 'u1' } as any)).toBe(true);
  });
  test('operator token (createdBy null, system origin) may bless', () => {
    expect(canBlessSkill({ createdBy: null } as any, null)).toBe(true);
  });
  test('MCP admin PAT (createdBy = a human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human' } as any, null)).toBe(false);
  });
  test('worker token (createdBy = human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human', agentId: 'a1' } as any, null)).toBe(false);
  });
  test('a token present (even createdBy null) with a session user → still bless (token path)', () => {
    expect(canBlessSkill({ createdBy: null } as any, { id: 'u1' } as any)).toBe(true);
  });
});

describe('setSkillTrust on instance_skills.trusted (T-E / invariant 11)', () => {
  test('an import/edit payload carrying trusted cannot set the column; setSkillTrust flips it', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);

    // The seeder seeds folio as trusted. Reset to false to exercise the flip
    // from a clean state, simulating a freshly-imported (untrusted) skill.
    await db.update(instanceSkills).set({ trusted: false }).where(eq(instanceSkills.name, 'folio'));
    const before = await getInstanceSkill(db, 'folio');
    expect(before?.trusted).toBe(false);

    // Simulate an import/edit surface writing body + frontmatter (with a forged
    // trusted key in frontmatter). The typed column is untouched — no
    // frontmatter→column path exists, so the column stays false.
    await db
      .update(instanceSkills)
      .set({ body: 'edited body', frontmatter: { trusted: true } })
      .where(eq(instanceSkills.name, 'folio'));
    const afterForge = await getInstanceSkill(db, 'folio');
    expect(afterForge?.trusted).toBe(false); // import cannot forge trust

    // The sanctioned mutator flips the typed column.
    await setSkillTrust(db, {
      slug: 'folio',
      trusted: true,
      token: { createdBy: null } as any, // operator (system-origin)
      sessionUser: null,
      actor: 'test',
    });
    expect((await getInstanceSkill(db, 'folio'))?.trusted).toBe(true);
  });

  test('setSkillTrust refuses a caller that cannot bless', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    await expect(
      setSkillTrust(db, {
        slug: 'folio',
        trusted: false,
        token: { createdBy: 'u-human' } as any, // MCP PAT — refused
        sessionUser: null,
        actor: 'test',
      }),
    ).rejects.toThrow(/forbidden/);
  });

  test('setSkillTrust throws on an unknown skill', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    await expect(
      setSkillTrust(db, {
        slug: 'no-such-skill',
        trusted: true,
        token: { createdBy: null } as any,
        sessionUser: null,
        actor: 'test',
      }),
    ).rejects.toThrow(/not found/);
  });
});
