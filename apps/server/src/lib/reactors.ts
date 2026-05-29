/**
 * Phase 3 Sub-phase C.3 (Task C-11) — the reactor registry.
 *
 * The single source of truth for which reactors the durable dispatcher
 * (event-dispatcher.ts) fans events out to. Relocated here from the C-10b
 * dispatcher placeholder so adding a reactor is a one-line edit that doesn't
 * touch the dispatcher loop.
 *
 * Import-cycle note: this module imports `triggerMatcher` from
 * `trigger-matcher.ts`, which imports the `Reactor` TYPE (type-only) from
 * `event-dispatcher.ts`, which imports `REACTORS` from here. The cycle is safe
 * because `startEventDispatcher` reads `REACTORS` only inside the interval
 * callback (runtime), never at module-eval time.
 */

import type { Reactor } from './event-dispatcher.ts';
import { triggerMatcher } from './trigger-matcher.ts';

export const REACTORS: readonly Reactor[] = [triggerMatcher];
