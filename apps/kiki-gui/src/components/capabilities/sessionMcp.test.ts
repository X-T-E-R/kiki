// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { McpServerLocator, McpSessionCapability } from '@kiki/klient';

import {
  draftMcpRows,
  heldByConversation,
  heldCount,
  mcpConnectedCatalogWarning,
  mcpFallbackRows,
  mcpRowMatches,
  mcpSessionRows,
  overrideForSwitch,
  sameLocator,
} from './sessionMcp';

const global = (name: string, overrides: Partial<McpSessionCapability> = {}): McpSessionCapability => ({
  locator: { source: 'global', name },
  runtimeName: name,
  origin: 'global',
  config: { transport: 'stdio', command: 'npx', enabled: true },
  authStatus: 'not-applicable',
  connection: 'connected',
  override: 'inherit',
  ...overrides,
});

const plugin = (name: string, overrides: Partial<McpSessionCapability> = {}): McpSessionCapability => ({
  locator: { source: 'plugin', pluginId: 'research', serverName: `${name}-manifest` },
  runtimeName: name,
  origin: 'plugin',
  config: { transport: 'sse', url: 'https://research.example.test/mcp', enabled: true },
  authStatus: 'not-applicable',
  connection: 'connected',
  override: 'inherit',
  ...overrides,
});

