// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SHORTCUT_PREFERENCES,
  detectShortcutConflicts,
  resolveShortcutBindings,
  shortcutPreferencesSchema,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@kiki/session-core/settings/shortcuts';
import { ApiError } from '@kiki/session-core/transport';
import { I18nProvider } from '../../i18n';
import { matchesShortcutAction, resetShortcutRuntime } from '../../lib/shortcuts';
import { ShortcutsSection } from './ShortcutsSection';

const response = (preferences: ShortcutPreferences, platform: ShortcutPlatform) => ({
  preferences, bindings: resolveShortcutBindings(preferences, platform), conflicts: detectShortcutConflicts(preferences, platform),
});

const { client } = vi.hoisted(() => ({
  client: { readShortcuts: vi.fn(), writeShortcuts: vi.fn(), resetShortcuts: vi.fn() },
}));

vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', platform: 'Win32', userAgent: 'Windows' });
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  resetShortcutRuntime('windows');
  let saved: ShortcutPreferences = shortcutPreferencesSchema.parse(DEFAULT_SHORTCUT_PREFERENCES);
  client.readShortcuts.mockReset().mockImplementation(async (platform: ShortcutPlatform) => response(saved, platform));
  client.writeShortcuts.mockReset().mockImplementation(async (platform: ShortcutPlatform, next: ShortcutPreferences) => {
    saved = next;
    return response(saved, platform);
  });
  client.resetShortcuts.mockReset().mockImplementation(async (platform: ShortcutPlatform, target: { action?: string }) => {
    const next = structuredClone(saved);
    if (target.action !== undefined) delete (next.overrides[platform] as Record<string, unknown> | undefined)?.[target.action];
    else delete next.overrides[platform];
    saved = next;
    return response(saved, platform);
  });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  resetShortcutRuntime();
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><ShortcutsSection /></I18nProvider></QueryClientProvider>);
  });
  await flush();
  return container;
}

async function recordOn(container: HTMLElement, action: string, init: KeyboardEventInit) {
  const chord = container.querySelector<HTMLButtonElement>(`[data-shortcut-row="${action}"] [data-shortcut-chord="0"]`)!;
  await act(async () => { chord.click(); });
  const recorder = container.querySelector<HTMLButtonElement>('[data-shortcut-recording]')!;
  expect(document.activeElement).toBe(recorder);
  await act(async () => { recorder.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  await flush();
}

describe('ShortcutsSection', () => {
  it('lists every remappable action for the client platform', async () => {
    const container = await render();
    expect(client.readShortcuts).toHaveBeenCalledWith('windows');
    expect(container.querySelectorAll('[data-shortcut-row]')).toHaveLength(18);
    expect(container.querySelector('[data-shortcut-row="previous-session"]')?.textContent).toContain('Previous running thread');
    expect(container.querySelector('[data-shortcut-row="next-session"]')?.textContent).toContain('Next running thread');
    expect(container.querySelector('[data-shortcut-row="switcher"]')?.textContent).toContain('Ctrl');
  });

  it('names the clash and writes nothing when a recorded chord is taken', async () => {
    const container = await render();
    await recordOn(container, 'switcher', { key: 'f', ctrlKey: true });
    expect(container.querySelector('[data-shortcut-row="switcher"] [data-shortcut-issue]')?.textContent).toMatch(/Find/);
    expect(client.writeShortcuts).not.toHaveBeenCalled();
  });

  it('saves a free chord, applies it at runtime, and resets the row', async () => {
    const container = await render();
    await recordOn(container, 'switcher', { key: 'J', ctrlKey: true, shiftKey: true });
    expect(client.writeShortcuts).toHaveBeenCalledTimes(1);
    expect(client.writeShortcuts.mock.calls[0]![1].overrides.windows.switcher).toEqual([{ key: 'j', modifier: 'mod', shift: true, alt: false }]);
    expect(matchesShortcutAction({ key: 'J', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'switcher')).toBe(true);
    expect(container.querySelector('[data-shortcut-row="switcher"]')?.getAttribute('data-shortcut-overridden')).toBe('true');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-shortcut-row="switcher"] [data-shortcut-reset]')!.click(); });
    await flush();
    expect(client.resetShortcuts).toHaveBeenCalledWith('windows', { platform: 'windows', action: 'switcher' });
    expect(matchesShortcutAction({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'switcher')).toBe(true);
  });

  it('Esc cancels recording without a write', async () => {
    const container = await render();
    await recordOn(container, 'find', { key: 'Escape' });
    expect(container.querySelector('[data-shortcut-recording]')).toBeNull();
    expect(client.writeShortcuts).not.toHaveBeenCalled();
  });

  it('names the row the server rejected, including a clash on another platform', async () => {
    const container = await render();
    // The local check only knows this platform; the server validates every
    // platform, so its rejection carries the clash the user cannot see here.
    client.writeShortcuts.mockRejectedValueOnce(new ApiError({
      code: 40001,
      msg: 'Shortcut bindings conflict',
      data: null,
      details: { conflicts: [{ platform: 'macos', actions: ['switcher', 'find'], kind: 'duplicate', key: 'f' }] },
    }));
    await recordOn(container, 'switcher', { key: 'J', ctrlKey: true, shiftKey: true });

    const issue = container.querySelector('[data-shortcut-row="switcher"] [data-shortcut-issue]');
    expect(issue?.textContent).toMatch(/Find/);
    expect(issue?.textContent).toContain('f');
    // The raw envelope message never reaches the user, and nothing was applied.
    expect(container.textContent).not.toContain('Shortcut bindings conflict');
    expect(container.querySelector('[data-shortcut-row="switcher"]')?.getAttribute('data-shortcut-overridden')).toBe('false');
    expect(matchesShortcutAction({ key: 'J', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, 'switcher')).toBe(false);
  });
});
