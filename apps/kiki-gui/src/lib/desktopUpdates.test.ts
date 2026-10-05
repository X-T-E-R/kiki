// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopPrefs, writeDesktopPrefs } from '@kiki/session-core/settings';
import {
  autoCheckEnabled,
  checkDesktopUpdateOnce,
  checkForUpdateNow,
  compareVersions,
  hydrateUpdatePrefs,
  persistUpdatePreference,
  mayOfferUpdate,
  markUpdateChecked,
  readUpdatePrefs,
  resetUpdateCheckCache,
  skipUpdateVersion,
  snoozeUpdateUntil,
  updateCheckDue,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
} from './desktopUpdates';
import type { DesktopUpdate } from '../host';

const createUpdate = (version: string): DesktopUpdate => ({
  currentVersion: '1.0.0',
  version,
  install: vi.fn(async () => undefined),
});

beforeEach(() => {
  localStorage.clear();
  resetUpdateCheckCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('update preference mapping', () => {
  it('reads the existing three-state mode without a second switch', () => {
    expect(readUpdatePrefs()).toEqual({ autoUpdate: 'notify', updateChannel: 'stable' });

    writeDesktopPrefs({ autoUpdate: 'off' });
    expect(autoCheckEnabled(readUpdatePrefs().autoUpdate)).toBe(false);

    writeDesktopPrefs({ autoUpdate: 'install' });
    expect(autoCheckEnabled(readUpdatePrefs().autoUpdate)).toBe(true);
  });

  it('keeps an explicit install preference across the switch being rewritten', () => {
    writeDesktopPrefs({ autoUpdate: 'install' });
    // Turning checking off and back on must land on the plain notify default,
    // never on install: the user only chose install explicitly.
    writeDesktopPrefs({ autoUpdate: 'off' });
    writeDesktopPrefs({ autoUpdate: 'notify' });
    expect(readUpdatePrefs().autoUpdate).toBe('notify');
  });
});

describe('version comparison', () => {
  it('orders dotted versions numerically rather than lexically', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.3.9', '0.3.10')).toBe(-1);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('skipping a version', () => {
  it('silences only the version it names, on the channel it was offered on', () => {
    skipUpdateVersion('0.3.2', 'stable');
    expect(mayOfferUpdate('0.3.2', 'stable', 0)).toBe(false);
    // A higher version is news again, and the other channel was never skipped.
    expect(mayOfferUpdate('0.3.3', 'stable', 0)).toBe(true);
    expect(mayOfferUpdate('0.3.2', 'beta', 0)).toBe(true);
  });

  it('keeps only skipped versions below the new one', () => {
    skipUpdateVersion('0.3.2', 'stable');
    skipUpdateVersion('0.4.0', 'stable');
    expect(mayOfferUpdate('0.3.2', 'stable', 0)).toBe(false);
    expect(mayOfferUpdate('0.4.0', 'stable', 0)).toBe(false);
    expect(mayOfferUpdate('0.3.9', 'stable', 0)).toBe(true);
  });

  it('survives a reload of the stored record', () => {
    skipUpdateVersion('0.3.2', 'stable');
    expect(readDesktopPrefs().updateState?.skipped).toEqual({ stable: ['0.3.2'] });
  });
});

describe('snoozing a version', () => {
  it('holds a known update quiet for a day and then lets it speak again', () => {
    snoozeUpdateUntil(1_000);
    expect(mayOfferUpdate('0.3.2', 'stable', 1_000 + UPDATE_SNOOZE_MS - 1)).toBe(false);
    expect(mayOfferUpdate('0.3.2', 'stable', 1_000 + UPDATE_SNOOZE_MS)).toBe(true);
  });

  it('does not undo a skip when it snoozes', () => {
    skipUpdateVersion('0.3.2', 'stable');
    snoozeUpdateUntil(0);
    expect(mayOfferUpdate('0.3.2', 'stable', UPDATE_SNOOZE_MS + 1)).toBe(false);
  });
});

describe('check cadence', () => {
  it('is due on a fresh install and not again inside the interval', () => {
    expect(updateCheckDue(10_000)).toBe(true);
    markUpdateChecked(10_000);
    expect(updateCheckDue(10_000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(updateCheckDue(10_000 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('records a check even when nothing was found', () => {
    markUpdateChecked(5_000);
    expect(readDesktopPrefs().updateState?.lastCheckedAt).toBe(5_000);
  });
});

describe('single-flight check', () => {
  it('shares one request between callers that arrive together', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = {
      supportsDesktopUpdates: vi.fn(async () => { await gate; return true; }),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };

    const first = checkDesktopUpdateOnce(host, 0);
    const second = checkDesktopUpdateOnce(host, 0);
    release!();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('reuses a just-finished result instead of asking the feed again', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await checkDesktopUpdateOnce(host, 0);
    await checkDesktopUpdateOnce(host, 1_000);
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('reports an updater-less build as unsupported, not as a failure', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => false),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await expect(checkDesktopUpdateOnce(host, 0)).resolves.toEqual({ kind: 'unsupported' });
    expect(host.checkDesktopUpdate).not.toHaveBeenCalled();
  });

  it('separates a failed check from a current install', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => { throw new Error('offline'); }),
    };
    await expect(checkDesktopUpdateOnce(host, 0)).resolves.toEqual({ kind: 'failed' });
  });

  it('reports a clean feed as current', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => null),
    };
    await expect(checkDesktopUpdateOnce(host, 0)).resolves.toEqual({ kind: 'current' });
  });
});

describe('manual check', () => {
  it('ignores a skip and a snooze, and still advances the cadence', async () => {
    skipUpdateVersion('0.3.2', 'stable');
    snoozeUpdateUntil(0);
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await expect(checkForUpdateNow(host, 10_000)).resolves.toMatchObject({
      result: { kind: 'update' },
    });
    expect(readDesktopPrefs().updateState?.lastCheckedAt).toBe(10_000);
  });

  it('reports that the check itself was not recorded when the host refuses the write', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => null),
      writeDesktopPrefs: vi.fn(async () => { throw new Error('native write refused'); }),
    };
    await expect(checkForUpdateNow(host, 10_000)).resolves.toEqual({
      result: { kind: 'current' },
      persisted: false,
      channel: 'stable',
    });
  });
});

