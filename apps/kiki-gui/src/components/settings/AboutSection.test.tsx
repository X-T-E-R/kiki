// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopPrefs } from '@kiki/session-core/settings';
import { I18nProvider } from '../../i18n';
import { resetUpdateCheckCache } from '../../lib/desktopUpdates';
import { AboutSection } from './AboutSection';
import { pickOption, selectText } from './testControls';

const { checkDesktopUpdate, supportsDesktopUpdates, writeDesktopPrefs, readNativePrefs } = vi.hoisted(() => ({
  checkDesktopUpdate: vi.fn(),
  supportsDesktopUpdates: vi.fn(),
  writeDesktopPrefs: vi.fn(),
  readNativePrefs: vi.fn(),
}));

vi.mock('../../host', () => ({
  useHost: () => ({
    kind: 'tauri',
    checkDesktopUpdate,
    supportsDesktopUpdates,
    writeDesktopPrefs,
    readDesktopPrefs: readNativePrefs,
  }),
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    meta: {
      server_version: '1.0.0',
      server_id: 'example-server',
      backend: 'v2',
    },
  }),
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  resetUpdateCheckCache();
  checkDesktopUpdate.mockReset().mockResolvedValue(null);
  supportsDesktopUpdates.mockReset().mockResolvedValue(true);
  writeDesktopPrefs.mockReset().mockResolvedValue(undefined);
  readNativePrefs.mockReset().mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSection(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AboutSection />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe('AboutSection desktop updates', () => {
  /** The auto-check switch, and the select that only exists while it is on. */
  const autoCheckSwitch = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const whenFoundSelect = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[aria-label="When an update is found"]');

  it('checks automatically by default and offers the one question that follows', async () => {
    const container = await renderSection();
    const toggle = autoCheckSwitch(container)!;

    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(whenFoundSelect(container)).not.toBeNull();
    expect(selectText(whenFoundSelect(container)!)).toBe('Notify me');
  });

  it('persists the choice about what happens when an update is found', async () => {
    const container = await renderSection();
    await pickOption(whenFoundSelect(container)!, 'Download and install');

    expect(JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}')).toMatchObject({
      autoUpdate: 'install',
    });
    expect(writeDesktopPrefs).toHaveBeenCalledWith({ autoUpdate: 'install' });
  });

  it('hides that question when automatic checking is off, and says what still happens', async () => {
    const container = await renderSection();
    await act(async () => { autoCheckSwitch(container)!.click(); });

    expect(autoCheckSwitch(container)!.checked).toBe(false);
    expect(whenFoundSelect(container)).toBeNull();
    expect(container.textContent).toContain('Kiki only checks when you press Check for updates.');
    expect(JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}')).toMatchObject({
      autoUpdate: 'off',
    });
    expect(writeDesktopPrefs).toHaveBeenCalledWith({ autoUpdate: 'off' });
  });

  it('keeps a check on even after the switch was turned off and on again', async () => {
    const container = await renderSection();
    const toggle = autoCheckSwitch(container)!;
    await act(async () => { toggle.click(); });
    await act(async () => { autoCheckSwitch(container)!.click(); });

    // Back on means notify, not the install the user had picked earlier.
    expect(JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}')).toMatchObject({
      autoUpdate: 'notify',
    });
    expect(selectText(whenFoundSelect(container)!)).toBe('Notify me');
  });

  it('reports an already-off preference without a second switch to read', async () => {
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ autoUpdate: 'off' }));
    const container = await renderSection();
    expect(autoCheckSwitch(container)!.checked).toBe(false);
    expect(whenFoundSelect(container)).toBeNull();
  });

  it('says a failed check is a failed check, not that the app is current', async () => {
    checkDesktopUpdate.mockRejectedValue(new Error('offline'));
    const container = await renderSection();
    const checkButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check for updates',
    )!;
    await act(async () => { checkButton.click(); });

    expect(container.querySelector('[data-feedback-tone="error"]')?.textContent)
      .toContain('could not check for updates');
  });

  it('disables update controls and shows a friendly message for unsupported builds', async () => {
    supportsDesktopUpdates.mockResolvedValue(false);
    const container = await renderSection();
    const selects = [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')];
    const checkButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check for updates',
    );

    expect(selects).toHaveLength(1);
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(autoCheckSwitch(container)!.disabled).toBe(true);
    expect(checkButton).toBeDefined();
    expect(checkButton!.disabled).toBe(true);
    expect(container.textContent).toContain('Automatic updates are not configured for this build.');
    expect(checkDesktopUpdate).not.toHaveBeenCalled();
  });
});

