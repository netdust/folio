import { DEFAULT_TABLE_SLUG } from './default-table.ts';

it('DEFAULT_TABLE_SLUG matches the server seed slug', () => {
  expect(DEFAULT_TABLE_SLUG).toBe('work-items');
});