describe('the record is written whole, and to both sides', () => {
  /** A native stand-in that records the patch it was handed. */
  function nativeHost(reject = false) {
    const patches: unknown[] = [];
    return {
      patches,
      host: {
        writeDesktopPrefs: async (prefs: unknown) => {
          if (reject) throw new Error('native write refused');
          patches.push(prefs);
        },
      },
    };
  }

  it('replaces the record whole, so a field it leaves out cannot survive', async () => {
    // The native side reads an absent field as a field to clear, so every
    // writer has to name all three. A skip that did not mention the cadence
    // anchor would silently reset it and the app would check on every launch.
    writeDesktopPrefs({ updateState: { lastCheckedAt: 1_000 } });
    const { host, patches } = nativeHost();
    await skipUpdateVersion('0.3.2', 'stable', host);

    expect(patches).toEqual([{
      updateState: {
        skipped: { stable: ['0.3.2'], beta: null },
        snoozedUntil: null,
        lastCheckedAt: 1_000,
      },
    }]);
  });

  it('sends only the record, never a snapshot of the other preferences', async () => {
    writeDesktopPrefs({ notifications: false, closeToTray: false, autoUpdate: 'install' });
    const { host, patches } = nativeHost();
    await snoozeUpdateUntil(0, host);

    // A snapshot would roll back a switch another window changed in the
    // meantime; the record is the only thing this write is about.
    expect(Object.keys(patches[0] as object)).toEqual(['updateState']);
  });

  it("keeps the other channel's skips when this one is written", async () => {
    writeDesktopPrefs({ updateState: { skipped: { stable: ['0.3.2'] } } });
    const { host, patches } = nativeHost();
    await skipUpdateVersion('0.4.0', 'beta', host);

    expect((patches[0] as { updateState: { skipped: unknown } }).updateState.skipped)
      .toEqual({ stable: ['0.3.2'], beta: ['0.4.0'] });
  });

  it('reports a refused native write instead of pretending the record was kept', async () => {
    const { host } = nativeHost(true);
    await expect(skipUpdateVersion('0.3.2', 'stable', host)).resolves.toBe(false);
    // The local mirror still holds it, so this window behaves correctly; the
    // caller is told the truth about the restart.
    expect(mayOfferUpdate('0.3.2', 'stable', 0)).toBe(false);
  });

  it('reports a host with no write capability rather than claiming success', async () => {
    await expect(markUpdateChecked(5_000, {})).resolves.toBe(false);
  });
});

