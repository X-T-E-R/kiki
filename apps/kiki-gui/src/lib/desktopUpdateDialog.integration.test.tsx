// @vitest-environment jsdom

/**
 * The update dialog as a user meets it: the real component, the real scheduler
 * hook and a fake host, driven by clicking the actual buttons. The hook-only
 * tests cover what the scheduler decides; this file covers what happens between
 * that decision and the screen, which is where the buttons, the disabled state
 * and the persisted record either meet or do not.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopPrefs, type DesktopNativePrefs } from '@kiki/session-core/settings';
import { UpdateAvailableDialog } from '../components/UpdateAvailableDialog';
import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from './toasts';
import { resetUpdateCheckCache, UPDATE_STARTUP_DELAY_MS } from './desktopUpdates';
import { useDesktopUpdateScheduler, type DesktopUpdateScheduler } from './useDesktopUpdateScheduler';
import type { DesktopUpdate } from '../host';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

interface FakeHost {
  readonly host: {
    supportsDesktopUpdates: () => Promise<boolean>;
    checkDesktopUpdate: () => Promise<DesktopUpdate | null>;
    readDesktopPrefs: () => Promise<DesktopNativePrefs | null>;
    writeDesktopPrefs: (prefs: Partial<DesktopNativePrefs>) => Promise<void>;
  };
  readonly store: Partial<DesktopNativePrefs>;
  /** Flip to make every native write fail the way a refused call does. */
  rejectWrites: boolean;
  readonly installs: { version: string; install: ReturnType<typeof vi.fn> }[];
  /** Make the next N installs fail, so a retry can be shown succeeding. */
  failInstalls: number;
}

/** A native stand-in whose writes can be refused, plus a recorded install log. */
function fakeHost(version = '0.3.2', initial: Partial<DesktopNativePrefs> = {}): FakeHost {
  const store: Partial<DesktopNativePrefs> = { autoUpdate: 'notify', updateChannel: 'stable', ...initial };
  const fake: FakeHost = {
    store,
    rejectWrites: false,
    installs: [],
    failInstalls: 0,
    host: {
      supportsDesktopUpdates: async () => true,
      checkDesktopUpdate: async () => ({
        currentVersion: '0.3.1',
        version,
        notes: 'Session switching is faster.',
        install: vi.fn(async () => {
          if (fake.failInstalls > 0) {
            fake.failInstalls -= 1;
            throw new Error('user cancelled the shutdown');
          }
        }),
      }),
      readDesktopPrefs: async () => store as DesktopNativePrefs,
      writeDesktopPrefs: async (prefs) => {
        if (fake.rejectWrites) throw new Error('native write refused');
        Object.assign(store, prefs);
      },
    },
  };
  return fake;
}

/** The real hook and the real dialog, in the arrangement the app uses. */
function Harness({ fake, onScheduler }: { fake: FakeHost; onScheduler: (s: DesktopUpdateScheduler) => void }) {
  const scheduler = useDesktopUpdateScheduler({ host: fake.host, isDesktop: true });
  onScheduler(scheduler);
  return (
    <UpdateAvailableDialog
      offer={scheduler.offer}
      onUpdate={scheduler.onUpdate}
      onRemindLater={scheduler.onRemindLater}
      onSkip={scheduler.onSkip}
      onDismiss={scheduler.onDismiss}
      installing={scheduler.installing}
      installError={scheduler.installError}
      persistError={scheduler.persistError}
    />
  );
}

async function mount(fake: FakeHost): Promise<{ current: DesktopUpdateScheduler }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const handle = { current: undefined as unknown as DesktopUpdateScheduler };
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness fake={fake} onScheduler={(scheduler) => { handle.current = scheduler; }} />
      </I18nProvider>,
    );
  });
  return handle;
}

/** Let the startup check run and the dialog mount. */
async function openDialog(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS); });
}

/** The button whose visible label is exactly `text`. */
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent?.trim() === label);
  if (found === undefined) {
    const seen = [...document.querySelectorAll('button')].map((element) => element.textContent?.trim());
    throw new Error(`no button "${label}"; saw ${JSON.stringify(seen)}`);
  }
  return found;
}