describe('AboutSection when the native side refuses a write', () => {
  it('puts the switch back and says so, so the control shows what is really in effect', async () => {
    writeDesktopPrefs.mockRejectedValue(new Error('native write refused'));
    const container = await renderSection();
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);

    await act(async () => { toggle.click(); });

    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[data-feedback-tone="error"]')?.textContent)
      .toContain('could not save that choice');
    // The stored value has to match the control. A mirror left on the refused
    // value would keep the scheduler checking under a switch the user turned
    // off, and the next read would disagree with the screen.
    expect(readDesktopPrefs().autoUpdate).toBe('notify');
  });

  it('restores the channel too, so the next check does not read a value nothing applied', async () => {
    writeDesktopPrefs.mockRejectedValue(new Error('native write refused'));
    const container = await renderSection();
    const channel = container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!;

    await pickOption(channel, 'Beta');

    expect(readDesktopPrefs().updateChannel).toBe('stable');
    expect(selectText(channel)).toBe('Stable');
    expect(container.querySelector('[data-feedback-tone="error"]')?.textContent)
      .toContain('could not save that choice');
  });

  it('keeps a new value once the native side takes the write', async () => {
    const container = await renderSection();
    const channel = container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!;

    await pickOption(channel, 'Beta');

    expect(readDesktopPrefs().updateChannel).toBe('beta');
    expect(writeDesktopPrefs).toHaveBeenCalledWith({ updateChannel: 'beta' });
  });

  it('leaves a rejected write to the user as a normal failure, not a crash', async () => {
    writeDesktopPrefs.mockRejectedValue(new Error('native write refused'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const container = await renderSection();
      await act(async () => {
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('AboutSection asynchronous preference boundaries', () => {
  it('drops an old check result after channel selection changes', async () => {
    let release!: (value: unknown) => void;
    checkDesktopUpdate.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const container = await renderSection();
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Check for updates')!.click(); });
    await pickOption(container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!, 'Beta');
    await act(async () => { release({ currentVersion: '0.3.1', version: '0.3.2', install: vi.fn() }); });
    expect(container.textContent).not.toContain('Install 0.3.2');
    expect(readDesktopPrefs().updateChannel).toBe('beta');
  });

  it('does not let an older failure revert the later choice or its mirror', async () => {
    let reject!: (reason: Error) => void;
    let nativeChannel = 'stable';
    writeDesktopPrefs.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockImplementation(async (patch: { updateChannel?: string }) => { if (patch.updateChannel !== undefined) nativeChannel = patch.updateChannel; });
    const container = await renderSection();
    const channel = container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!;
    await pickOption(channel, 'Beta');
    await pickOption(channel, 'Stable');
    await pickOption(channel, 'Beta');
    expect(writeDesktopPrefs).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('older save failed')); });
    expect(nativeChannel).toBe('beta');
    expect(readDesktopPrefs().updateChannel).toBe('beta');
    expect(selectText(channel)).toBe('Beta');
  });
});

describe('AboutSection native write ordering', () => {
  it('checks the selected feed before a slow preference write has landed', async () => {
    let saved!: () => void;
    writeDesktopPrefs.mockImplementationOnce(() => new Promise<void>((resolve) => { saved = resolve; }));
    checkDesktopUpdate.mockImplementation(async (channel: string) => ({ currentVersion: '0.3.1', version: channel === 'beta' ? '0.4.0-beta.1' : '0.3.2', install: vi.fn() }));
    const container = await renderSection();
    await pickOption(container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!, 'Beta');
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Check for updates')!.click(); });
    expect(checkDesktopUpdate).toHaveBeenCalledWith('beta');
    expect(container.textContent).toContain('Install 0.4.0-beta.1');
    await act(async () => { saved(); });
    expect(readDesktopPrefs().updateChannel).toBe('beta');
  });

  it('restores the last confirmed value when both queued choices fail', async () => {
    let reject!: (reason: Error) => void;
    writeDesktopPrefs.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockRejectedValueOnce(new Error('second failed'));
    const container = await renderSection();
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { toggle.click(); });
    await act(async () => { toggle.click(); });
    // notify -> off -> notify. Neither save can confirm a value other than initial notify.
    await act(async () => { reject(new Error('first failed')); });
    expect(readDesktopPrefs().autoUpdate).toBe('notify');
    expect(toggle.checked).toBe(true);
    expect(writeDesktopPrefs.mock.calls.slice(0, 2)).toEqual([[{ autoUpdate: 'off' }], [{ autoUpdate: 'notify' }]]);
  });
});

describe('AboutSection stale selection recovery', () => {
  it('clears a rejected handle and lets the existing check button discover the new version immediately', async () => {
    const oldInstall = vi.fn(async () => { throw new Error('Desktop update selection changed; check for updates again'); });
    const newInstall = vi.fn(async () => {});
    checkDesktopUpdate.mockResolvedValueOnce({ currentVersion: '0.3.1', version: '0.3.2', install: oldInstall })
      .mockResolvedValueOnce({ currentVersion: '0.3.1', version: '0.3.3', install: newInstall });
    const container = await renderSection();
    const check = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Check for updates')!;
    await act(async () => { check().click(); });
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Install 0.3.2')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="alertdialog"] [data-confirm-action="confirm"]')!.click(); });
    expect(oldInstall).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Install 0.3.2');
    await act(async () => { check().click(); });
    expect(checkDesktopUpdate).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Install 0.3.3');
    expect(newInstall).not.toHaveBeenCalled();
  });
});