describe('a conversation’s MCP rows', () => {
  it('reports the engine’s live state, and what this conversation did with it', () => {
    const rows = mcpSessionRows({
      writable: true,
      capabilities: [
        global('files'),
        global('notes', { connection: 'connecting' }),
        global('broken', { connection: 'failed', error: 'spawn ENOENT' }),
        global('signin', { connection: 'failed', authStatus: 'oauth-required' }),
        global('muted', { connection: 'disabled', config: { transport: 'stdio', command: 'npx', enabled: false } }),
        global('removed-here', { override: 'off', connection: 'disabled' }),
      ],
    });
    expect(rows.map((row) => [row.name, row.condition])).toEqual([
      ['files', 'live'],
      ['notes', 'connecting'],
      ['broken', 'failed'],
      ['signin', 'signed-out'],
      // Two different offs at two different levels: the configuration turned
      // one off, this conversation removed the other.
      ['muted', 'off-config'],
      ['removed-here', 'off-here'],
    ]);
    expect(rows[2]!.error).toBe('spawn ENOENT');
    expect(rows[2]!.canReconnect).toBe(true);
    expect(rows[3]!.canReconnect).toBe(true);
    // Four of the six: the two offs are not servers this conversation holds.
    expect(heldCount(rows)).toBe(4);
    expect(rows.filter(heldByConversation).map((row) => row.name)).toEqual(['files', 'notes', 'broken', 'signin']);
  });

  it('reads an override-off server as this conversation’s even when the engine still calls it connected', () => {
    // A live connection can outlive the decision that it no longer belongs here.
    const [row] = mcpSessionRows({ writable: true, capabilities: [global('files', { override: 'off' })] });
    expect(row!.condition).toBe('off-here');
    expect(row!.override).toBe('off');
    expect(heldByConversation(row!)).toBe(false);
    expect(row!.canRestore).toBe(true);
  });

  it('takes “sign in” from the auth state, whichever half the engine reports it in', () => {
    const rows = mcpSessionRows({
      writable: true,
      capabilities: [
        global('a', { connection: 'failed', authStatus: 'oauth-required' }),
        global('b', { connection: 'failed', authStatus: 'oauth-expired' }),
        global('c', { connection: 'connected', authStatus: 'oauth-authorized' }),
      ],
    });
    expect(rows.map((row) => row.condition)).toEqual(['signed-out', 'signed-out', 'live']);
  });

  it('keeps a conversation’s own addition apart from a source that has the server off', () => {
    const [added] = mcpSessionRows({
      writable: true,
      capabilities: [global('muted', { override: 'on', connection: 'connecting', config: { transport: 'stdio', command: 'npx', enabled: false } })],
    });
    expect(added!.condition).toBe('connecting');
    expect(heldByConversation(added!)).toBe(true);
    expect(added!.addressable).toBe(true);
  });

  it('keeps a selected server failed when an on override is still held', () => {
    const [failed] = mcpSessionRows({
      writable: true,
      capabilities: [global('muted', { override: 'on', connection: 'failed', error: 'schema load failed' })],
    });
    expect(failed!.condition).toBe('failed');
    expect(heldByConversation(failed!)).toBe(true);
    expect(failed!.error).toBe('schema load failed');
  });

  it('carries the catalog refresh code without reading it out of the error sentence', () => {
    const engine = 'MCP tool catalog refresh failed (Error)';
    const [named, lookalike, failed] = mcpSessionRows({
      writable: true,
      capabilities: [
        global('files', { override: 'on', connection: 'connected', error: engine, errorCode: 'tool_catalog_refresh_failed' }),
        { ...global('plain', { override: 'on', connection: 'connected', error: engine }), errorCode: 'other_failure' } as unknown as McpSessionCapability,
        global('broken', { override: 'on', connection: 'failed', error: 'schema load failed', errorCode: 'tool_catalog_refresh_failed' }),
      ],
    });
    expect(named!.condition).toBe('on-here');
    expect(named!.override).toBe('on');
    expect(named!.connection).toBe('connected');
    expect(named!.error).toBe(engine);
    expect(named!.errorCode).toBe('tool_catalog_refresh_failed');
    expect(mcpConnectedCatalogWarning(named!)).toEqual({ translated: true, detail: engine });

    expect(lookalike!.error).toBe(engine);
    expect(lookalike!.errorCode).toBeUndefined();
    expect(lookalike!.condition).toBe('on-here');
    expect(mcpConnectedCatalogWarning(lookalike!)).toEqual({ translated: false, detail: engine });

    expect(failed!.condition).toBe('failed');
    expect(failed!.override).toBe('on');
    expect(failed!.connection).toBe('failed');
    expect(failed!.errorCode).toBe('tool_catalog_refresh_failed');
    expect(mcpConnectedCatalogWarning(failed!)).toBeUndefined();
  });

  it('keeps an explicit on held and revocable when the connection is still disabled', () => {
    const [sourceOff] = mcpSessionRows({
      writable: true,
      capabilities: [global('muted', {
        override: 'on',
        connection: 'disabled',
        config: { transport: 'stdio', command: 'npx', enabled: false },
      })],
    });
    expect(sourceOff!.condition).toBe('on-here');
    expect(heldByConversation(sourceOff!)).toBe(true);
    expect(sourceOff!.addressable).toBe(true);
    expect(sourceOff!.override).toBe('on');
    expect(sourceOff!.connection).toBe('disabled');
    // The session choice does not rewrite the source into a global grant.
    expect(sourceOff!.configEnabled).toBe(false);

    const [runtimeDown] = mcpSessionRows({
      writable: true,
      capabilities: [global('files', { override: 'on', connection: 'disabled' })],
    });
    expect(runtimeDown!.condition).toBe('on-here');
    expect(runtimeDown!.connection).toBe('disabled');
    expect(runtimeDown!.configEnabled).toBe(true);
    expect(heldByConversation(runtimeDown!)).toBe(true);

    const [pluginOn] = mcpSessionRows({
      writable: true,
      capabilities: [plugin('notes', {
        override: 'on',
        connection: 'disabled',
        config: { transport: 'sse', url: 'https://research.example.test/mcp', enabled: false },
      })],
    });
    expect(pluginOn!.condition).toBe('on-here');
    expect(pluginOn!.addressable).toBe(true);
    expect(heldByConversation(pluginOn!)).toBe(true);
    expect(pluginOn!.connection).toBe('disabled');
    expect(pluginOn!.configEnabled).toBe(false);
  });

  it('draws no switch where this build has no port to write, and one where it has', () => {
    const disabled = global('files', { connection: 'disabled', config: { transport: 'stdio', command: 'npx', enabled: false } });
    expect(mcpSessionRows({ writable: false, capabilities: [disabled] })[0]!.addressable).toBe(false);
    expect(mcpSessionRows({ writable: true, capabilities: [disabled] })[0]!.addressable).toBe(true);
    // A server whose source is gone has a locator but nothing to decide, and one
    // a plugin switched off is refused: neither gets a control.
    expect(mcpSessionRows({ writable: true, capabilities: [global('gone', { connection: 'unavailable' })] })[0]!.addressable).toBe(false);
  });

  it('draws no switch where the engine would refuse the write', () => {
    // A plugin that turned its own server off owns that decision.
    const [muted] = mcpSessionRows({
      writable: true,
      capabilities: [plugin('notes', { connection: 'disabled', config: { transport: 'sse', url: 'https://research.example.test/mcp', enabled: false } })],
    });
    expect(muted!.condition).toBe('plugin-off');
    expect(muted!.addressable).toBe(false);
    // A locator whose runtime name another source owns has nothing new to
    // decide — but a decision already made keeps its way back.
    const [collided] = mcpSessionRows({ writable: true, capabilities: [global('bench', { connection: 'unavailable' })] });
    expect(collided!.condition).toBe('unavailable');
    expect(collided!.addressable).toBe(false);
    expect(collided!.canRestore).toBe(false);
    const [decided] = mcpSessionRows({ writable: true, capabilities: [global('bench', { connection: 'unavailable', override: 'off' })] });
    expect(decided!.condition).toBe('off-here');
    expect(decided!.canRestore).toBe(true);
  });

  it('does not invent a state word this build does not know', () => {
    const [row] = mcpSessionRows({
      writable: true,
      capabilities: [global('odd', {
        connection: 'quarantined' as never,
        config: { transport: 'carrier-pigeon' } as never,
      })],
    });
    expect(row!.condition).toBe('unavailable');
    // An unknown transport is not guessed either; the wire's own default is the
    // only claim this row can make.
    expect(row!.transport).toBe('stdio');
  });

  it('drops an empty error and keeps the engine’s connection word', () => {
    const rows = mcpSessionRows({ writable: true, capabilities: [global('quiet', { error: '' }), global('off', { connection: 'enabled' })] });
    expect(rows[0]!.error).toBeUndefined();
    expect(rows[0]!.connection).toBe('connected');
    expect(rows[1]!.connection).toBe('enabled');
  });

  it('asks for the override that means what the reader meant', () => {
    const [inherited] = mcpSessionRows({ writable: true, capabilities: [global('files')] });
    const [added] = mcpSessionRows({ writable: true, capabilities: [global('files', { override: 'on', connection: 'connected' })] });
    const [removed] = mcpSessionRows({ writable: true, capabilities: [global('files', { override: 'off', connection: 'disabled' })] });
    expect(overrideForSwitch(inherited!, true)).toBe('on');
    expect(overrideForSwitch(inherited!, false)).toBe('off');
    expect(overrideForSwitch(added!, false)).toBe('off');
    expect(overrideForSwitch(removed!, true)).toBe('on');
  });

  it('matches rows by name, level, plugin and transport', () => {
    const [row] = mcpSessionRows({ writable: true, capabilities: [plugin('notes')] });
    expect(mcpRowMatches(row!, '')).toBe(true);
    expect(mcpRowMatches(row!, 'NOTE')).toBe(true);
    expect(mcpRowMatches(row!, 'plugin')).toBe(true);
    expect(mcpRowMatches(row!, 'research')).toBe(true);
    expect(mcpRowMatches(row!, 'sse')).toBe(true);
    expect(mcpRowMatches(row!, 'files')).toBe(false);
  });
});

