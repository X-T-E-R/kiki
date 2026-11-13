import { describe, expect, it, vi } from 'vitest';

import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { acquireToolRuntime, prepareToolRuntime, toolParametersWithHost } from '#/agent/tools/os/sshToolTarget';
import type { Runtime, RuntimeLease } from '#/runtime/runtime';

const localRuntime = { identity: { runtimeId: 'local' } } as Runtime;
const localLease = { runtime: localRuntime, track: (resource: unknown) => resource, dispose: () => {} } as RuntimeLease;

describe('explicit SSH tool target selection', () => {
  it.each(['unconfigured', 'hidden', 'disconnected', 'denied'] as const)('%s targets fail without a local fallback', async (reason) => {
    const failure = new Error(`${reason} SSH target`);
    const prepareFor = vi.fn(async (host: string | undefined) => {
      if (host === 'local') return localRuntime;
      throw failure;
    });
    const acquire = vi.fn(() => localLease);
    const service = {
      inspect: vi.fn(() => localRuntime),
      acquire,
      prepareFor,
      acquireFor: vi.fn(() => localLease),
    } as unknown as IAgentRuntimeService;

    await expect(prepareToolRuntime(service, 'named-host')).rejects.toBe(failure);
    expect(prepareFor).toHaveBeenCalledExactlyOnceWith('named-host');
    expect(service.inspect).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('does not substitute local acquire when SSH runtime acquisition is unavailable', () => {
    const acquire = vi.fn(() => localLease);
    const service = { acquire } as unknown as IAgentRuntimeService;

    expect(() => acquireToolRuntime(service, 'named-host', ['fs'])).toThrow('SSH runtime selection is not available');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('uses the requested explicit local target rather than the session runtime', async () => {
    const remoteRuntime = { identity: { runtimeId: 'ssh:session-host' } } as Runtime;
    const localPrepareFor = vi.fn(async (host: string | undefined) => host === 'local' ? localRuntime : remoteRuntime);
    const localAcquire = vi.fn(() => localLease);
    const service = {
      inspect: vi.fn(() => remoteRuntime),
      acquire: vi.fn(() => ({ ...localLease, runtime: remoteRuntime })),
      prepareFor: localPrepareFor,
      acquireFor: localAcquire,
    } as unknown as IAgentRuntimeService;

    expect(await prepareToolRuntime(service, 'local')).toBe(localRuntime);
    expect(localPrepareFor).toHaveBeenCalledExactlyOnceWith('local');
    expect(acquireToolRuntime(service, 'local', ['fs'])).toBe(localLease);
    expect(localAcquire).toHaveBeenCalledExactlyOnceWith('local', ['fs']);
    expect(service.acquire).not.toHaveBeenCalled();
  });

  it('describes explicit host selection as non-fallback', () => {
    const parameters = toolParametersWithHost({ type: 'object', properties: { host: { type: 'string' } } }, true);
    const properties = parameters['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['host']?.['description']).toContain('never falls back to local or another host');
  });
});
