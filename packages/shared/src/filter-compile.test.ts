import { expect, test } from 'bun:test';
import { type FilterAST, FilterCompileError, filterCompile } from './filter-compile.ts';

// filterCompile ALWAYS returns the top-level `and` node (see filter-compile.ts).
// Narrow the FilterAST union to that variant so tests can read `.clauses`
// without TS flagging the `cmp` arm (which has no clauses).
function asAnd(ast: FilterAST): Extract<FilterAST, { kind: 'and' }> {
  if (ast.kind !== 'and') throw new Error(`expected top-level 'and' node, got '${ast.kind}'`);
  return ast;
}

test('scalar shorthand becomes $eq', () => {
  const ast = filterCompile({ status: 'todo' });
  expect(ast).toEqual({
    kind: 'and',
    clauses: [{ kind: 'cmp', key: 'status', op: '$eq', value: 'todo' }],
  });
});

test('$in operator', () => {
  const ast = filterCompile({ status: { $in: ['todo', 'done'] } });
  expect(asAnd(ast).clauses[0]).toEqual({
    kind: 'cmp',
    key: 'status',
    op: '$in',
    value: ['todo', 'done'],
  });
});

test('multiple keys are AND-combined', () => {
  const ast = filterCompile({ status: 'todo', type: 'work_item' });
  expect(asAnd(ast).clauses).toHaveLength(2);
});

test('$exists boolean', () => {
  const ast = filterCompile({ priority: { $exists: true } });
  expect(asAnd(ast).clauses[0]).toEqual({
    kind: 'cmp',
    key: 'priority',
    op: '$exists',
    value: true,
  });
});

test('comparators $gt $gte $lt $lte $ne', () => {
  for (const op of ['$gt', '$gte', '$lt', '$lte', '$ne'] as const) {
    const ast = filterCompile({ count: { [op]: 5 } });
    expect(asAnd(ast).clauses[0]).toEqual({ kind: 'cmp', key: 'count', op, value: 5 });
  }
});

test('$contains operator with a single string value', () => {
  const ast = filterCompile({ labels: { $contains: 'bug' } });
  expect(asAnd(ast).clauses[0]).toEqual({
    kind: 'cmp',
    key: 'labels',
    op: '$contains',
    value: 'bug',
  });
});

test('$contains operator with a string array value', () => {
  const ast = filterCompile({ labels: { $contains: ['bug', 'urgent'] } });
  expect(asAnd(ast).clauses[0]).toEqual({
    kind: 'cmp',
    key: 'labels',
    op: '$contains',
    value: ['bug', 'urgent'],
  });
});

test('throws on $contains with a non-string scalar value', () => {
  expect(() => filterCompile({ labels: { $contains: 5 as never } })).toThrow(FilterCompileError);
});

test('throws on $contains with an object value', () => {
  expect(() => filterCompile({ labels: { $contains: { evil: 1 } as never } })).toThrow(
    FilterCompileError,
  );
});

test('throws on $contains with a non-string-array value', () => {
  expect(() => filterCompile({ labels: { $contains: ['ok', 5] as never } })).toThrow(
    FilterCompileError,
  );
});

test('throws on $contains over the array-length cap', () => {
  const tooMany = Array.from({ length: 101 }, (_, i) => `l${i}`);
  expect(() => filterCompile({ labels: { $contains: tooMany } })).toThrow(FilterCompileError);
});

test('LOW-1: throws FilterCompileError on $contains over a built-in column', () => {
  expect(() => filterCompile({ status: { $contains: 'todo' } })).toThrow(FilterCompileError);
});

test('HIGH-2: throws when the filter has more than the clause cap of keys', () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 51; i++) input[`k${i}`] = 'v';
  expect(() => filterCompile(input as never)).toThrow(FilterCompileError);
});

test('clause count at the cap (50) is accepted', () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) input[`k${i}`] = 'v';
  expect(() => filterCompile(input as never)).not.toThrow();
});

test('empty-array: throws on $contains with an empty array (would silently select all)', () => {
  expect(() => filterCompile({ labels: { $contains: [] } })).toThrow(FilterCompileError);
});

test('throws on unknown operator', () => {
  expect(() => filterCompile({ x: { $bogus: 1 } as never })).toThrow(FilterCompileError);
});

test('throws on $in with non-array', () => {
  expect(() => filterCompile({ x: { $in: 'nope' as never } })).toThrow(FilterCompileError);
});

test('empty filter returns empty AND', () => {
  expect(filterCompile({})).toEqual({ kind: 'and', clauses: [] });
});
