// @vitest-environment jsdom

/**
 * Settings → Appearance: every control applies immediately (no draft), the
 * non-token choices land on <html> as data attributes, and "Restore defaults"
 * resets the whole page while keeping an undo.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSettings, writeSettings } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { readSkinPrefs, startSkinSync, writeSkinPrefs } from '../../lib/skins';
import { AppearanceSection } from './AppearanceSection';

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listSkins: vi.fn().mockResolvedValue({ items: [], directory: '/home/fixture/.kiki/themes', skipped: [] }),
      getSkin: vi.fn(),
    },
  }),
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let container: HTMLDivElement;
let root: Root;
let stopSync: () => void;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  localStorage.clear();
  writeSettings({ theme: 'system', motion: 'system', proseFont: 'serif' });
  writeSkinPrefs({ selection: { source: 'builtin', id: 'paper' }, tweaks: {} });
  stopSync = startSkinSync();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><AppearanceSection /></I18nProvider>
      </QueryClientProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  stopSync();
});

const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;

describe('AppearanceSection', () => {
  it('renders the four cards, the preview, and no draft bar', () => {
    for (const id of ['st-card-appearance', 'st-card-appearance-type', 'st-card-appearance-layout', 'st-card-skin-files']) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
    expect(container.querySelector('[data-appearance-preview] .kiki-prose')).not.toBeNull();
    expect(container.querySelector('[data-settings-draft]')).toBeNull();
    // Nothing to restore at the defaults.
    expect(container.querySelector('[data-appearance-restore]')).toBeNull();
  });

  it('applies motion and prose choices at once and mirrors them onto <html>', async () => {
    await act(async () => { button('[data-motion-choice="reduce"]').click(); });
    expect(readSettings().motion).toBe('reduce');
    expect(document.documentElement.dataset['kikiMotion']).toBe('reduce');

    await act(async () => { button('[data-prose-choice="sans"]').click(); });
    expect(readSettings().proseFont).toBe('sans');
    expect(document.documentElement.dataset['kikiProse']).toBe('sans');
  });

  it('switches skin instantly and marks the selection without an accent fill', async () => {
    await act(async () => { button('[data-skin-choice="slate"]').click(); });
    expect(readSkinPrefs().selection.id).toBe('slate');
    expect(document.documentElement.dataset['skin']).toBe('slate');
    const selected = button('[data-skin-choice="slate"]');
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(selected.className).not.toContain('accent');
  });

  it('keeps "Restore defaults" hidden while only the theme differs', async () => {
    await act(async () => { button('[data-theme-choice="dark"]').click(); });
    expect(readSettings().theme).toBe('dark');
    expect(container.querySelector('[data-appearance-restore]')).toBeNull();
    await act(async () => { button('[data-prose-choice="sans"]').click(); });
    expect(container.querySelector('[data-appearance-restore]')).not.toBeNull();
  });

  it('shows built-in skin descriptions in the UI language', () => {
    const paper = button('[data-skin-choice="paper"]').querySelector('[data-skin-description]');
    expect(paper?.textContent).toBe('Warm paper and ink with a rust accent. Kiki’s own voice.');
  });

  it('restores every customization, keeps the theme choice, and can undo it', async () => {
    await act(async () => { button('[data-theme-choice="dark"]').click(); });
    await act(async () => { button('[data-skin-choice="slate"]').click(); });
    await act(async () => { button('[data-motion-choice="full"]').click(); });

    await act(async () => { button('[data-appearance-restore]').click(); });
    expect(readSettings().theme).toBe('dark');
    expect(readSettings().motion).toBe('system');
    expect(readSkinPrefs().selection.id).toBe('paper');
    expect(container.querySelector('[data-appearance-restore]')).toBeNull();

    const undo = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    expect(readSettings().theme).toBe('dark');
    expect(readSettings().motion).toBe('full');
    expect(readSkinPrefs().selection.id).toBe('slate');
  });
});
