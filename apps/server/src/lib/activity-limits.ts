/**
 * Limits shared across activity-note write paths.
 *
 * 2000 chars: enough for a few paragraphs of operational context ("called the
 * client, follow up Tue"), small enough that an agent loop can't balloon
 * events.payload and saturate GET /events.
 *
 * S8: was duplicated in routes/documents.ts and routes/workspace-documents.ts.
 * Both routes accept the same `note` field; the cap must stay in lockstep.
 */
export const ACTIVITY_NOTE_MAX = 2000;
