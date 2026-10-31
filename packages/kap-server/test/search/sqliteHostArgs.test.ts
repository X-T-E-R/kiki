import { expect, it } from 'vitest';
import { RESOURCE_DEFAULTS } from '@kiki/agent-core-v2/_base/node/resourceDefaults';

import { seaIndexerArgs, seaIndexerSelected } from '../../src/search/sqlite/host';

it.each(['--max-old-space-size=0', '--max-old-space-size=8192', '--max_old_space_size=4096'])('overrides local SEA %s only for the search child', (flag) => {
  expect(seaIndexerArgs('index.sqlite', [flag])).toEqual([
    `--node-options=--max-old-space-size=${RESOURCE_DEFAULTS.workerHeapMb}`, '__search-indexer', 'index.sqlite',
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
