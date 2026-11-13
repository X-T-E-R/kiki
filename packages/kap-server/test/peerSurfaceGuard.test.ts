import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CONNECTION_OPERATIONS } from '@kiki/protocol';
import { listPeerReachableSurface } from '../src/services/connections/audience';

describe('peer-reachable surface guard', () => {
  it('pins every peer procedure, frame subscription, REST operation and web boundary', async () => {
    const fixture = await readFile(new URL('./fixtures/peer-reachable-surface.txt', import.meta.url), 'utf8');
    const expected = fixture.trimEnd().split('\n');
    const operations = Object.entries(CONNECTION_OPERATIONS).map(([name, [method, path]]) => `REST ${name}: ${method} ${path}`);
    expect([...operations, ...listPeerReachableSurface()]).toEqual(expected);
  });
});
