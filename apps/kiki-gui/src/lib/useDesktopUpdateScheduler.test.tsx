// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopPrefs, writeDesktopPrefs, type DesktopNativePrefs } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from './toasts';
import { registerOverlay } from './uiBusy';
import { resetUpdateCheckCache, UPDATE_CHECK_INTERVAL_MS, UPDATE_STARTUP_DELAY_MS } from './desktopUpdates';
import { useDesktopUpdateScheduler, UPDATE_DIALOG_OVERLAY, type DesktopUpdateScheduler } from './useDesktopUpdateScheduler';
import type { DesktopUpdate } from '../host';

const createUpdate = (version: string, install?: () => Promise<void>): DesktopUpdate => ({
  currentVersion: '1.0.0',
  version,
  notes: 'Faster session switching.',
  install: vi.fn(install ?? (async () => undefined)),
});

/**
 * A stand-in for the native side's `desktop.json`: what a real `write_desktop_prefs`
 * stores, and what `read_desktop_prefs` hands back. `reject` makes every write
 * fail the way a native call does, so the test can prove no rejection is left
 * unhandled and the user can retry.
 */
function nativeStore(initial: Partial<DesktopNativePrefs> = {}) {
  const store: Partial<DesktopNativePrefs> = { ...initial };
  const state = { reject: false };
  return {
    store,
    state,
    host: {
      supportsDesktopUpdates: async () => true,
      checkDesktopUpdate: async (): Promise<DesktopUpdate | null> => null,
      readDesktopPrefs: async () => store as DesktopNativePrefs,
      writeDesktopPrefs: async (prefs: Partial<DesktopNativePrefs>) => {
        if (state.reject) throw new Error('native write refused');
        Object.assign(store, prefs);
      },
    },
  };
}

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

interface HarnessProps {
  /** The narrow host the scheduler actually uses: check, plus the prefs it
   *  reads at boot and writes when it records a choice. */
  readonly host: {
    supportsDesktopUpdates: () => Promise<boolean>;
    checkDesktopUpdate: () => Promise<DesktopUpdate | null>;
    readDesktopPrefs?: () => Promise<DesktopNativePrefs | null>;
    writeDesktopPrefs?: (prefs: Partial<DesktopNativePrefs>) => Promise<void>;
  };
  readonly isDesktop?: boolean;
  readonly hasPendingApproval?: boolean;
  readonly onChange: (scheduler: DesktopUpdateScheduler) => void;
}

/**
 * The fake timers fake `Date` too, so the scheduler's default clock moves with
 * the intervals the test advances. A check a day later is a genuinely later
 * check rather than the same result served from the cache.
 */
function Harness({ host, isDesktop = true, hasPendingApproval = false, onChange }: HarnessProps) {
  const scheduler = useDesktopUpdateScheduler({ host, isDesktop, hasPendingApproval });
  onChange(scheduler);
  return null;
}

async function mount(props: Omit<HarnessProps, 'onChange'>): Promise<{ current: DesktopUpdateScheduler }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const handle = { current: undefined as unknown as DesktopUpdateScheduler };
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness {...props} onChange={(scheduler) => { handle.current = scheduler; }} />
      </I18nProvider>,
    );
  });
  return handle;
}

