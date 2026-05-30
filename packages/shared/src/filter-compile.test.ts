import { test, expect } from 'bun:test';
import { filterCompile, FilterCompileError, type FilterAST } from './filter-compile.ts';

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
    kind: 'cmp', key: 'status', op: '$in', value: ['todo', 'done'],
  });
});

test('multiple keys are AND-combined', () => {
  const ast = filterCompile({ status: 'todo', type: 'work_item' });
  expect(asAnd(ast).clauses).toHaveLength(2);
});

test('$exists boolean', () => {
  const ast = filterCompile({ priority: { $exists: true } });
  expect(asAnd(ast).clauses[0]).toEqual({
    kind: 'cmp', key: 'priority', op: '$exists', value: true,
  });
});

test('comparators $gt $gte $lt $lte $ne', () => {
  for (const op of ['$gt', '$gte', '$lt', '$lte', '$ne'] as const) {
    const ast = filterCompile({ count: { [op]: 5 } });
    expect(asAnd(ast).clauses[0]).toEqual({ kind: 'cmp', key: 'count', op, value: 5 });
  }
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
