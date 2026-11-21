import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CONNECTION_OPERATIONS } from '@kiki/protocol';
import { isPeerFrameAllowed, listPeerReachableSurface } from '../src/services/connections/audience';

describe('peer-reachable surface guard', () => {
  it('pins every peer procedure, frame subscription, REST operation and web boundary', async () => {
    const fixture = await readFile(new URL('./fixtures/peer-reachable-surface.txt', import.meta.url), 'utf8');
    const expected = fixture.trimEnd().split('\n');
    const operations = Object.entries(CONNECTION_OPERATIONS).map(([name, [method, path]]) => `REST ${name}: ${method} ${path}`);
    expect([...operations, ...listPeerReachableSurface()]).toEqual(expected);
  });

  it.each(['terminal_attach', 'terminal_detach', 'terminal_input', 'terminal_resize'])('gates %s on execute and fails closed without a grant capability', (type) => {
    expect(isPeerFrameAllowed({ type })).toBe(false);
    expect(isPeerFrameAllowed({ type }, ['read', 'send'])).toBe(false);
    expect(isPeerFrameAllowed({ type }, ['execute'])).toBe(true);
  });
});