/** Let a timer fire and the check promise settle. */
async function settle(ms = UPDATE_STARTUP_DELAY_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetUpdateCheckCache();
  clearToasts();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  vi.useRealTimers();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe('desktop update scheduler', () => {
  it('does not check before the first screen has had a moment', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host });

    await settle(UPDATE_STARTUP_DELAY_MS - 1);
    expect(host.checkDesktopUpdate).not.toHaveBeenCalled();

    await settle(1);
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('never checks on a browser host', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host, isDesktop: false });

    await settle(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(host.supportsDesktopUpdates).not.toHaveBeenCalled();
  });

  it('stops checking when automatic checking is off', async () => {
    writeDesktopPrefs({ autoUpdate: 'off' });
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host });

    await settle(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(host.checkDesktopUpdate).not.toHaveBeenCalled();
  });

  it('offers the update it found instead of installing it', async () => {
    const update = createUpdate('0.3.2');
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => update),
    };
    const scheduler = await mount({ host });
    await settle();

    expect(scheduler.current.offer).toMatchObject({ channel: 'stable' });
    expect(update.install).not.toHaveBeenCalled();
  });

  it('installs on its own only for the preference that says to', async () => {
    writeDesktopPrefs({ autoUpdate: 'install' });
    const update = createUpdate('0.3.2');
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => update),
    };
    const scheduler = await mount({ host });
    await settle();

    expect(update.install).toHaveBeenCalledOnce();
    expect(scheduler.current.offer).toBeNull();
  });

  it('says nothing when there is no new version', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => null),
    };
    const scheduler = await mount({ host });
    await settle();

    expect(scheduler.current.offer).toBeNull();
  });

  it('waits for a day before the next check, and does not re-check on an early focus change', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host });
    await settle();
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    await settle(UPDATE_CHECK_INTERVAL_MS - 1);
    // Back well before the day is up. The result cache would have aged out by
    // now, and checking anyway is exactly the request this test forbids.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    // The interval is measured from the focus change, not from the check that
    // was skipped, so a day has to pass from there before anything is asked.
    await settle(UPDATE_CHECK_INTERVAL_MS);
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('catches up on the window coming back after the day has run out', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host });
    await settle();
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    // The window was hidden past the interval and comes back after it.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('keeps one offer through a locale change instead of re-checking', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const scheduler = await mount({ host });
    await settle();
    expect(scheduler.current.offer).not.toBeNull();

    localStorage.setItem('kiki.locale', 'zh');
    // Long enough that a scheduler re-created by the locale change would have
    // started its own startup check. The one schedule does not.
    await settle(UPDATE_CHECK_INTERVAL_MS / 2);
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
    expect(scheduler.current.offer?.update.version).toBe('0.3.2');
  });

  it('holds the offer while another overlay owns the screen, and shows it once that clears', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const release = registerOverlay('test-menu');
    const scheduler = await mount({ host });
    await settle();

    expect(scheduler.current.offer).toBeNull();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(scheduler.current.offer?.update.version).toBe('0.3.2');
  });

  it('is not blocked by the update dialog it is about to show', async () => {
    // The dialog registers its own overlay; if the wait counted that, the
    // offer could never reach the screen.
    const release = registerOverlay(UPDATE_DIALOG_OVERLAY);
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const scheduler = await mount({ host });
    await settle();

    expect(scheduler.current.offer?.update.version).toBe('0.3.2');
    release();
  });

  it('holds the offer while an approval is waiting on the user', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const scheduler = await mount({ host, hasPendingApproval: true });
    await settle();
    expect(scheduler.current.offer).toBeNull();
  });

  it('does not start a second check when the component mounts twice', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    await mount({ host });
    await mount({ host });
    await settle();

    // Single-flight plus a short result cache: two mounts, one feed request.
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('stops its timer when it unmounts', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => createUpdate('0.3.2')),
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <Harness host={host} onChange={() => {}} />
        </I18nProvider>,
      );
    });
    await act(async () => { root.unmount(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3); });
    expect(host.checkDesktopUpdate).not.toHaveBeenCalled();
    container.remove();
  });
});

