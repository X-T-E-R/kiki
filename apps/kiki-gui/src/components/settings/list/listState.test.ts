import { describe, expect, it } from 'vitest';

import { groupItems, matchesQuery } from './listState';

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
