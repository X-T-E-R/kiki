// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { configureSpaceStorage } from './spaceStorage';
import { readSpaceViewRoute, writeSpaceViewRoute } from './spaceViewState';
import { adoptWindowId, configureWorkModes, readWindowModeId, windowRouteSlot, writeWindowModeId } from './workModes';

/**
 * The product promise these cover: two windows on one home hold different
 * modes and different views at the same time, a mode is per home rather than
 * global, and neither reading nor writing a window's mode touches anything a
 * session owns.
 */
describe('window work modes', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    configureSpaceStorage(null);
    configureWorkModes({ homeId: 'main' });
    adoptWindowId('w-one');
  });

  it('gives two windows on one home independent modes', () => {
    // Window one picks Work; window two, same home, must not see it.
    writeWindowModeId('work');
    expect(readWindowModeId()).toBe('work');

    adoptWindowId('w-two');
    expect(readWindowModeId()).toBe('kiki');
    writeWindowModeId('kiki');
    expect(readWindowModeId()).toBe('kiki');

    // Window one is still in Work after window two switched.
    adoptWindowId('w-one');
    expect(readWindowModeId()).toBe('work');
  });

  it('keeps modes apart across homes and windows', () => {
    writeWindowModeId('work');
    configureSpaceStorage({ homeId: 'h-b', isPrimary: false });
    configureWorkModes({ homeId: 'h-b' });
    writeWindowModeId('kiki');
    // A second window on that home sees that home's choice, not main's.
    adoptWindowId('w-two');
    expect(readWindowModeId()).toBe('kiki');

    // Back on main, THIS window (w-two) has never chosen there, so it reads the
    // baseline — it does not inherit w-one's Work. The key is namespaced per
    // home, and the mode is stored per window inside it.
    configureSpaceStorage(null);
    configureWorkModes({ homeId: 'main' });
    expect(readWindowModeId()).toBe('kiki');

    // The window that did choose is unaffected by anything w-two did.
    adoptWindowId('w-one');
    expect(readWindowModeId()).toBe('work');
  });

  it('reads a mode stored before windows were separated, without sharing it', () => {
    // An existing install has one value under the bare home id.
    localStorage.setItem('kiki.windowMode', JSON.stringify({ main: 'work' }));
    expect(readWindowModeId()).toBe('work');

    // A second window may read that legacy value, but writing its own must not
    // overwrite the first window's slot.
    adoptWindowId('w-two');
    writeWindowModeId('kiki');
    adoptWindowId('w-one');
    writeWindowModeId('work');
    expect(readWindowModeId()).toBe('work');
    adoptWindowId('w-two');
    expect(readWindowModeId()).toBe('kiki');
  });

  it('reads the baseline mode when nothing was chosen', () => {
    expect(readWindowModeId()).toBe('kiki');
  });

  it('keeps a chosen mode for the window that chose it', () => {
    writeWindowModeId('work');
    expect(readWindowModeId()).toBe('work');
  });

  it('gives each window its own route slot, so neither overwrites the other', () => {
    writeSpaceViewRoute('/s/session-in-window-one', 'local');
    // A second window on the same home and the same scope is a different slot.
    adoptWindowId('w-two');
    expect(windowRouteSlot('local')).toBe('local::w-two');
    expect(readSpaceViewRoute('local')).toBeUndefined();

    writeSpaceViewRoute('/work', 'local');
    expect(readSpaceViewRoute('local')).toBe('/work');

    // The first window still has its own session open.
    adoptWindowId('w-one');
    expect(readSpaceViewRoute('local')).toBe('/s/session-in-window-one');
  });

  it('keeps a route written before window slots existed readable', () => {
    localStorage.setItem('kiki.viewRoute', JSON.stringify({ local: '/s/older' }));
    expect(readSpaceViewRoute('local')).toBe('/s/older');
  });

  it('scopes the mode by home, so a second space starts at the baseline', () => {
    writeWindowModeId('work');
    configureWorkModes({ homeId: 'h-second-space' });
    expect(readWindowModeId()).toBe('kiki');

    writeWindowModeId('work');
    configureWorkModes({ homeId: 'main' });
    expect(readWindowModeId()).toBe('work');
  });

  it('rejects a mode id that is not a plain identifier', () => {
    writeWindowModeId('../../etc/passwd');
    expect(readWindowModeId()).toBe('kiki');
  });

  it('keeps the same home reachable under two windows at once', () => {
    writeWindowModeId('work');
    configureSpaceStorage({ homeId: 'h-a', isPrimary: false });
    configureWorkModes({ homeId: 'h-a' });
    writeWindowModeId('work');
    writeSpaceViewRoute('/work', 'local');

    configureSpaceStorage({ homeId: 'h-b', isPrimary: false });
    configureWorkModes({ homeId: 'h-b' });
    // A different home is a different data boundary and a different view.
    expect(readSpaceViewRoute('local')).toBeUndefined();
    expect(readWindowModeId()).toBe('kiki');
  });
});