describe('desktop update scheduler answers', () => {
  async function findOne(): Promise<{ scheduler: { current: DesktopUpdateScheduler }; host: { supportsDesktopUpdates: () => Promise<boolean>; checkDesktopUpdate: () => Promise<DesktopUpdate | null>; readDesktopPrefs?: () => Promise<DesktopNativePrefs | null>; writeDesktopPrefs?: (prefs: Partial<DesktopNativePrefs>) => Promise<void> }; native: ReturnType<typeof nativeStore>; update: DesktopUpdate }> {
    const update = createUpdate('0.3.2');
    // A host that stores what it is told, so a choice that was actually kept
    // can close the offer. Without it every answer would read as a failure.
    const native = nativeStore();
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => update),
      readDesktopPrefs: native.host.readDesktopPrefs,
      writeDesktopPrefs: native.host.writeDesktopPrefs,
    };
    const scheduler = await mount({ host });
    await settle();
    return { scheduler, host, update, native };
  }

  it('puts a dismissed offer off for a day and says when it will ask again', async () => {
    const { scheduler } = await findOne();
    await act(async () => { await scheduler.current.onRemindLater(scheduler.current.offer!); });

    expect(scheduler.current.offer).toBeNull();
    expect(getToasts().map((toast) => toast.text)).toEqual([
      'Kiki will ask again tomorrow.',
    ]);

    resetUpdateCheckCache();
    const later = createUpdate('0.3.2');
    const handle = await mount({
      host: {
        supportsDesktopUpdates: async () => true,
        checkDesktopUpdate: async () => later,
        readDesktopPrefs: async () => null,
        writeDesktopPrefs: async () => {},
      },
    });
    await settle();
    expect(handle.current.offer).toBeNull();
  });

  it('stops offering a skipped version but not the next one', async () => {
    const { scheduler } = await findOne();
    await act(async () => { await scheduler.current.onSkip(scheduler.current.offer!); });

    expect(scheduler.current.offer).toBeNull();
    expect(getToasts().map((toast) => toast.text)).toEqual([
      'Kiki will not ask about 0.3.2 again. Newer versions still come.',
    ]);

    resetUpdateCheckCache();
    const same = createUpdate('0.3.2');
    const again = await mount({
      host: {
        supportsDesktopUpdates: async () => true,
        checkDesktopUpdate: async () => same,
        readDesktopPrefs: async () => null,
        writeDesktopPrefs: async () => {},
      },
    });
    await settle();
    expect(again.current.offer).toBeNull();

    resetUpdateCheckCache();
    // A fresh window also honours today's check. A newer offer is discovered when the day is due.
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS);
    const newer = createUpdate('0.3.3');
    const next = await mount({
      host: {
        supportsDesktopUpdates: async () => true,
        checkDesktopUpdate: async () => newer,
        readDesktopPrefs: async () => null,
        writeDesktopPrefs: async () => {},
      },
    });
    await settle();
    expect(next.current.offer?.update.version).toBe('0.3.3');
  });

  it('keeps the dialog open with a reason when the install does not happen, so retry is the same button', async () => {
    const update = createUpdate('0.3.2', async () => { throw new Error('cancelled'); });
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => update),
    };
    const scheduler = await mount({ host });
    await settle();
    await act(async () => { scheduler.current.onUpdate(scheduler.current.offer!); });

    expect(scheduler.current.installing).toBe(false);
    expect(scheduler.current.installError).toContain('did not complete');
    // Still on screen: the offer was never resolved into a success.
    expect(scheduler.current.offer).not.toBeNull();
  });

  it('clears the offer and says to restart once the install lands', async () => {
    const { scheduler, update } = await findOne();
    await act(async () => { scheduler.current.onUpdate(scheduler.current.offer!); });

    expect(update.install).toHaveBeenCalledOnce();
    expect(scheduler.current.offer).toBeNull();
    expect(getToasts().map((toast) => toast.text)).toEqual([
      'The update is installed. Restart Kiki to finish updating.',
    ]);
  });

  it('says nothing more when the dialog is closed', async () => {
    const { scheduler } = await findOne();
    await act(async () => { scheduler.current.onDismiss(); });

    expect(scheduler.current.offer).toBeNull();
    expect(getToasts()).toHaveLength(0);
  });
});

describe('the update record reaches the native side', () => {
  /** A host that finds an update and stores what the scheduler writes. */
  function finding(version = '0.3.2') {
    const native = nativeStore();
    return {
      native,
      host: {
        ...native.host,
        checkDesktopUpdate: async () => createUpdate(version),
      },
    };
  }

  it('stores the cadence anchor natively, so the next launch waits a day', async () => {
    const { native, host } = finding();
    await mount({ host });
    await settle();

    expect(native.store.updateState?.lastCheckedAt).toBeTypeOf('number');
    expect(readDesktopPrefs().updateState?.lastCheckedAt).toBe(native.store.updateState?.lastCheckedAt);
  });

  it('stores a skip natively, keyed to the channel it was offered on', async () => {
    const { native, host } = finding();
    const scheduler = await mount({ host });
    await settle();
    await act(async () => { await scheduler.current.onSkip(scheduler.current.offer!); });

    expect(native.store.updateState?.skipped).toEqual({ stable: ['0.3.2'], beta: null });
  });

  it('stores a snooze natively, keeping the skip that was already there', async () => {
    const { native, host } = finding();
    const scheduler = await mount({ host });
    await settle();
    await act(async () => { await scheduler.current.onSkip(scheduler.current.offer!); });
    await act(async () => { await scheduler.current.onRemindLater(scheduler.current.offer!); });

    const stored = native.store.updateState!;
    expect(stored.skipped).toEqual({ stable: ['0.3.2'], beta: null });
    expect(stored.snoozedUntil).toBeGreaterThan(0);
  });

  it('says the choice did not last when the native write is refused, and can be retried', async () => {
    const { native, host } = finding();
    native.state.reject = true;
    const scheduler = await mount({ host });
    await settle();

    await act(async () => { await scheduler.current.onSkip(scheduler.current.offer!); });
    expect(scheduler.current.persistError).toContain('did not save that choice');
    expect(native.store.updateState).toBeUndefined();

    // The retry lands once the native side takes writes again.
    native.state.reject = false;
    resetUpdateCheckCache();
    const again = createUpdate('0.3.2');
    const retry = await mount({
      host: { ...host, checkDesktopUpdate: async () => again },
    });
    await settle();
    await act(async () => { retry.current.onSkip(retry.current.offer!); });
    expect(native.store.updateState?.skipped).toEqual({ stable: ['0.3.2'], beta: null });
    expect(retry.current.persistError).toBeNull();
  });

  it('drops a mirror that still holds a skip the native side no longer has', async () => {
    // The user cleared the record natively (or it was never written); the
    // localStorage mirror still names the version, and would silence the offer
    // on every launch from then on.
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({
      autoUpdate: 'notify',
      updateChannel: 'stable',
      updateState: { skipped: { stable: ['0.3.2'] }, snoozedUntil: Number.MAX_SAFE_INTEGER },
    }));
    const native = nativeStore({ autoUpdate: 'notify', updateChannel: 'stable' });
    const host = { ...native.host, checkDesktopUpdate: async () => createUpdate('0.3.2') };

    const scheduler = await mount({ host });
    await settle();

    expect(scheduler.current.offer?.update.version).toBe('0.3.2');
    expect(readDesktopPrefs().updateState?.skipped).toBeUndefined();
  });
});

