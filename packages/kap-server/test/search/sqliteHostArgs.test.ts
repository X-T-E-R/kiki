import { expect, it } from 'vitest';

import { seaIndexerArgs, seaIndexerSelected } from '../../src/search/sqlite/host';

it('overrides the embedded local SEA heap limit only for the search child', () => {
  expect(seaIndexerArgs('index.sqlite', ['--max-old-space-size=8192'])).toEqual([
    '--node-options=--max-old-space-size=384', '__search-indexer', 'index.sqlite',
  ]);
});

it('keeps the release SEA on its NODE_OPTIONS memory budget', () => {
  expect(seaIndexerArgs('index.sqlite', [])).toEqual(['__search-indexer', 'index.sqlite']);
});

it('uses the packaged indexer command only inside the SEA binary', () => {
  expect(seaIndexerSelected('1', true)).toBe(true);
  expect(seaIndexerSelected('1', false)).toBe(false);
  expect(seaIndexerSelected(undefined, true)).toBe(false);
});
