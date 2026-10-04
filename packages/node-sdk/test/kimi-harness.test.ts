import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, ImageLimits, KimiHarness, SDKRpcClientBase } from '#/index';

import { recordingTelemetry } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

/**
 * The recursive RPC surface KimiHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts.
 */
class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error('no core calls expected');
  }
}

function makeHarnessWithRpc(rpc: SDKRpcClientBase, onClose: () => void | Promise<void> = () => undefined): KimiHarness {
  return new KimiHarness(rpc, {
    homeDir: '/tmp/home',
    configPath: '/tmp/config.toml',
    auth: { status: async () => ({ providers: [] }) } as never,
    telemetry: recordingTelemetry([]),
    ensureConfigFile: async () => undefined,
    onClose,
  });
}

describe('KimiHarness capability facade', () => {
  const ready = {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    description: 'd',
    supported: true,
    state: 'ready',
    steps: [],
    install: { running: false },
  } as const;

  it('routes capability calls through the global channel with no session', async () => {
    const calls: string[] = [];
    class CapabilityRpc extends StubRpc {
      async listCapabilities() {
        calls.push('list');
        return [ready];
      }
      async getCapability(id: string) {
        calls.push(`get:${id}`);
        return ready;
      }
      async installCapability(id: string) {
        calls.push(`install:${id}`);
        return ready;
      }
    }
    const harness = makeHarnessWithRpc(new CapabilityRpc());

    expect(await harness.listCapabilities()).toEqual([ready]);
    expect((await harness.getCapability('kimi-webbridge')).state).toBe('ready');
    await harness.installCapability('kimi-webbridge');
    expect(calls).toEqual(['list', 'get:kimi-webbridge', 'install:kimi-webbridge']);
  });

  it('reports the capability surface as unavailable on v1', async () => {
    // The v1 rpc has no capability methods, exactly like the real v1 client.
    const harness = makeHarnessWithRpc(new StubRpc());
    await expect(harness.listCapabilities()).rejects.toThrow(/requires v2/);
    await expect(harness.installCapability('kimi-cu')).rejects.toThrow(/requires v2/);
  });
});

describe('KimiHarness imageLimits', () => {
  it('leaves the limits unset, so ingestion falls back to env and defaults', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[image]
max_edge_px = 1200
read_byte_budget = 65536
`,
      'utf-8',
    );

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      // The engine resolves `[image]` per call rather than handing the host an
      // owner-scoped limits object, so a `config.toml` section does not produce
      // one here. Hosts that need limits inject their own (below).
      expect(harness.imageLimits).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('a hand-built harness returns the injected ImageLimits as-is', () => {
    const limits = new ImageLimits(process.env, { maxEdgePx: 900 });
    const harness = new KimiHarness(new StubRpc(), {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry([]),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx()).toBe(900);
  });
});

describe('KimiHarness file ops', () => {
  it('stores an uploaded file and deletes it again', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      const meta = await harness.uploadFile(new Uint8Array([137, 80, 78, 71]), {
        name: 'pixel.png',
      });
      expect(meta).toMatchObject({ name: 'pixel.png', size: 4 });
      await expect(harness.deleteFile(meta.id)).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

describe('KimiHarness close', () => {
  function closingRpc(closeSession = vi.fn(async (_input: { sessionId: string }) => {})) {
    let id = 0;
    return {
      createSession: vi.fn(async () => ({ id: `session-${++id}`, workDir: '/example' })),
      closeSession,
      clearSessionHandlers: vi.fn(),
    };
  }

  it('closes each session and its host exactly once across concurrent and repeated close', async () => {
    const rpc = closingRpc();
    const closeHost = vi.fn(async () => {});
    const harness = makeHarnessWithRpc(rpc as never, closeHost);
    await harness.createSession({ workDir: '/example' });
    await harness.createSession({ workDir: '/example' });
    const closing = harness.close();
    expect(harness.close()).toBe(closing);
    await closing;
    await harness.close();
    expect(rpc.closeSession).toHaveBeenCalledTimes(2);
    expect(harness.sessions.size).toBe(0);
    expect(closeHost).toHaveBeenCalledOnce();
  });

  it('settles every session before host teardown and preserves a single session rejection', async () => {
    const failure = new Error('session close failed');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const rpc = closingRpc(vi.fn(async ({ sessionId }) => {
      if (sessionId === 'session-1') throw failure;
      await pending;
    }));
    const closeHost = vi.fn(async () => {});
    const harness = makeHarnessWithRpc(rpc as never, closeHost);
    await harness.createSession({ workDir: '/example' });
    await harness.createSession({ workDir: '/example' });
    const closing = harness.close();
    const rejected = expect(closing).rejects.toBe(failure);
    await Promise.resolve();
    expect(closeHost).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(harness.sessions.size).toBe(0);
    expect(rpc.clearSessionHandlers).toHaveBeenCalledTimes(2);
    expect(closeHost).toHaveBeenCalledOnce();
    await expect(harness.close()).rejects.toBe(failure);
    expect(closeHost).toHaveBeenCalledOnce();
  });

  it('preserves the host rejection and never retries host close', async () => {
    const failure = new Error('host close failed');
    const closeHost = vi.fn(async () => { throw failure; });
    const harness = makeHarnessWithRpc(closingRpc() as never, closeHost);
    await harness.createSession({ workDir: '/example' });
    await expect(harness.close()).rejects.toBe(failure);
    await expect(harness.close()).rejects.toBe(failure);
    expect(closeHost).toHaveBeenCalledOnce();
    expect(harness.sessions.size).toBe(0);
  });

  it('retains both session and host errors', async () => {
    const sessionError = new Error('session close failed');
    const hostError = new Error('host close failed');
    const rpc = closingRpc(vi.fn(async () => { throw sessionError; }));
    const closeHost = vi.fn(async () => { throw hostError; });
    const harness = makeHarnessWithRpc(rpc as never, closeHost);
    await harness.createSession({ workDir: '/example' });
    const error = await harness.close().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([sessionError, hostError]);
    await expect(harness.close()).rejects.toBe(error);
    expect(closeHost).toHaveBeenCalledOnce();
  });
});
