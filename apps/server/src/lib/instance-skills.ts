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

import { eq } from 'drizzle-orm';
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
 * Idempotently seed the instance skills. `onConflictDoNothing` on the UNIQUE
 * `name` index makes re-seeding a no-op (and never resets a `trusted` flip an
 * admin made after the first seed).
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
      .onConflictDoNothing({ target: instanceSkills.name });
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
