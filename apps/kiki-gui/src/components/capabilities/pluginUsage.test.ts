/**
 * The pure rules behind every plugin scope switch. The fixtures here declare
 * the four-level usage contract (home → global → workspace → session); they are
 * the contract under test, not a stand-in for the server's answer.
 */

import { describe, expect, it } from 'vitest';

import type { PluginUsageItem, PluginUsageResponse } from '@kiki/protocol';

import {
  availableCount,
  isStaleRevision,
  isStaleScope,
  isStaleTarget,
  overrideSource,
  ownOverride,
  panelScopeFrom,
  rowBlockedByHome,
  rowCanRestore,
  rowState,
  rowToggleIntent,
  scopeKey,
  scopeOf,
  sameScope,
  scopeTitle,
  withPendingOverride,
} from './pluginUsage';

function item(overrides: Partial<PluginUsageItem> = {}): PluginUsageItem {
  return {
    id: 'demo',
    displayName: 'Demo',
    home_enabled: true,
    global_enabled: true,
    state: 'ok',
    override: 'inherit',
    effective: true,
    app_service: false,
    skillCount: 0,
    mcpServerCount: 0,
    ...overrides,
  };
}

function response(overrides: Partial<PluginUsageResponse> = {}): PluginUsageResponse {
  return {
    home_id: 'home-1',
    target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' },
    revision: 3,
    apply_state: 'applied',
    errors: [],
    plugins: [],
    ...overrides,
  } as PluginUsageResponse;
}

describe('panel route identity', () => {
  it('uses explicit workspace B instead of an unrelated session A', () => {
    expect(panelScopeFrom(new URLSearchParams('workspace=ws-b&session=sess-a'))).toEqual({ target: { workspace_id: 'ws-b' }, sessionId: undefined });
    expect(panelScopeFrom(new URLSearchParams('workspace=ws-b'))).toEqual({ target: { workspace_id: 'ws-b' }, sessionId: undefined });
  });

  it('uses an explicit session for both document and bridge', () => {
    expect(panelScopeFrom(new URLSearchParams('session=sess-a'))).toEqual({ target: { session_id: 'sess-a' }, sessionId: 'sess-a' });
    expect(panelScopeFrom(new URLSearchParams('workspace=&session=sess-a'))).toEqual({ target: { session_id: 'sess-a' }, sessionId: 'sess-a' });
  });

  it('leaves untargeted and empty routes unscoped without consulting last session', () => {
    expect(panelScopeFrom(new URLSearchParams())).toEqual({ target: undefined, sessionId: undefined });
    expect(panelScopeFrom(new URLSearchParams('workspace=&session='))).toEqual({ target: undefined, sessionId: undefined });
  });
});