describe('the auto-check hint says what the chosen mode actually does', () => {
  it('makes no per-install promise while checking is off', async () => {
    const container = await renderSection();
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });

    expect(container.textContent).toContain('Kiki only checks when you press Check for updates.');
  });

  it('claims nothing about being asked before install mode applies an update', async () => {
    const container = await renderSection();
    await pickOption(container.querySelector<HTMLButtonElement>('button[aria-label="When an update is found"]')!, 'Download and install');

    // "Download and install" never opens the dialog, so a hint promising a
    // question before every install is false in this mode. The sentence names
    // what the mode does instead.
    expect(container.textContent).toContain('it applies the update by itself');
    expect(container.textContent).not.toContain('asks before anything is installed');
  });

  it('leaves the plain hint for notify mode', async () => {
    const container = await renderSection();
    expect(container.textContent).toContain('Kiki looks for a new version once a day.');
    expect(container.textContent).not.toContain('it applies the update by itself');
  });
});

describe('AboutSection native channel drift recovery', () => {
  it('refreshes the persistent channel before the next manual check, rather than looping on the rejected feed', async () => {
    const oldInstall = vi.fn(async () => { throw new Error('Desktop update selection changed; check for updates again'); });
    const betaInstall = vi.fn(async () => {});
    checkDesktopUpdate.mockResolvedValueOnce({ currentVersion: '0.3.1', version: '0.3.2', install: oldInstall })
      .mockResolvedValueOnce({ currentVersion: '0.3.1', version: '0.4.0-beta.1', install: betaInstall });
    const container = await renderSection();
    const check = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Check for updates')!;
    await act(async () => { check().click(); });
    readNativePrefs.mockImplementation(async () => ({ ...readDesktopPrefs(), updateChannel: 'beta' }));
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Install 0.3.2')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="alertdialog"] [data-confirm-action="confirm"]')!.click(); });
    expect(oldInstall).toHaveBeenCalledOnce();
    expect(readDesktopPrefs().updateChannel).toBe('beta');
    expect(selectText(container.querySelector<HTMLButtonElement>('button[aria-label="Update channel"]')!)).toBe('Beta');
    await act(async () => { check().click(); });
    expect(checkDesktopUpdate).toHaveBeenLastCalledWith('beta');
    expect(container.textContent).toContain('Install 0.4.0-beta.1');
    expect(betaInstall).not.toHaveBeenCalled();
  });
});
