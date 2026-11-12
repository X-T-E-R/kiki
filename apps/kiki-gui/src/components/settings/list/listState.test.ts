// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { ListToolbar } from './ListParts';
import { LIST_TOOLS_MIN_ITEMS, groupItems, listToolsFor, matchesQuery, useListView, type ListFilterSpec, type ListSortSpec } from './listState';

describe('settings list helpers', () => {
  it('matches every word of the query anywhere in the row text, case-folded', () => {
    expect(matchesQuery(['axon/gpt-5.6-sol', 'GPT 5.6 Sol'], 'gpt sol')).toBe(true);
    expect(matchesQuery(['axon/gpt-5.6-sol'], 'gpt luna')).toBe(false);
    expect(matchesQuery(['anything', undefined], '   ')).toBe(true);
  });

  it('puts an item in every group it names, orders groups and counts totals before filtering', () => {
    const all = [
      { id: 'a', provider: 'p2', inUse: true },
      { id: 'b', provider: 'p1', inUse: false },
      { id: 'c', provider: 'p2', inUse: false },
    ];
    const visible = all.filter((item) => item.id !== 'c');
    const groups = groupItems(all, visible, (item) => [
      ...(item.inUse ? [{ key: 'in-use', label: 'In use' }] : []),
      { key: item.provider, label: item.provider },
    ], ['in-use', 'p1']);
    expect(groups.map((group) => [group.key, group.items.map((item) => item.id), group.total])).toEqual([
      ['in-use', ['a'], 1],
      ['p1', ['b'], 1],
      ['p2', ['a'], 2],
    ]);
  });
});

interface Row { readonly id: string; readonly kind: 'api' | 'local' }

const rows = (count: number, kinds: readonly Row['kind'][] = ['api']): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, kind: kinds[index % kinds.length]! }));
const FILTERS: readonly ListFilterSpec<Row>[] = [
  { id: 'api', label: 'API', test: (row) => row.kind === 'api' },
  { id: 'local', label: 'Local', test: (row) => row.kind === 'local' },
];
const SORTS: readonly ListSortSpec<Row>[] = [
  { id: 'order', label: 'Order', compare: () => 0 },
  { id: 'name', label: 'Name', compare: (a, b) => a.id.localeCompare(b.id) },
];

describe('list tools threshold', () => {
  it('offers search from eight items and filter chips only when they divide the list', () => {
    expect(LIST_TOOLS_MIN_ITEMS).toBe(8);
    expect(listToolsFor(rows(7, ['api', 'local']), FILTERS, SORTS, false)).toEqual({ search: false, filters: false, filterIds: [], sort: false });
    expect(listToolsFor(rows(8), FILTERS, SORTS, false)).toEqual({ search: true, filters: false, filterIds: [], sort: false });
    expect(listToolsFor(rows(8, ['api', 'local']), FILTERS, SORTS, false)).toMatchObject({ filters: true, filterIds: ['api', 'local'] });
    // A chip that matches nothing is not a kind the list has.
    const attention: ListFilterSpec<Row> = { id: 'attention', label: 'Needs attention', test: (row) => row.id === 'row-0' };
    expect(listToolsFor(rows(8), [...FILTERS, attention], SORTS, false).filterIds).toEqual(['attention']);
    // Sort appears only where the page says the order matters.
    expect(listToolsFor(rows(3), FILTERS, SORTS, true).sort).toBe(true);
    expect(listToolsFor(rows(30), FILTERS, SORTS.slice(0, 1), true).sort).toBe(false);
  });

  describe('in the toolbar every list gets', () => {
    beforeAll(() => {
      vi.stubGlobal('navigator', { language: 'en-US' });
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterAll(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      vi.unstubAllGlobals();
    });

    function Toolbar({ items }: { items: readonly Row[] }) {
      const view = useListView({ listId: 'threshold-test', items, keyOf: (row) => row.id, textOf: (row) => [row.id], filters: FILTERS, sorts: SORTS });
      return createElement(ListToolbar<Row>, { view, total: items.length, filters: FILTERS, sorts: SORTS, searchLabel: 'Search', searchPlaceholder: 'Search' });
    }

    async function render(items: readonly Row[]): Promise<HTMLDivElement> {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => { root.render(createElement(I18nProvider, null, createElement(Toolbar, { items }))); });
      return container;
    }

    it('draws search at eight items, not at seven, and no chips for a single kind', async () => {
      const seven = await render(rows(7, ['api', 'local']));
      expect(seven.querySelector('[data-list-search]')).toBeNull();
      expect(seven.querySelector('[data-list-filters]')).toBeNull();
      const eight = await render(rows(8));
      expect(eight.querySelector('[data-list-search]')).not.toBeNull();
      expect(eight.querySelector('[data-list-filters]')).toBeNull();
      expect(eight.querySelector('[data-list-sort]')).toBeNull();
      const mixed = await render(rows(8, ['api', 'local']));
      expect([...mixed.querySelectorAll('[data-list-filter]')].map((chip) => chip.getAttribute('data-list-filter'))).toEqual(['all', 'api', 'local']);
    });
  });
});
