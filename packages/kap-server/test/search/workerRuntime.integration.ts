import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SearchWorkerHost } from '../../src/search/worker/host';

it('starts the native source worker with the shared history matcher in its import closure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiki-search-worker-runtime-'));
  const host = new SearchWorkerHost({ dir, log: { info() {}, warn() {} } });
  try {
    const opened = await host.ensureOpen();
    expect(opened.readOnly).toBe(false);
    expect(opened.lockToken).toBeTypeOf('string');
    expect(host.reportedLockToken).toBe(opened.lockToken);
    expect(host.lifecycleSnapshot().state).not.toBe('degraded');
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