describe('closing the dialog is not a skip', () => {
  it('stays quiet about the same version for the rest of this run', async () => {
    const native = nativeStore();
    const host = { ...native.host, checkDesktopUpdate: async () => createUpdate('0.3.2') };
    const scheduler = await mount({ host });
    await settle();
    await act(async () => { scheduler.current.onDismiss(); });
    expect(scheduler.current.offer).toBeNull();

    // Well past the result cache, the day is not up, so the cadence does not
    // ask. Move the clock to the due point and the same version must still not
    // come back in this run.
    await settle(UPDATE_CHECK_INTERVAL_MS + 1);
    expect(scheduler.current.offer).toBeNull();
    // Nothing about the version was stored, so a restart is free to ask again.
    // The cadence anchor is a separate fact and is expected to be there.
    expect(native.store.updateState?.skipped).toEqual({ stable: null, beta: null });
    expect(native.store.updateState?.snoozedUntil ?? null).toBeNull();
  });

  it('still offers a different version in the same run', async () => {
    const native = nativeStore();
    const scheduler = await mount({
      host: { ...native.host, checkDesktopUpdate: async () => createUpdate('0.3.2') },
    });
    await settle();
    await act(async () => { scheduler.current.onDismiss(); });

    resetUpdateCheckCache();
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS);
    const next = await mount({
      host: { ...native.host, checkDesktopUpdate: async () => createUpdate('0.3.3') },
    });
    await settle();
    expect(next.current.offer?.update.version).toBe('0.3.3');
  });
});

describe('a slow check answers the preferences in force when it lands', () => {
  /** A check the test releases by hand, so a change can happen mid-flight. */
  function slowCheck() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = {
      supportsDesktopUpdates: async () => true,
      checkDesktopUpdate: async () => { await gate; return createUpdate('0.3.2'); },
      readDesktopPrefs: async () => null,
      writeDesktopPrefs: async () => {},
    };
    return { host, release: () => { release(); } };
  }

  it('drops the answer when checking was turned off while it was in flight', async () => {
    const { host, release } = slowCheck();
    const scheduler = await mount({ host });
    await settle();

    writeDesktopPrefs({ autoUpdate: 'off' });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });

    expect(scheduler.current.offer).toBeNull();
  });

  it('does not auto-install under a switch the user turned off mid-check', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const install = vi.fn(async () => undefined);
    const host = {
      supportsDesktopUpdates: async () => true,
      checkDesktopUpdate: async () => { await gate; return { ...createUpdate('0.3.2'), install }; },
      readDesktopPrefs: async () => null,
      writeDesktopPrefs: async () => {},
    };
    writeDesktopPrefs({ autoUpdate: 'install' });
    const scheduler = await mount({ host });
    await settle();

    writeDesktopPrefs({ autoUpdate: 'off' });
    await act(async () => { open(); await vi.advanceTimersByTimeAsync(0); });

    expect(install).not.toHaveBeenCalled();
    expect(scheduler.current.offer).toBeNull();
  });

  it('does not put a beta answer in front of someone who moved to stable', async () => {
    const { host, release } = slowCheck();
    const scheduler = await mount({ host });
    await settle();

    writeDesktopPrefs({ updateChannel: 'beta' });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });

    // The result was found on stable and the user is on beta: the answer is
    // dropped rather than relabelled, because the feed it came from is not the
    // one the new channel points at.
    expect(scheduler.current.offer).toBeNull();
  });
});