describe('the reuse window is per channel', () => {
  it('does not serve a stable result to a beta check', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await checkDesktopUpdateOnce(host, 0, 'stable');
    await checkDesktopUpdateOnce(host, 1_000, 'stable');
    // Same window in time, different feed.
    await checkDesktopUpdateOnce(host, 1_000, 'beta');
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('still shares one request between two callers on the same channel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = {
      supportsDesktopUpdates: vi.fn(async () => { await gate; return true; }),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const stable = checkDesktopUpdateOnce(host, 0, 'stable');
    const sameChannel = checkDesktopUpdateOnce(host, 0, 'stable');
    const beta = checkDesktopUpdateOnce(host, 0, 'beta');
    release();
    await Promise.all([stable, sameChannel, beta]);
    // One request per channel, not one in total and not two for stable.
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('a manual check asks the channel in force, not the last one used', async () => {
    const asked: string[] = [];
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => { asked.push('asked'); return null; }),
    };
    await checkForUpdateNow(host, 0, 'stable');
    await checkForUpdateNow(host, 1_000, 'beta');
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(['asked', 'asked']);
    await expect(checkForUpdateNow(host, 2_000, 'beta')).resolves.toMatchObject({ channel: 'beta' });
  });
});

describe('real channel request boundary', () => {
  it('passes the requested channel even while the native preference still names the old feed', async () => {
    const checkDesktopUpdate = vi.fn(async (channel?: string) => createUpdate(channel === 'beta' ? '0.4.0-beta.1' : '0.3.2'));
    const result = await checkDesktopUpdateOnce({ supportsDesktopUpdates: async () => true, checkDesktopUpdate }, 0, 'beta');
    expect(checkDesktopUpdate).toHaveBeenCalledWith('beta');
    expect(result).toMatchObject({ kind: 'update', update: { version: '0.4.0-beta.1' } });
  });
});

describe('atomic native update choices', () => {
  it('sends only intent and mirrors the latest native state, never its stale replacement', async () => {
    writeDesktopPrefs({ updateState: { lastCheckedAt: 1 } });
    const current = { skipped: { stable: ['0.3.2'], beta: ['0.4.0-beta.1'] }, snoozedUntil: 999, lastCheckedAt: 123 };
    const mutateDesktopUpdateState = vi.fn(async () => current);
    const writeNative = vi.fn(async () => {});
    const host = { mutateDesktopUpdateState, writeDesktopPrefs: writeNative };
    await markUpdateChecked(123, host);
    await skipUpdateVersion('0.3.2', 'stable', host);
    await snoozeUpdateUntil(100, host);
    expect(mutateDesktopUpdateState.mock.calls).toEqual([
      [{ kind: 'checked', at: 123 }],
      [{ kind: 'skip', channel: 'stable', version: '0.3.2' }],
      [{ kind: 'snooze', until: 100 + UPDATE_SNOOZE_MS }],
    ]);
    expect(writeNative).not.toHaveBeenCalled();
    expect(readDesktopPrefs().updateState).toEqual(current);
  });

  it('keeps the last confirmed mirror on a refused atomic choice so retry remains real', async () => {
    writeDesktopPrefs({ updateState: { lastCheckedAt: 123 } });
    const host = { mutateDesktopUpdateState: vi.fn(async () => { throw new Error('disk refused'); }) };
    expect(await skipUpdateVersion('0.3.2', 'stable', host)).toBe(false);
    expect(readDesktopPrefs().updateState).toEqual({ lastCheckedAt: 123 });
    expect(mayOfferUpdate('0.3.2', 'stable', 0)).toBe(true);
  });
});

describe('hydration and in-window write ordering', () => {
  it('discards a boot snapshot overtaken by a native preference write', async () => {
    let release!: () => void;
    const oldRead = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let nativeChannel: 'stable' | 'beta' = 'stable';
    const host = {
      readDesktopPrefs: async () => {
        const snapshot = nativeChannel;
        if (++reads === 1) await oldRead;
        return { ...readDesktopPrefs(), updateChannel: snapshot, updateState: undefined };
      },
      writeDesktopPrefs: async () => { nativeChannel = 'beta'; },
    };
    const hydration = hydrateUpdatePrefs(host);
    await Promise.resolve();
    writeDesktopPrefs({ updateChannel: 'beta', updateState: { lastCheckedAt: 1 } });
    await persistUpdatePreference(host, { updateChannel: 'beta' });
    release();
    await hydration;
    expect(reads).toBe(2);
    expect(readDesktopPrefs().updateChannel).toBe('beta');
    expect(readDesktopPrefs().updateState).toBeUndefined();
  });
});
