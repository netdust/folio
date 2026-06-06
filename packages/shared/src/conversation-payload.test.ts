import { test, expect } from 'bun:test';
import { ENTITY_TYPES, parseMessagePayload } from './conversation-payload.ts';

// ENTITY_TYPES — the single closed enum both sides import.
test('ENTITY_TYPES includes every navigable type incl. trigger', () => {
  // `trigger` is a real workspace-doc surface the ?wdoc= slideover resolves;
  // it was missing from the pre-shared enum (Cluster-5 fix). Guard its presence
  // so a future trim doesn't silently drop a resolvable type.
  expect(ENTITY_TYPES).toContain('agent');
  expect(ENTITY_TYPES).toContain('trigger');
  expect(ENTITY_TYPES).toContain('document');
  expect(ENTITY_TYPES).toContain('work_item');
});

test('ENTITY_TYPES excludes types with no resolvable destination', () => {
  // project/view/run/conversation were dropped (Cluster-6 review) — they had no
  // reachable destination and degraded to the workspace root. Lock the trim so
  // they aren't re-added without a real route.
  for (const dropped of ['project', 'view', 'run', 'conversation']) {
    expect(ENTITY_TYPES as readonly string[]).not.toContain(dropped);
  }
});

// parseMessagePayload — tolerant: degrade to {} on every non-object input.
test('parseMessagePayload returns {} for null/empty', () => {
  expect(parseMessagePayload(null)).toEqual({});
  expect(parseMessagePayload('')).toEqual({});
});

test('parseMessagePayload returns the object for a JSON object', () => {
  expect(parseMessagePayload('{"a":1}')).toEqual({ a: 1 });
});

test('parseMessagePayload degrades valid-JSON-but-non-object to {} (null/number/string)', () => {
  // Bites: a naive `JSON.parse(p) as T` returns null/42/"x" and a downstream
  // p.field deref throws out of the renderer/serializer.
  expect(parseMessagePayload('null')).toEqual({});
  expect(parseMessagePayload('42')).toEqual({});
  expect(parseMessagePayload('"hi"')).toEqual({});
});

test('parseMessagePayload degrades a JSON array to {} (typeof [] === object trap)', () => {
  // Bites: `typeof [] === 'object'` so a guard checking only typeof lets an
  // array through; setMessageChosen would then mutate an array index.
  expect(parseMessagePayload('[1,2,3]')).toEqual({});
  expect(parseMessagePayload('[]')).toEqual({});
});

test('parseMessagePayload returns {} for malformed JSON', () => {
  expect(parseMessagePayload('{not json')).toEqual({});
});
