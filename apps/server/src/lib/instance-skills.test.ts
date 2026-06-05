import { describe, expect, test } from 'bun:test';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { FOLIO_SKILL_SLUG } from './system-skills.ts';
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
});
