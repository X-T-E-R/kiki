import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyPendingNewSessionCapabilities,
  bindPendingNewSessionDraft,
  clearPendingNewSessionCapabilities,
  currentPendingCapabilityScope,
  pendingNewSessionCapabilities,
  setPendingMcpChoice,
  setPendingPluginChoice,
  type PendingCapabilityScope,
} from './newSessionCapabilities';

const scopeA: PendingCapabilityScope = { scopeId: 'local', spaceKey: 'main', connectionId: null, draftKey: 'draft-a' };
const scopeB: PendingCapabilityScope = { scopeId: 'direct:peer', spaceKey: 'remote:c1', connectionId: 'c1', draftKey: 'draft-b' };

afterEach(() => { clearPendingNewSessionCapabilities(); });

describe('pending /new capabilities', () => {
  it('keeps only explicit choices and applies plugins before the agent override', async () => {
    setPendingPluginChoice('notes', 'on');
    setPendingPluginChoice('notes', 'on');
    setPendingPluginChoice('media', 'off');
    setPendingPluginChoice('media', 'inherit');
    setPendingMcpChoice({ locator: { source: 'global', name: 'files' }, override: 'off', name: 'files' });
    expect(pendingNewSessionCapabilities()).toEqual({
      plugins: [{ pluginId: 'notes', override: 'on' }],
      mcp: [{ locator: { source: 'global', name: 'files' }, override: 'off', name: 'files' }],
    });

    const order: string[] = [];
    const setPluginUsage = vi.fn(async () => { order.push('plugin'); });
    const setMcpSessionOverride = vi.fn(async () => { order.push('mcp'); });
    const session = vi.fn(() => ({ agent: () => ({ setMcpSessionOverride }) }));
    await applyPendingNewSessionCapabilities({ setPluginUsage, klient: { session } }, 'session-new');
    expect(order).toEqual(['plugin', 'mcp']);
    expect(setPluginUsage).toHaveBeenCalledWith({ target: { session_id: 'session-new' }, plugin_id: 'notes', override: 'on' });
    expect(session).toHaveBeenCalledWith('session-new');
    expect(setMcpSessionOverride).toHaveBeenCalledWith({ locator: { source: 'global', name: 'files' }, override: 'off' });
    expect(pendingNewSessionCapabilities()).toEqual({ plugins: [], mcp: [] });
  });

  it('keeps the draft when apply fails and does not create an agent for plugins alone', async () => {
    setPendingPluginChoice('notes', 'on');
    const setPluginUsage = vi.fn(async () => { throw new Error('denied'); });
    const session = vi.fn();
    await expect(applyPendingNewSessionCapabilities({ setPluginUsage, klient: { session } }, 'session-new')).rejects.toThrow('denied');
    expect(session).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities().plugins).toEqual([{ pluginId: 'notes', override: 'on' }]);

    clearPendingNewSessionCapabilities();
    setPendingPluginChoice('notes', 'off');
    const setPluginUsageOk = vi.fn(async () => undefined);
    await applyPendingNewSessionCapabilities({ setPluginUsage: setPluginUsageOk, klient: { session } }, 'session-new');
    expect(session).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities()).toEqual({ plugins: [], mcp: [] });
  });

  it('applies one connection draft and leaves the other draft in place', async () => {
    bindPendingNewSessionDraft(scopeA);
    bindPendingNewSessionDraft(scopeB);
    expect(currentPendingCapabilityScope({ scopeId: 'local', spaceKey: 'main', connectionId: null })).toEqual(scopeA);
    expect(currentPendingCapabilityScope({ scopeId: 'direct:peer', spaceKey: 'remote:c1', connectionId: 'c1' })).toEqual(scopeB);
    setPendingPluginChoice('notes', 'off', scopeA);
    setPendingPluginChoice('media', 'on', scopeB);
    setPendingMcpChoice({ locator: { source: 'global', name: 'files' }, override: 'off', name: 'files' }, scopeB);
    bindPendingNewSessionDraft(scopeB);

    const setPluginUsage = vi.fn(async () => undefined);
    const session = vi.fn();
    await applyPendingNewSessionCapabilities({ setPluginUsage, klient: { session } }, 'session-a', scopeA);

    expect(setPluginUsage).toHaveBeenCalledTimes(1);
    expect(setPluginUsage).toHaveBeenCalledWith({ target: { session_id: 'session-a' }, plugin_id: 'notes', override: 'off' });
    expect(session).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities(scopeA)).toEqual({ plugins: [], mcp: [] });
    expect(pendingNewSessionCapabilities(scopeB)).toEqual({
      plugins: [{ pluginId: 'media', override: 'on' }],
      mcp: [{ locator: { source: 'global', name: 'files' }, override: 'off', name: 'files' }],
    });
    expect(pendingNewSessionCapabilities()).toEqual({ plugins: [], mcp: [] });
  });

  it('writes the captured revision and keeps a choice made while that write is in flight', async () => {
    let release: (() => void) | undefined;
    const setPluginUsage = vi.fn((input: { plugin_id: string }) => new Promise<void>((resolve) => {
      if (input.plugin_id === 'notes') release = resolve;
      else resolve();
    }));
    const session = vi.fn();
    setPendingPluginChoice('notes', 'off');
    const pending = applyPendingNewSessionCapabilities({ setPluginUsage, klient: { session } }, 'session-new');
    expect(setPluginUsage).toHaveBeenCalledTimes(1);
    expect(setPluginUsage).toHaveBeenCalledWith({ target: { session_id: 'session-new' }, plugin_id: 'notes', override: 'off' });
    setPendingPluginChoice('notes', 'on');
    setPendingPluginChoice('media', 'off');
    if (release === undefined) throw new Error('apply did not start the plugin write');
    release();
    await pending;
    expect(setPluginUsage).toHaveBeenCalledTimes(1);
    expect(session).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities()).toEqual({
      plugins: [{ pluginId: 'notes', override: 'on' }, { pluginId: 'media', override: 'off' }],
      mcp: [],
    });
  });

  it('retries the same draft after a refused write and does not open a session for that failure', async () => {
    setPendingPluginChoice('notes', 'off');
    setPendingMcpChoice({ locator: { source: 'global', name: 'files' }, override: 'on', name: 'files' });
    const session = vi.fn(() => ({ agent: () => ({ setMcpSessionOverride: vi.fn() }) }));
    const setPluginUsage = vi.fn(async () => { throw new Error('denied'); });
    await expect(applyPendingNewSessionCapabilities({ setPluginUsage, klient: { session } }, 'session-new')).rejects.toThrow('denied');
    expect(session).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities()).toEqual({
      plugins: [{ pluginId: 'notes', override: 'off' }],
      mcp: [{ locator: { source: 'global', name: 'files' }, override: 'on', name: 'files' }],
    });

    const setMcpSessionOverride = vi.fn(async () => undefined);
    const sessionRetry = vi.fn(() => ({ agent: () => ({ setMcpSessionOverride }) }));
    const setPluginUsageRetry = vi.fn(async () => undefined);
    await applyPendingNewSessionCapabilities({ setPluginUsage: setPluginUsageRetry, klient: { session: sessionRetry } }, 'session-new');
    expect(setPluginUsageRetry).toHaveBeenCalledTimes(1);
    expect(setPluginUsageRetry).toHaveBeenCalledWith({ target: { session_id: 'session-new' }, plugin_id: 'notes', override: 'off' });
    expect(sessionRetry).toHaveBeenCalledTimes(1);
    expect(sessionRetry).toHaveBeenCalledWith('session-new');
    expect(setMcpSessionOverride).toHaveBeenCalledWith({ locator: { source: 'global', name: 'files' }, override: 'on' });
    expect(pendingNewSessionCapabilities()).toEqual({ plugins: [], mcp: [] });
  });
});
