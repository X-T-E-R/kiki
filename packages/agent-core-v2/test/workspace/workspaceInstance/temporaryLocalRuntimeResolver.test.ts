import { describe, expect, it, vi } from 'vitest';

import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { TemporaryLocalRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';

function resolver(ready = Promise.resolve()): TemporaryLocalRuntimeResolver {
  return new TemporaryLocalRuntimeResolver(
    { ready, pathClass: 'posix', homeDir: '/home/test' } as IHostEnvironment,
    {} as IHostFileSystem,
    {} as IHostProcessService,
  );
}

describe('request-local runtime lease', () => {
  it('waits for the environment and drains tracked resources without a workspace or Program', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    let acquired = false;
    const pending = resolver(ready).acquire('/draft', ['fs', 'process']).then((lease) => {
      acquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    releaseReady();
    const lease = await pending;
    expect(lease.runtime.identity).toMatchObject({ workspaceId: '/draft', runtimeId: 'local' });
    expect(lease.runtime.workspace.mapRoots({ workDir: '/draft' }).workDir).toBe('/draft');
    let releaseResource!: () => void;
    const resourceDone = new Promise<void>((resolve) => { releaseResource = resolve; });
    const dispose = vi.fn(() => resourceDone);
    lease.track({ dispose });
    let drained = false;
    const disposal = lease.dispose();
    void disposal.then(() => { drained = true; });
    expect(lease.dispose()).toBe(disposal);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(drained).toBe(false);
    releaseResource();
    await disposal;
    expect(lease.runtime.status).toBe('disposed');
    expect(() => lease.track({ dispose: () => {} })).toThrow(/draining/);
  });

  it('rejects unsupported temporary capabilities instead of materializing a workspace provider', async () => {
    await expect(resolver().acquire('/draft', ['terminal'])).rejects.toMatchObject({ code: 'runtime.capability_unavailable' });
  });
});
