/**
 * Phase 4 (drop-workspace-tenancy), Task 14 — instance_skills seeder + loader.
 *
 * The folio skill (and any future instance-level skill) lives in the
 * `instance_skills` table, NOT a `__system` workspace Skills project. This file
 * is the ONLY writer of seeded skills + the canonical reader by name.
 *
 * SECURITY (T-E / invariant 11): `trusted` is a TYPED COLUMN on `instance_skills`,
 * never a frontmatter key. The seeder sets the column directly and STRIPS any
 * `trusted` key out of the stored frontmatter, so an import/edit surface that
 * writes only body+frontmatter physically cannot forge trust. Only `setSkillTrust`
 * (Task 15) flips the column.
 */

import { eq, inArray, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { type DB } from '../db/client.ts';
import { instanceSkills, type InstanceSkill } from '../db/schema.ts';
import {
  FOLIO_SKILL_BODY,
  FOLIO_SKILL_FRONTMATTER,
  FOLIO_SKILL_SLUG,
} from './system-skills.ts';

/**
 * The set of instance skills seeded on boot. Each entry's `trusted` becomes the
 * typed column; `frontmatter` is stored WITHOUT any `trusted` key (stripped here
 * so the column is the sole source of trust).
 */
const SEEDED_INSTANCE_SKILLS = [
  {
    name: FOLIO_SKILL_SLUG,
    body: FOLIO_SKILL_BODY,
    // Strip `trusted` from the frontmatter — it rides the typed column now.
    frontmatter: stripTrusted(FOLIO_SKILL_FRONTMATTER),
    trusted: FOLIO_SKILL_FRONTMATTER.trusted === true,
  },
] as const;

function stripTrusted(fm: Record<string, unknown>): Record<string, unknown> {
  const { trusted: _ignored, ...rest } = fm;
  return rest;
}

/**
 * Idempotently seed the instance skills, and UPGRADE the stored body/frontmatter
 * to the shipped version when they drift (a Folio upgrade ships an improved
 * skill — existing instances must pick it up, not stay frozen on first-seed).
 *
 * The conflict UPDATE refreshes ONLY `body` + `frontmatter`; it DELIBERATELY
 * never touches `trusted` — that column is the admin's runtime decision
 * (`set_skill_trust`) and a re-seed must not reset it (invariant 11). So the
 * `set` clause omits `trusted` entirely: an admin who un-blessed a skill keeps
 * it un-blessed across upgrades, while still getting the new body.
 *
 * `setWhere` gates the write on the body actually differing, so an unchanged
 * re-seed (the common boot case) is a true no-op — no needless write.
 */
export async function seedInstanceSkills(db: DB): Promise<void> {
  for (const skill of SEEDED_INSTANCE_SKILLS) {
    await db
      .insert(instanceSkills)
      .values({
        id: nanoid(),
        name: skill.name,
        body: skill.body,
        frontmatter: skill.frontmatter,
        trusted: skill.trusted,
      })
      .onConflictDoUpdate({
        target: instanceSkills.name,
        // NOTE: `trusted` is intentionally absent — never overwrite the admin's
        // runtime trust decision on a re-seed (invariant 11).
        set: { body: skill.body, frontmatter: skill.frontmatter },
        // Only write when the body actually changed (no-op on an unchanged boot).
        setWhere: ne(instanceSkills.body, skill.body),
      });
  }
}

/** Resolve a single instance skill by its unique name. */
export async function getInstanceSkill(
  db: DB,
  name: string,
): Promise<InstanceSkill | undefined> {
  return db.query.instanceSkills.findFirst({
    where: eq(instanceSkills.name, name),
  });
}

/**
 * Resolve many instance skills in ONE query (avoids the per-skill N+1 in the
 * runner's skill-load loop). Returns a name→row map; callers detect a
 * declared-but-absent skill by a missing key.
 */
export async function getInstanceSkillsByNames(
  db: DB,
  names: string[],
): Promise<Map<string, InstanceSkill>> {
  if (names.length === 0) return new Map();
  const rows = await db.query.instanceSkills.findMany({
    where: inArray(instanceSkills.name, names),
  });
  return new Map(rows.map((r) => [r.name, r]));
}
