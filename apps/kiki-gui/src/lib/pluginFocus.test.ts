/**
 * Scenario: a plugin asks the desktop to show one live session.
 * Responsibilities: same-connection focus, owner restore, scope handoff, and consumed identity.
 * Wiring: the decision functions are real; no router, host, timer, or network.
 * Run: node --experimental-strip-types --test src/lib/pluginFocus.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  desktopPluginFocus,
  desktopPluginFocusHandoff,
  pluginFocusPublication,
  pluginFocusSameIdentity,
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

  it('hands a background intent to the local scope transaction for its own home', () => {
    expect(desktopPluginFocusHandoff({ homeId: 'space-a', route: '/s/session-a', requestId: 3 })).toEqual({
      homeId: 'space-a',
      scopeId: 'local',
      route: '/s/session-a',
      requestId: 3,
    });
  });

  it('drops a native intent whose route is not a session route', () => {
    expect(desktopPluginFocus({ homeId: 'space-a', route: '/usage', requestId: 3 })).toBeUndefined();
    expect(desktopPluginFocusHandoff({ homeId: 'space-a', route: '/usage', requestId: 3 })).toBeUndefined();
    expect(desktopPluginFocus(null)).toBeUndefined();
    expect(desktopPluginFocusHandoff(null)).toBeUndefined();
  });

  it('does not match an ack for home A request 1 to pending home B request 1', () => {
    expect(pluginFocusSameIdentity({ homeId: 'space-b', requestId: 1 }, { homeId: 'space-a', requestId: 1 })).toBe(false);
  });

  it('matches an ack when the home and the request id are both the pending identity', () => {
    expect(pluginFocusSameIdentity({ homeId: 'space-b', requestId: 1 }, { homeId: 'space-b', requestId: 1 })).toBe(true);
  });

  it('does not match an ack when no intent is pending', () => {
    expect(pluginFocusSameIdentity(undefined, { homeId: 'space-b', requestId: 1 })).toBe(false);
  });

  it('does not match an ack when the armed focus is the null initial value', () => {
    expect(pluginFocusSameIdentity(null, { homeId: 'space-a', requestId: 1 })).toBe(false);
  });

  it('does not publish a request that was only recorded', () => {
    const step = pluginFocusStep({
      request: { id: 7, sessionId: 'session-a' },
      cursor: idle,
      sameConnection: true,
      owner,
    });
    expect(pluginFocusPublication(step, owner)).toBeUndefined();
  });

  it('does not publish an empty session id that was only recorded', () => {
    const step = pluginFocusStep({
      request: { id: 9, sessionId: '' },
      cursor: watching,
      sameConnection: false,
      owner,
    });
    expect(pluginFocusPublication(step, owner)).toBeUndefined();
  });

  it('publishes the current home when that connection focuses a newer request', () => {
    const step = pluginFocusStep({
      request: { id: 8, sessionId: 'session-a' },
      cursor: watching,
      sameConnection: true,
      owner,
    });
    expect(pluginFocusPublication(step, owner)).toEqual({ homeId: 'space-a', requestId: 8 });
  });

  it('publishes the owning home when another connection focuses a newer request', () => {
    const step = pluginFocusStep({
      request: { id: 8, sessionId: 'session-a' },
      cursor: watching,
      sameConnection: false,
      owner,
    });
    expect(pluginFocusPublication(step, owner)).toEqual({ homeId: 'space-a', requestId: 8 });
  });
});
