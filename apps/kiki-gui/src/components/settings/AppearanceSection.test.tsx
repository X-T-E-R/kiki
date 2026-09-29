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

import { translate } from '@kiki/session-core/i18n';
import { readSettings, writeSettings } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import {
  readSkinPrefs,
  resetBackgroundPrefsCache,
  startSkinSync,
  writeBackgroundPrefs,
  writeSkinPrefs,
} from '../../lib/skins';
import { AppearanceSection } from './AppearanceSection';

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    config: { url: 'http://127.0.0.1:1', token: 'test-token' },
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

const PACKS = {
  items: [{ id: 'dusk-harbor', name: 'Dusk Harbor', variants: ['light', 'dark'], hasSkin: true, hasVideo: false, bytes: 2048 }],
  directory: '/home/fixture/.kiki/themes',
  skipped: [],
};
const PACK = {
  kind: 'kiki-appearance-pack',
  version: 1,
  id: 'dusk-harbor',
  name: 'Dusk Harbor',
  variants: {
    light: { colors: { accent: '#9a3f1c' }, background: { media: ['day.webp'], opacity: 0.8, scope: 'main' } },
  },
};

beforeEach(async () => {
  localStorage.clear();
  resetBackgroundPrefsCache();
  writeBackgroundPrefs({ light: null, dark: null, linked: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.endsWith('/appearance/packs') ? PACKS : url.endsWith('/appearance/packs/dusk-harbor') ? { pack: PACK, bytes: 2048 } : null;
    return new Response(JSON.stringify(body === null ? { code: 40409, msg: 'not found', data: null } : { code: 0, msg: 'ok', data: body }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
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
  it('renders every card, the preview, and no draft bar', () => {
    for (const id of ['st-card-appearance', 'st-card-appearance-background', 'st-card-appearance-type', 'st-card-appearance-layout', 'st-card-appearance-packs', 'st-card-skin-files']) {
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
    await act(async () => { button('[data-skin-choice="graphite"]').click(); });
    expect(readSkinPrefs().selection.id).toBe('graphite');
    expect(document.documentElement.dataset['skin']).toBe('graphite');
    const selected = button('[data-skin-choice="graphite"]');
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
    expect(paper?.textContent).toBe(translate('en', 'st.skin.desc.paper'));
  });

  it('restores every customization, keeps the theme choice, and can undo it', async () => {
    await act(async () => { button('[data-theme-choice="dark"]').click(); });
    await act(async () => { button('[data-skin-choice="graphite"]').click(); });
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
    expect(readSkinPrefs().selection.id).toBe('graphite');
  });

  it('lists pack colors in the skin picker and applies a pack as colors plus background', async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const packSkin = button('[data-skin-choice="dusk-harbor"]');
    expect(packSkin.textContent).toContain('From an appearance pack');
    await act(async () => { button('[data-pack-use="dusk-harbor"]').click(); });
    expect(readSkinPrefs().selection).toEqual({ source: 'pack', id: 'dusk-harbor' });
    expect(document.documentElement.dataset['kikiBg']).toBe('main');
    expect(button('[data-pack-use="dusk-harbor"]').getAttribute('aria-pressed')).toBe('true');
    // The background half is an ordinary edit afterwards, and Restore drops it.
    await act(async () => { button('[data-appearance-restore]').click(); });
    expect(document.documentElement.dataset['kikiBg']).toBeUndefined();
  });
});