/** Click through `act`, so the async write the click starts can settle. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetUpdateCheckCache();
  clearToasts();
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  vi.useRealTimers();
});
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

describe('updating from the dialog', () => {
  it('leaves the buttons usable after a failed install, and the same button retries', async () => {
    const fake = fakeHost();
    fake.failInstalls = 1;
    await mount(fake);
    await openDialog();

    await click(button('Update now'));

    // The failure is on screen and the dialog has not closed.
    expect(dialogText()).toContain('did not complete');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // Every control is back, including the close button and the two ways out.
    const retry = button('Try updating again');
    expect(retry.disabled).toBe(false);
    expect(button('Remind me tomorrow').disabled).toBe(false);
    expect(button('Skip this version').disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.disabled).toBe(false);

    await click(retry);

    // The second attempt goes through, the dialog closes, and Kiki says what
    // is left to do.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(getToasts().map((toast) => toast.text))
      .toContain('The update is installed. Restart Kiki to finish updating.');
  });

  it('does not start a second install from a double click', async () => {
    const fake = fakeHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const install = vi.fn(() => gate);
    const original = fake.host.checkDesktopUpdate;
    fake.host.checkDesktopUpdate = async () => {
      const update = await original();
      return { ...update!, install };
    };
    await mount(fake);
    await openDialog();

    const primary = button('Update now');
    await act(async () => {
      primary.click();
      primary.click();
      primary.click();
    });
    expect(primary.disabled).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    await act(async () => { release(); await Promise.resolve(); });
  });
});

describe('skipping from the dialog', () => {
  it('stores the skip and says so only once it is stored', async () => {
    const fake = fakeHost();
    await mount(fake);
    await openDialog();

    await click(button('Skip this version'));

    expect(fake.store.updateState?.skipped).toEqual({ stable: ['0.3.2'], beta: null });
    expect(getToasts().map((toast) => toast.text))
      .toContain('Kiki will not ask about 0.3.2 again. Newer versions still come.');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the dialog open and the reason visible when the skip cannot be stored', async () => {
    const fake = fakeHost();
    fake.rejectWrites = true;
    await mount(fake);
    await openDialog();

    await click(button('Skip this version'));

    // The promise "Kiki will not ask again" is not something to say about a
    // record that was not kept, so the dialog stays and explains.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dialogText()).toContain('did not save that choice');
    expect(getToasts().map((toast) => toast.text)).toEqual([]);

    // The same button is still there to press once the native side takes writes.
    fake.rejectWrites = false;
    await click(button('Skip this version'));
    expect(fake.store.updateState?.skipped).toEqual({ stable: ['0.3.2'], beta: null });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('snoozes for a day when the write lands', async () => {
    const fake = fakeHost();
    await mount(fake);
    await openDialog();

    await click(button('Remind me tomorrow'));

    expect(fake.store.updateState?.snoozedUntil).toBeGreaterThan(0);
    expect(readDesktopPrefs().updateState?.snoozedUntil).toBe(fake.store.updateState?.snoozedUntil);
  });

  it('leaves the dialog up when the snooze cannot be stored', async () => {
    const fake = fakeHost();
    fake.rejectWrites = true;
    await mount(fake);
    await openDialog();

    await click(button('Remind me tomorrow'));

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dialogText()).toContain('did not save that choice');
  });
});

describe('closing the dialog', () => {
  it('stores nothing, so a restart may ask again', async () => {
    const fake = fakeHost();
    await mount(fake);
    await openDialog();

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(getToasts()).toEqual([]);
    // The cadence anchor is a separate fact and is expected; nothing about the
    // version was recorded.
    const stored = fake.store.updateState;
    expect(stored?.skipped).toEqual({ stable: null, beta: null });
    expect(stored?.snoozedUntil ?? null).toBeNull();
  });
});

describe('the two channels do not share an answer', () => {
  it('asks the beta feed after a move, rather than reusing the stable result', async () => {
    const asked: string[] = [];
    const fake = fakeHost('0.3.2', { updateChannel: 'beta' });
    const original = fake.host.checkDesktopUpdate;
    fake.host.checkDesktopUpdate = async () => {
      asked.push(fake.store.updateChannel ?? 'stable');
      return original();
    };
    await mount(fake);
    await openDialog();

    // The beta check found nothing on this feed; the offer that appeared was
    // for the version the beta feed reported.
    expect(asked).toEqual(['beta']);
    expect(dialogText()).toContain('0.3.2');
    // Nothing was skipped: the offer came from a real check on this channel.
    expect(fake.store.updateState?.skipped).toEqual({ stable: null, beta: null });
  });
});

describe('the dialog says only what it can prove', () => {
  it('does not promise a restart it has no command for', async () => {
    await mount(fakeHost());
    await openDialog();

    // The consequence this code path performs: the native confirm closes the
    // running tasks, and the app does not come back by itself from here.
    expect(dialogText()).toContain('closes its running tasks');
    expect(dialogText()).toContain('installs the update');
    // No restart promise in either direction: the sentence does not claim Kiki
    // comes back, and it does not claim it stays away.
    expect(dialogText()).not.toContain('starts again');
    expect(dialogText()).not.toContain('start it again');
  });

  it('does not promise the running tasks survived a failed install', async () => {
    const fake = fakeHost();
    fake.failInstalls = 1;
    await mount(fake);
    await openDialog();
    await click(button('Update now'));

    // The bridge closes the tasks before it downloads, so a failure past that
    // point can leave them closed. The sentence claims neither way.
    expect(dialogText()).toContain('did not complete');
    expect(dialogText()).not.toContain('untouched');
  });

  it('announces a refused save instead of printing it as a footnote', async () => {
    const fake = fakeHost();
    fake.rejectWrites = true;
    await mount(fake);
    await openDialog();
    await click(button('Skip this version'));

    // A live region, not a quiet line: the reader who cannot see the colour
    // still learns that the press did not take.
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('did not save that choice');
    // And the sentence does not name a cause this local write does not have.
    expect(dialogText()).not.toContain('connection');
  });

  it('keeps the primary identifiable while the install runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeHost();
    const original = fake.host.checkDesktopUpdate;
    fake.host.checkDesktopUpdate = async () => {
      const update = await original();
      return { ...update!, install: vi.fn(() => gate) };
    };
    await mount(fake);
    await openDialog();
    await click(button('Update now'));

    const primary = document.querySelector<HTMLButtonElement>('button[data-confirm-action="confirm"]')!;
    expect(primary.disabled).toBe(true);
    expect(primary.dataset['busy']).toBe('true');
    // Still the accent: the waiting is visible without hunting for it.
    // The shared class greys any disabled button, so the busy state has to
    // re-assert the accent after it. Asserting the override is present, not
    // that the base class is gone: this is a normal, bounded restyle.
    expect(primary.className).toContain('data-[busy=true]:disabled:bg-accent');
    expect(primary.className).toContain('bg-accent');
    await act(async () => { release(); await Promise.resolve(); });
  });
});

describe('synchronous choice guard', () => {
  it('starts only one save when skip and later are pressed before a React update', async () => {
    const fake = fakeHost();
    await mount(fake);
    await openDialog();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fake.host.writeDesktopPrefs;
    const save = vi.fn(async (prefs: Partial<DesktopNativePrefs>) => { await gate; await original(prefs); });
    fake.host.writeDesktopPrefs = save;
    const skip = button('Skip this version');
    const later = button('Remind me tomorrow');
    await act(async () => { skip.click(); later.click(); skip.click(); });
    expect(save).toHaveBeenCalledOnce();
    expect(skip.disabled).toBe(true);
    expect(later.disabled).toBe(true);
    await act(async () => { release(); });
    expect(fake.store.updateState?.skipped?.stable).toEqual(['0.3.2']);
    expect(fake.store.updateState?.snoozedUntil ?? null).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
