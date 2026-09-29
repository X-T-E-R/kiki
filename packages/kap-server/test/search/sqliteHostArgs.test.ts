import { expect, it } from 'vitest';

import { seaIndexerArgs } from '../../src/search/sqlite/host';

it('overrides the embedded local SEA heap limit only for the search child', () => {
  expect(seaIndexerArgs('index.sqlite', ['--max-old-space-size=8192'])).toEqual([
    '--node-options=--max-old-space-size=384', '__search-indexer', 'index.sqlite',
  ]);
});

it('keeps the release SEA on its NODE_OPTIONS memory budget', () => {
  expect(seaIndexerArgs('index.sqlite', [])).toEqual(['__search-indexer', 'index.sqlite']);
});
