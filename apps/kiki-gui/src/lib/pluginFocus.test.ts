/**
 * Scenario: a plugin asks the desktop to show one live session.
 * Responsibilities: same-connection focus, owner restore, and native intent matching.
 * Wiring: the decision functions are real; no router, host, timer, or network.
 * Run: node --experimental-strip-types --test src/lib/pluginFocus.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  desktopPluginFocus,
  desktopPluginFocusTargets,
  pluginFocusStep,
  pluginSessionRoute,
  type PluginFocusCursor,
} from './pluginFocus';

const idle: PluginFocusCursor = { initialized: false, seenId: 0 };
const watching: PluginFocusCursor = { initialized: true, seenId: 4 };
const owner = { homeId: 'space-a', scopeId: 'local' };

describe('plugin session focus', () => {
  it('records the existing request when the watcher starts, and does not focus it', () => {
    const step = pluginFocusStep({
      request: { id: 7, sessionId: 'session-a' },
      cursor: idle,
      sameConnection: true,
      owner,
    });
    expect(step).toEqual({ kind: 'remember', cursor: { initialized: true, seenId: 7 } });
  });

  it('returns the current connection route when a newer request arrives there', () => {
    const step = pluginFocusStep({
      request: { id: 8, sessionId: 'session a' },
      cursor: watching,
      sameConnection: true,
      owner,
    });
    expect(step).toEqual({
      kind: 'focus-current',
      cursor: { initialized: true, seenId: 8 },
      route: '/s/session%20a',
    });
  });

  it('returns the owning home when a newer request belongs to another connection', () => {
    const step = pluginFocusStep({
      request: { id: 8, sessionId: 'session-a' },
      cursor: watching,
      sameConnection: false,
      owner,
    });
    expect(step).toEqual({
      kind: 'restore-owner',
      cursor: { initialized: true, seenId: 8 },
      homeId: 'space-a',
      scopeId: 'local',
      route: '/s/session-a',
    });
  });

  it('ignores a request id that was already recorded', () => {
    const step = pluginFocusStep({
      request: { id: 4, sessionId: 'session-a' },
      cursor: watching,
      sameConnection: true,
      owner,
    });
    expect(step).toEqual({ kind: 'remember', cursor: watching });
  });

  it('records an empty session id without a route', () => {
    expect(pluginSessionRoute('')).toBeUndefined();
    const step = pluginFocusStep({
      request: { id: 9, sessionId: '' },
      cursor: watching,
      sameConnection: false,
      owner,
    });
    expect(step).toEqual({ kind: 'remember', cursor: { initialized: true, seenId: 9 } });
  });

  it('keeps a native intent when its home is the page home', () => {
    const intent = desktopPluginFocus({ homeId: 'space-a', route: '/s/session-a', requestId: 3 });
    expect(desktopPluginFocusTargets(intent, 'space-a')).toEqual({
      homeId: 'space-a',
      route: '/s/session-a',
      requestId: 3,
    });
  });

  it('drops a native intent when its home is not the page home', () => {
    const intent = desktopPluginFocus({ homeId: 'space-a', route: '/s/session-a', requestId: 3 });
    expect(desktopPluginFocusTargets(intent, 'space-b')).toBeUndefined();
  });

  it('drops a native intent whose route is not a session route', () => {
    expect(desktopPluginFocus({ homeId: 'space-a', route: '/usage', requestId: 3 })).toBeUndefined();
    expect(desktopPluginFocus(null)).toBeUndefined();
  });
});