describe('a /new draft’s MCP rows', () => {
  const mail = {
    name: 'mail',
    source: 'plugin',
    origin: 'kiki-mail',
    config: { transport: 'stdio', enabled: false },
    plugin: { id: 'kiki-mail', name: 'mail' },
  };
  const pendingOn = {
    locator: { source: 'plugin' as const, pluginId: 'kiki-mail', serverName: 'mail' },
    override: 'on' as const,
    name: 'mail',
  };

  it('keeps a pending on when the plugin source has the server off', () => {
    const [row] = draftMcpRows({ servers: [mail], pending: [pendingOn] });
    expect(row!.condition).toBe('on-here');
    expect(row!.condition).not.toBe('plugin-off');
    expect(heldByConversation(row!)).toBe(true);
    expect(row!.addressable).toBe(true);
    expect(row!.override).toBe('on');
    expect(row!.connection).toBe('disabled');
    expect(row!.configEnabled).toBe(false);
  });

  it('draws no switch when that plugin source is off and the draft has not chosen', () => {
    const [row] = draftMcpRows({ servers: [mail], pending: [] });
    expect(row!.condition).toBe('plugin-off');
    expect(row!.addressable).toBe(false);
    expect(heldByConversation(row!)).toBe(false);
    expect(row!.override).toBe('inherit');
  });

  it('keeps an explicit draft off as this draft’s off', () => {
    const [row] = draftMcpRows({
      servers: [mail],
      pending: [{ ...pendingOn, override: 'off' }],
    });
    expect(row!.condition).toBe('off-here');
    expect(heldByConversation(row!)).toBe(false);
    expect(row!.addressable).toBe(true);
    expect(row!.connection).toBe('disabled');
  });
});

