import { describe, it, expect, vi } from 'vitest';
import { buildRailTree, type RailTreeHandlers } from './rail-tree.ts';

const noopHandlers: RailTreeHandlers = {
  onViewClick: () => {},
  onNewView: () => {},
};

describe('buildRailTree', () => {
  it('empty projects returns empty tree', () => {
    const tree = buildRailTree({
      projects: [],
      tablesByProject: {},
      viewsByTable: {},
      currentRoute: { wslug: 'acme' },
      handlers: noopHandlers,
    });
    expect(tree).toEqual([]);
  });

  it('one project + one table + one default view → 3-level tree', () => {
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: { t1: [{ id: 'v1', name: 'All work items', type: 'list', isDefault: true, order: 0 }] },
      currentRoute: { wslug: 'acme' },
      handlers: noopHandlers,
    });
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('Acme Sales');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].label).toBe('Work Items');
    expect(tree[0].children![0].children).toHaveLength(1);
    expect(tree[0].children![0].children![0].label).toBe('All work items');
  });

  it('multiple views sort by order ascending', () => {
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: {
        t1: [
          { id: 'late',   name: 'Late',   type: 'list', isDefault: false, order: 20 },
          { id: 'early',  name: 'Early',  type: 'list', isDefault: false, order: 0 },
          { id: 'middle', name: 'Middle', type: 'list', isDefault: false, order: 10 },
        ],
      },
      currentRoute: { wslug: 'acme' },
      handlers: noopHandlers,
    });
    const views = tree[0].children![0].children!;
    expect(views.map((v) => v.label)).toEqual(['Early', 'Middle', 'Late']);
  });

  it('default view ranks first when orders tie', () => {
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: {
        t1: [
          { id: 'a', name: 'Custom',  type: 'list', isDefault: false, order: 0 },
          { id: 'b', name: 'Default', type: 'list', isDefault: true,  order: 0 },
        ],
      },
      currentRoute: { wslug: 'acme' },
      handlers: noopHandlers,
    });
    const views = tree[0].children![0].children!;
    expect(views.map((v) => v.label)).toEqual(['Default', 'Custom']);
  });

  it('kanban views are filtered out', () => {
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: {
        t1: [
          { id: 'v1', name: 'List A',  type: 'list',   isDefault: false, order: 0 },
          { id: 'v2', name: 'Board',   type: 'kanban', isDefault: false, order: 10 },
          { id: 'v3', name: 'List B',  type: 'list',   isDefault: false, order: 20 },
        ],
      },
      currentRoute: { wslug: 'acme' },
      handlers: noopHandlers,
    });
    const views = tree[0].children![0].children!;
    expect(views.map((v) => v.label)).toEqual(['List A', 'List B']);
  });

  it('active flag set on the matching view when currentRoute.viewId matches AND pslug matches', () => {
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: {
        t1: [
          { id: 'v1', name: 'Match',     type: 'list', isDefault: false, order: 0 },
          { id: 'v2', name: 'Not match', type: 'list', isDefault: false, order: 10 },
        ],
      },
      currentRoute: { wslug: 'acme', pslug: 'sales', viewId: 'v1' },
      handlers: noopHandlers,
    });
    const views = tree[0].children![0].children!;
    expect(views.find((v) => v.label === 'Match')!.active).toBe(true);
    expect(views.find((v) => v.label === 'Not match')!.active).toBe(false);
  });

  it('clicking a leaf calls handlers.onViewClick with (pslug, tslug, viewId)', () => {
    const onViewClick = vi.fn();
    const tree = buildRailTree({
      projects: [{ slug: 'sales', name: 'Acme Sales' }],
      tablesByProject: { sales: [{ id: 't1', slug: 'work-items', name: 'Work Items' }] },
      viewsByTable: { t1: [{ id: 'v1', name: 'All', type: 'list', isDefault: true, order: 0 }] },
      currentRoute: { wslug: 'acme' },
      handlers: { onViewClick, onNewView: () => {} },
    });
    tree[0].children![0].children![0].onClick!();
    expect(onViewClick).toHaveBeenCalledWith('sales', 'work-items', 'v1');
  });
});