describe('scope identity', () => {
  it('keys a session target by its session and a workspace target by its workspace', () => {
    expect(scopeKey({ session_id: 'sess-1' })).toBe('session:sess-1');
    expect(scopeKey({ workspace_id: 'ws-a' })).toBe('ws-a');
    expect(scopeKey(undefined)).toBe('');
  });

  it('never lets a session target collide with a workspace target of the same text', () => {
    expect(scopeKey({ session_id: 'x' })).not.toBe(scopeKey({ workspace_id: 'x' }));
  });

  it('takes the workspace name from the server answer, not from the caller', () => {
    expect(scopeOf(response())).toEqual({ workspaceId: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' });
    expect(scopeOf(undefined)).toBeUndefined();
  });

  it('carries the session a targeted answer resolved to', () => {
    expect(scopeOf(response({ target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha', session_id: 'sess-a' } })))
      .toMatchObject({ sessionId: 'sess-a' });
  });

  it('treats two answers about different workspaces as different scopes', () => {
    expect(sameScope(scopeOf(response()), scopeOf(response({ target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta' } })))).toBe(false);
    expect(sameScope(scopeOf(response()), scopeOf(response()))).toBe(true);
  });

  it('never confuses a session answer with the workspace answer under it', () => {
    const sessionScoped = scopeOf(response({ target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha', session_id: 'sess-a' } }));
    expect(sameScope(sessionScoped, scopeOf(response()))).toBe(false);
  });

  it('titles the section with the workspace name the server returned', () => {
    const t = (key: 'rail.plugins.scope', params: { name: string }) => `This workspace · ${params.name}`;
    expect(scopeTitle({ workspaceId: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' }, t)).toBe('This workspace · Alpha');
  });
});

describe('late answers', () => {
  it('drops a save answer once the reader has moved to another target', () => {
    const requested = { session_id: 'sess-a' };
    expect(isStaleTarget(requested, { session_id: 'sess-a' })).toBe(false);
    expect(isStaleTarget(requested, { session_id: 'sess-b' })).toBe(true);
  });

  it('drops an answer that describes a workspace other than the one on screen', () => {
    const current = scopeOf(response());
    expect(isStaleScope(response({ target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta' } }), current)).toBe(true);
    expect(isStaleScope(response(), current)).toBe(false);
  });

  it('drops a session answer that landed after the reader changed session', () => {
    const current = scopeOf(response({ target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha', session_id: 'sess-b' } }));
    const late = response({ target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha', session_id: 'sess-a' } });
    expect(isStaleScope(late, current)).toBe(true);
  });

  it('accepts a first answer while the scope is still unknown', () => {
    expect(isStaleScope(response(), undefined)).toBe(false);
  });

  it('never lets an older revision undo a newer one', () => {
    expect(isStaleRevision(5, 4)).toBe(true);
    expect(isStaleRevision(5, 5)).toBe(false);
    expect(isStaleRevision(5, 6)).toBe(false);
    expect(isStaleRevision(undefined, 1)).toBe(false);
  });
});

describe('row state', () => {
  it('reports an inherited row by the effective answer', () => {
    expect(rowState(item())).toEqual({ kind: 'inherited', available: true });
    expect(rowState(item({ effective: false }))).toEqual({ kind: 'inherited', available: false });
  });

  it('reports a workspace override with the choice and the result', () => {
    expect(rowState(item({ override: 'off', effective: false }))).toEqual({ kind: 'overridden', available: false, on: false });
    expect(rowState(item({ override: 'on', effective: true }))).toEqual({ kind: 'overridden', available: true, on: true });
  });

  it('reads a session row from the session override, never from the workspace one', () => {
    const row = item({ override: 'off', effective: false, session_override: 'on' });
    expect(ownOverride(row)).toBe('on');
    expect(rowState(row)).toEqual({ kind: 'overridden', available: false, on: true });
  });

  it('falls back to the workspace override when a row carries no session one', () => {
    expect(ownOverride(item({ override: 'off' }))).toBe('off');
    expect(ownOverride(item({ override: 'off', session_override: 'inherit' }))).toBe('inherit');
  });

  it('refuses to call a home-disabled plugin usable even under an on override', () => {
    const blocked = item({ override: 'on', session_override: 'on', home_enabled: false, effective: false, reason: 'home_disabled' });
    expect(rowState(blocked)).toEqual({ kind: 'blocked', reason: 'home_disabled' });
    expect(rowToggleIntent(blocked)).toBeUndefined();
    expect(availableCount([blocked])).toBe(0);
  });

  it('treats an invalid plugin as blocked rather than merely off', () => {
    const invalid = item({ state: 'error', effective: false, reason: 'invalid_plugin' });
    expect(rowState(invalid)).toEqual({ kind: 'blocked', reason: 'invalid_plugin' });
    expect(rowToggleIntent(invalid)).toBeUndefined();
  });

  it('never turns a broken-home plugin on from a lower scope', () => {
    const errored = item({ state: 'error', effective: false });
    expect(rowBlockedByHome(errored)).toBe(true);
    expect(rowState(errored).kind).not.toBe('blocked');
  });

  it('treats a lower scope as an override of its own kind, not as blocked', () => {
    // A workspace `off` read from a session row is still a real override: the
    // session did not decide it, but it is also not merely "unavailable".
    expect(rowState(item({ override: 'off', effective: false, reason: 'workspace_disabled' }))).toEqual({ kind: 'overridden', available: false, on: false });
    expect(rowState(item({ session_override: 'off', effective: false, reason: 'session_disabled' }))).toEqual({ kind: 'overridden', available: false, on: false });
    // Only the global default leaving it alone reads as inherited-and-off.
    expect(rowState(item({ global_enabled: false, effective: false, reason: 'global_disabled' }))).toEqual({ kind: 'inherited', available: false });
  });
});

describe('override source', () => {
  it('blames the narrowest scope that decided', () => {
    expect(overrideSource(item({ session_override: 'off', override: 'off' }))).toBe('session');
    expect(overrideSource(item({ override: 'on' }))).toBe('workspace');
  });

  it('names the global default when no workspace decided', () => {
    expect(overrideSource(item({ global_enabled: false, effective: false }))).toBe('global');
    expect(overrideSource(item({ global_enabled: true }))).toBe('home');
  });

  it('does not blame the global default for a local on over an off default', () => {
    expect(overrideSource(item({ global_enabled: false, session_override: 'on', effective: true }))).toBe('session');
  });
});

describe('row actions', () => {
  it('asks for the opposite of the effective answer', () => {
    expect(rowToggleIntent(item({ effective: true }))).toEqual({ override: 'off', enabled: true });
    expect(rowToggleIntent(item({ effective: false }))).toEqual({ override: 'on', enabled: false });
  });

  it('offers restore only while this scope overrides something', () => {
    expect(rowCanRestore(item({ override: 'inherit' }))).toBe(false);
    expect(rowCanRestore(item({ override: 'off' }))).toBe(true);
    expect(rowCanRestore(item({ override: 'inherit', session_override: 'on' }))).toBe(true);
    expect(rowCanRestore(item({ override: 'off', session_override: 'inherit' }))).toBe(false);
  });

  it('shows the choice just made while the server has not answered yet', () => {
    expect(withPendingOverride(item({ effective: true }), 'off').effective).toBe(false);
    expect(withPendingOverride(item({ effective: false, override: 'off' }), 'on').effective).toBe(true);
  });

  it('does not let a pending on pretend a home-disabled plugin is live', () => {
    const blocked = withPendingOverride(item({ home_enabled: false, effective: false, reason: 'home_disabled' }), 'on');
    expect(blocked.effective).toBe(false);
  });

  it('counts only the plugins actually usable here', () => {
    expect(availableCount([
      item({ id: 'a', effective: true }),
      item({ id: 'b', effective: false }),
      item({ id: 'c', effective: false, reason: 'home_disabled' }),
    ])).toBe(1);
  });
});