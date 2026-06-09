import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'bun:test';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { FOLIO_SKILL_BODY, FOLIO_SKILL_SLUG } from './system-skills.ts';
import { getInstanceSkill, seedInstanceSkills } from './instance-skills.ts';

describe('instance-skills seeder/loader', () => {
  test('seedInstanceSkills idempotently seeds the folio skill', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    await seedInstanceSkills(db); // idempotent — UNIQUE name
    const rows = await db.select().from(schema.instanceSkills);
    expect(rows.filter((r) => r.name === FOLIO_SKILL_SLUG).length).toBe(1);

    const folio = await getInstanceSkill(db, FOLIO_SKILL_SLUG);
    expect(folio).toBeDefined();
    expect(folio?.body.length).toBeGreaterThan(100);
  });

  test('the seeded folio skill is TRUSTED via the typed column (not frontmatter)', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    const folio = await getInstanceSkill(db, FOLIO_SKILL_SLUG);
    expect(folio?.trusted).toBe(true);
    // The trust lives on the column — frontmatter must NOT carry it (T-E guard:
    // a future import/edit writing frontmatter cannot forge trust).
    expect((folio?.frontmatter as Record<string, unknown>).trusted).toBeUndefined();
  });

  test('getInstanceSkill returns undefined for an unknown name', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    expect(await getInstanceSkill(db, 'no-such-skill')).toBeUndefined();
  });

  // Re-seeding upgrades the skill BODY to the shipped version (a Folio upgrade
  // ships an improved skill; existing instances must pick it up — the seed-once
  // gap). Previously onConflictDoNothing left the stale body forever.
  test('re-seeding refreshes a stale skill body to the shipped version', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db);
    // Simulate an OLD instance whose stored body predates a Folio upgrade.
    await db
      .update(schema.instanceSkills)
      .set({ body: 'STALE OLD SKILL BODY' })
      .where(eq(schema.instanceSkills.name, FOLIO_SKILL_SLUG));
    // The upgrade re-runs the seeder.
    await seedInstanceSkills(db);
    const folio = await getInstanceSkill(db, FOLIO_SKILL_SLUG);
    expect(folio?.body).toBe(FOLIO_SKILL_BODY); // refreshed to shipped
    // Still exactly one row (upsert, not a duplicate insert).
    const rows = await db.select().from(schema.instanceSkills);
    expect(rows.filter((r) => r.name === FOLIO_SKILL_SLUG).length).toBe(1);
  });

  // The load-bearing invariant (why this can't be a blind upsert): an admin's
  // runtime `trusted` flip (via set_skill_trust) MUST survive a body upgrade.
  // The body refreshes; the trust column is never overwritten by the seeder.
  test('a body upgrade PRESERVES an admin trusted-flip (never resets the column)', async () => {
    const { db } = await makeBareTestDb();
    await seedInstanceSkills(db); // seeds trusted = true
    // Admin UNblesses the skill at runtime AND the body is stale (pre-upgrade).
    await db
      .update(schema.instanceSkills)
      .set({ trusted: false, body: 'STALE OLD SKILL BODY' })
      .where(eq(schema.instanceSkills.name, FOLIO_SKILL_SLUG));
    // Upgrade re-seeds.
    await seedInstanceSkills(db);
    const folio = await getInstanceSkill(db, FOLIO_SKILL_SLUG);
    expect(folio?.body).toBe(FOLIO_SKILL_BODY); // body DID upgrade
    expect(folio?.trusted).toBe(false); // admin's decision SURVIVED
  });
});