describe('the day is measured from the last check, not from the last event', () => {
  it('does not drift later every time the window is focused', async () => {
    // A window focused every few hours must still check a day after the last
    // check, not a day after the most recent focus.
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => null),
      readDesktopPrefs: vi.fn(async () => null),
      writeDesktopPrefs: vi.fn(async () => {}),
    };
    await mount({ host });
    await settle();
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    // Focus every four hours, five times over: 20 hours, still inside the day.
    for (let hour = 4; hour <= 20; hour += 4) {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      });
    }
    // Five focus events inside the day must not have produced five more
    // checks, and the day is still not up.
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    });
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('checks when a focus lands after the day has run out', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => null),
      readDesktopPrefs: vi.fn(async () => null),
      writeDesktopPrefs: vi.fn(async () => {}),
    };
    await mount({ host });
    await settle();
    expect(host.checkDesktopUpdate).toHaveBeenCalledOnce();

    // The window is left alone for more than a day and then focused.
    await settle(UPDATE_CHECK_INTERVAL_MS + 60_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.checkDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not retry in a tight loop when a check fails', async () => {
    const host = {
      supportsDesktopUpdates: vi.fn(async () => { throw new Error('offline'); }),
      checkDesktopUpdate: vi.fn(async () => null),
      readDesktopPrefs: vi.fn(async () => null),
      writeDesktopPrefs: vi.fn(async () => {}),
    };
    await mount({ host });
    await settle();
    await settle(UPDATE_CHECK_INTERVAL_MS - 1);

    // A failure still advances the anchor, so the window does not hammer the
    // feed while it is down.
    expect(host.checkDesktopUpdate).not.toHaveBeenCalled();
  });
});

describe('a check is scoped to the channel it was made on', () => {
  it('does not hand a stable result to a beta check', async () => {
    const seen: string[] = [];
    const host = {
      supportsDesktopUpdates: vi.fn(async () => true),
      checkDesktopUpdate: vi.fn(async () => {
        seen.push(readDesktopPrefs().updateChannel);
        return createUpdate('0.4.0');
      }),
      readDesktopPrefs: vi.fn(async () => null),
      writeDesktopPrefs: vi.fn(async () => {}),
    };
    await mount({ host });
    await settle();
    expect(seen).toEqual(['stable']);

    // A second window honours the daily cadence too, then asks the newly selected feed.
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
    writeDesktopPrefs({ updateChannel: 'beta' });
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS);
    const next = await mount({ host });
    await settle();
    expect(seen).toEqual(['stable', 'beta']);
    expect(seen[0]).toBe('stable');
    expect(next.current.offer?.channel).toBe('beta');
  });
});

describe('native cadence authority counterexamples', () => {
  it('does not start a new request at startup when native checked less than a day ago', async () => {
    const native = nativeStore({ updateState: { lastCheckedAt: Date.now() - 60_000 } });
    const checkDesktopUpdate = vi.fn(async () => null);
    await mount({ host: { ...native.host, checkDesktopUpdate } });
    await settle();
    expect(checkDesktopUpdate).not.toHaveBeenCalled();
    await settle(UPDATE_CHECK_INTERVAL_MS - 60_000);
    expect(checkDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('refreshes native off on foreground, rather than using the boot snapshot', async () => {
    const native = nativeStore();
    const checkDesktopUpdate = vi.fn(async () => null);
    await mount({ host: { ...native.host, checkDesktopUpdate } });
    await settle();
    native.store.autoUpdate = 'off';
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS + 1);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkDesktopUpdate).toHaveBeenCalledOnce();
    expect(readDesktopPrefs().autoUpdate).toBe('off');
  });
});

describe('stale install selection refresh', () => {
  it('refreshes the offer after a native identity rejection without installing the replacement', async () => {
    const oldInstall = vi.fn(async () => { throw new Error('Desktop update selection changed; check for updates again'); });
    const nextInstall = vi.fn(async () => {});
    const checkDesktopUpdate = vi.fn()
      .mockResolvedValueOnce(createUpdate('0.3.2', oldInstall))
      .mockResolvedValueOnce(createUpdate('0.3.3', nextInstall));
    const scheduler = await mount({ host: { supportsDesktopUpdates: async () => true, checkDesktopUpdate } });
    await settle();
    await act(async () => { scheduler.current.onUpdate(scheduler.current.offer!); });
    expect(oldInstall).toHaveBeenCalledOnce();
    expect(checkDesktopUpdate).toHaveBeenCalledTimes(2);
    expect(scheduler.current.offer?.update.version).toBe('0.3.3');
    expect(nextInstall).not.toHaveBeenCalled();
    await act(async () => { scheduler.current.onUpdate(scheduler.current.offer!); });
    expect(nextInstall).toHaveBeenCalledOnce();
    expect(scheduler.current.offer).toBeNull();
  });
});
