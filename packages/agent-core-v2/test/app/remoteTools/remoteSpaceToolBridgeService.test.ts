import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REMOTE_SPACE_TOOL_ROUTER,
  remoteSpaceToolCapability,
  type CallRemoteSpaceToolInput,
  type ListRemoteSpaceToolsInput,
  type RemoteBorrowedSpaceCatalog,
  type RemoteSpaceToolConnector,
} from '#/app/remoteTools/remoteSpaceToolBridge';
import { RemoteSpaceToolBridgeService } from '#/app/remoteTools/remoteSpaceToolBridgeService';

const SAMPLE_CATALOGS: readonly RemoteBorrowedSpaceCatalog[] = [
  {
    bridgeId: 'bridge-1',
    connectionId: 'conn-1',
    spaceLabel: 'Remote Workstation',
    platform: 'linux',
    tools: [
      {
        remoteName: 'mcp:fs:list',
        kind: 'mcp',
        serverName: 'fs',
        toolName: 'list',
        description: 'List remote directory entries.',
      },
    ],
  },
];

describe('RemoteSpaceToolBridgeService refcounted AbortSignal sharing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an in-flight request alive for main when a concurrent subagent aborts its own signal', async () => {
    const bridge = new RemoteSpaceToolBridgeService();
    const capability = remoteSpaceToolCapability(bridge);

    let capturedSignal: AbortSignal | undefined;
    let resolveRemote!: (value: readonly RemoteBorrowedSpaceCatalog[]) => void;

    const connector: RemoteSpaceToolConnector = {
      listBorrowedTools: vi.fn((input: ListRemoteSpaceToolsInput) => {
        capturedSignal = input.signal;
        return new Promise<readonly RemoteBorrowedSpaceCatalog[]>((resolve) => {
          resolveRemote = resolve;
        });
      }),
      callBorrowedTool: vi.fn(async (_input: CallRemoteSpaceToolInput) => ({ output: 'ok' })),
    };
    capability[REMOTE_SPACE_TOOL_ROUTER](connector);

    const subagentController = new AbortController();
    const mainController = new AbortController();

    const subagentPromise = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-shared', sessionId: 'main' },
      signal: subagentController.signal,
    });
    const mainPromise = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-shared', sessionId: 'main' },
      signal: mainController.signal,
    });

    expect(connector.listBorrowedTools).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    subagentController.abort(new DOMException('Subagent cancelled', 'AbortError'));
    await expect(subagentPromise).rejects.toThrow('Subagent cancelled');
    expect(capturedSignal?.aborted).toBe(false);

    resolveRemote(SAMPLE_CATALOGS);
    await expect(mainPromise).resolves.toEqual(SAMPLE_CATALOGS);

    await expect(
      bridge.listBorrowedTools({ caller: { workspaceId: 'ws-shared', sessionId: 'main' } }),
    ).resolves.toEqual(SAMPLE_CATALOGS);
    expect(connector.listBorrowedTools).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it('aborts the underlying connector request only when all concurrent waiters abort, and starts a fresh flight afterwards', async () => {
    const bridge = new RemoteSpaceToolBridgeService();
    const capability = remoteSpaceToolCapability(bridge);

    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: readonly RemoteBorrowedSpaceCatalog[]) => void> = [];

    const connector: RemoteSpaceToolConnector = {
      listBorrowedTools: vi.fn((input: ListRemoteSpaceToolsInput) => {
        if (input.signal !== undefined) signals.push(input.signal);
        return new Promise<readonly RemoteBorrowedSpaceCatalog[]>((resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          resolvers.push(resolve);
        });
      }),
      callBorrowedTool: vi.fn(async (_input: CallRemoteSpaceToolInput) => ({ output: 'ok' })),
    };
    capability[REMOTE_SPACE_TOOL_ROUTER](connector);

    const callerA = new AbortController();
    const callerB = new AbortController();

    const promiseA = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-shared', sessionId: 'main' },
      signal: callerA.signal,
    });
    const promiseB = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-shared', sessionId: 'main' },
      signal: callerB.signal,
    });

    expect(connector.listBorrowedTools).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    callerA.abort(new DOMException('Caller A cancelled', 'AbortError'));
    await expect(promiseA).rejects.toThrow('Caller A cancelled');
    expect(signals[0]?.aborted).toBe(false);

    callerB.abort(new DOMException('Caller B cancelled', 'AbortError'));
    await expect(promiseB).rejects.toThrow('Caller B cancelled');
    expect(signals[0]?.aborted).toBe(true);

    const freshPromise = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-shared', sessionId: 'main' },
    });
    expect(connector.listBorrowedTools).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    resolvers[1]!(SAMPLE_CATALOGS);
    await expect(freshPromise).resolves.toEqual(SAMPLE_CATALOGS);

    bridge.dispose();
  });

  it('keeps an in-flight request alive for a signal-less waiter even if all signal-bearing waiters abort, and aborts on notifyChanged or dispose', async () => {
    const bridge = new RemoteSpaceToolBridgeService();
    const capability = remoteSpaceToolCapability(bridge);

    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: readonly RemoteBorrowedSpaceCatalog[]) => void> = [];

    const connector: RemoteSpaceToolConnector = {
      listBorrowedTools: vi.fn((input: ListRemoteSpaceToolsInput) => {
        if (input.signal !== undefined) signals.push(input.signal);
        return new Promise<readonly RemoteBorrowedSpaceCatalog[]>((resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          resolvers.push(resolve);
        });
      }),
      callBorrowedTool: vi.fn(async (_input: CallRemoteSpaceToolInput) => ({ output: 'ok' })),
    };
    capability[REMOTE_SPACE_TOOL_ROUTER](connector);

    const subAbort = new AbortController();
    const subPromise = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-no-sig', sessionId: 'main' },
      signal: subAbort.signal,
    });
    const noSignalMainPromise = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-no-sig', sessionId: 'main' },
    });

    subAbort.abort(new DOMException('Subagent cancelled', 'AbortError'));
    await expect(subPromise).rejects.toThrow('Subagent cancelled');
    expect(signals[0]?.aborted).toBe(false);

    resolvers[0]!(SAMPLE_CATALOGS);
    await expect(noSignalMainPromise).resolves.toEqual(SAMPLE_CATALOGS);

    capability.notifyChanged();
    const pendingBeforeNotify = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-no-sig', sessionId: 'main' },
    });
    expect(signals[1]?.aborted).toBe(false);
    capability.notifyChanged();
    expect(signals[1]?.aborted).toBe(true);
    await expect(pendingBeforeNotify).resolves.toEqual(SAMPLE_CATALOGS);

    const pendingBeforeDispose = bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-no-sig', sessionId: 'main' },
    });
    expect(signals[2]?.aborted).toBe(false);
    bridge.dispose();
    expect(signals[2]?.aborted).toBe(true);
    await expect(pendingBeforeDispose).resolves.toEqual([]);
  });

  it('evicts the least recently used session entries once the catalog cache exceeds 256 entries', async () => {
    const bridge = new RemoteSpaceToolBridgeService();
    const capability = remoteSpaceToolCapability(bridge);
    const listBorrowedTools = vi.fn(async (_input: ListRemoteSpaceToolsInput) => SAMPLE_CATALOGS);
    capability[REMOTE_SPACE_TOOL_ROUTER]({
      listBorrowedTools,
      callBorrowedTool: vi.fn(async (_input: CallRemoteSpaceToolInput) => ({ output: 'ok' })),
    });

    for (let i = 0; i < 257; i += 1) {
      await bridge.listBorrowedTools({
        caller: { workspaceId: 'ws-cap', sessionId: `sess-${i}` },
      });
    }
    expect(listBorrowedTools).toHaveBeenCalledTimes(257);

    await bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-cap', sessionId: 'sess-256' },
    });
    expect(listBorrowedTools).toHaveBeenCalledTimes(257);

    await bridge.listBorrowedTools({
      caller: { workspaceId: 'ws-cap', sessionId: 'sess-0' },
    });
    expect(listBorrowedTools).toHaveBeenCalledTimes(258);

    bridge.dispose();
  });
});