describe('locators', () => {
  it('never calls two servers the same one', () => {
    const globalA: McpServerLocator = { source: 'global', name: 'a' };
    expect(sameLocator(globalA, { source: 'global', name: 'a' })).toBe(true);
    expect(sameLocator(globalA, { source: 'plugin', pluginId: 'p', serverName: 'a' })).toBe(false);
    expect(sameLocator({ source: 'plugin', pluginId: 'p', serverName: 'a' }, { source: 'plugin', pluginId: 'q', serverName: 'a' })).toBe(false);
    expect(sameLocator(undefined, globalA)).toBe(false);
    expect(sameLocator(globalA, undefined)).toBe(false);
  });
});

describe('the reads a build without the session port has', () => {
  const catalog = [
    { name: 'files', source: 'global', config: { transport: 'stdio' } },
    { name: 'muted', source: 'global', config: { transport: 'http', enabled: false } },
    { name: 'research-notes', source: 'plugin', config: { transport: 'sse' }, origin: 'Fixture research plugin' },
    { name: 'plugin-muted', source: 'plugin', config: { transport: 'stdio', enabled: false }, origin: 'Fixture research plugin' },
  ];

  it('reads the connection from the runtime list and the level from the catalog', () => {
    const rows = mcpFallbackRows({
      servers: [
        { name: 'files', transport: 'stdio', status: 'connected' },
        { name: 'research-notes', transport: 'sse', status: 'pending', error: 'starting' },
        { name: 'muted', transport: 'http', status: 'disabled' },
        { name: 'plugin-muted', transport: 'stdio', status: 'disabled' },
        // A tombstone only the port can explain; dropping it beats labelling it
        // with the wrong one of the two offs.
        { name: 'gone', transport: 'http', status: 'removed' },
      ],
      catalog,
    });
    expect(rows.map((row) => [row.name, row.condition])).toEqual([
      ['files', 'live'],
      ['research-notes', 'connecting'],
      ['muted', 'off-config'],
      ['plugin-muted', 'plugin-off'],
    ]);
    expect(rows[1]!.error).toBe('starting');
    // No override was read, so no row built from this may claim one.
    expect(rows.every((row) => row.override === 'inherit')).toBe(true);
    expect(rows.every((row) => row.addressable === false)).toBe(true);
    expect(rows[3]!.pluginLabel).toBe('Fixture research plugin');
    expect(heldCount(rows)).toBe(2);
  });

  it('addresses only the servers a name can address, and never a plugin’s', () => {
    const rows = mcpFallbackRows({
      servers: [
        { name: 'files', transport: 'stdio', status: 'connected' },
        { name: 'research-notes', transport: 'sse', status: 'connected' },
      ],
      catalog,
    });
    expect(rows[0]!.locator).toEqual({ source: 'global', name: 'files' });
    expect(rows[1]!.locator).toBeUndefined();
  });
});
