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

/** Open a font role's picker and pick one of its rows. */
async function pickFont(role: string, value: string) {
  await act(async () => { button(`[data-font-role="${role}"] [aria-haspopup="listbox"]`).click(); });
  await act(async () => { button(`[data-font-role="${role}"] [data-option-value="${value}"]`).click(); });
}

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

    await pickFont('prose', 'sans');
    expect(readSettings().proseFont).toBe('sans');
    expect(document.documentElement.dataset['kikiProse']).toBe('sans');
  });

  it('switches skin instantly and marks the selection without an accent fill', async () => {
    await act(async () => { button('[data-skin-choice="porcelain"]').click(); });
    expect(readSkinPrefs().selection.id).toBe('porcelain');
    expect(document.documentElement.dataset['skin']).toBe('porcelain');
    const selected = button('[data-skin-choice="porcelain"]');
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(selected.className).not.toContain('accent');
  });

  it('keeps "Restore defaults" hidden while only the theme differs', async () => {
    await act(async () => { button('[data-theme-choice="dark"]').click(); });
    expect(readSettings().theme).toBe('dark');
    expect(container.querySelector('[data-appearance-restore]')).toBeNull();
    await pickFont('prose', 'sans');
    expect(container.querySelector('[data-appearance-restore]')).not.toBeNull();
  });

  it('shows exactly six built-in families with localized pair names and descriptions', () => {
    const families = ['paper', 'porcelain', 'celadon', 'apricot', 'iris', 'contrast'];
    const choices = [...container.querySelectorAll<HTMLElement>('[data-skin-choice]')].map((node) => node.dataset['skinChoice']);
    expect(choices.filter((id) => families.includes(id!))).toEqual(families);
    for (const id of ['linen', 'graphite', 'forest', 'claret', 'heather', 'nocturne', 'sand', 'slate']) {
      expect(choices).not.toContain(id);
    }
    const paper = button('[data-skin-choice="paper"]');
    expect(paper.textContent).toContain(translate('en', 'st.skin.name.paper'));
    expect(paper.querySelector('[data-skin-description]')?.textContent).toBe(translate('en', 'st.skin.desc.paperPair'));
  });

  it('restores every customization, keeps the theme choice, and can undo it', async () => {
    await act(async () => { button('[data-theme-choice="dark"]').click(); });
    await act(async () => { button('[data-skin-choice="porcelain"]').click(); });
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
    expect(readSkinPrefs().selection.id).toBe('porcelain');
  });

  it('takes a typed family for each role, applies it as you type, and leaves it for a preset', async () => {
    for (const role of ['sans', 'prose', 'mono']) {
      await pickFont(role, '__custom');
      const input = container.querySelector<HTMLInputElement>(`[data-font-role="${role}"] [data-font-custom] input`)!;
      expect(input).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'Fixture Face');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    const tweaks = readSkinPrefs().tweaks;
    expect(tweaks.fontSans?.startsWith("'Fixture Face', ")).toBe(true);
    expect(tweaks.fontProse?.startsWith("'Fixture Face', ")).toBe(true);
    expect(tweaks.fontMono?.startsWith("'Fixture Face', ")).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('Fixture Face');
    expect(document.documentElement.style.getPropertyValue('--kiki-prose-user')).toContain('Fixture Face');
    // The sample line previews the typed face.
    expect(container.querySelector<HTMLElement>('[data-font-role="sans"] [data-font-sample]')?.style.fontFamily).toContain('Fixture Face');
    // A preset takes over and drops the typed family.
    await pickFont('prose', 'serif');
    expect(readSkinPrefs().tweaks.fontProse).toBeUndefined();
    expect(container.querySelector('[data-font-role="prose"] [data-font-custom]')).toBeNull();
    // Restore defaults clears the rest and closes their fields.
    await act(async () => { button('[data-appearance-restore]').click(); });
    expect(readSkinPrefs().tweaks).toEqual({});
    expect(container.querySelector('[data-font-custom]')).toBeNull();
  });

  it('keeps font IME preedit raw and applies the cleaned committed family only at compositionend', async () => {
    await pickFont('sans', '__custom');
    const input = container.querySelector<HTMLInputElement>('[data-font-role="sans"] [data-font-custom] input')!;
    await act(async () => {
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  ni; Face');
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    expect(input.value).toBe('  ni; Face');
    expect(input.selectionStart).toBe(4);
    expect(readSkinPrefs().tweaks.fontSans).toBeUndefined();
    // An unrelated settings update must not restore the previous font prop.
    await act(async () => { writeSettings({ motion: 'reduce' }); });
    expect(input.value).toBe('  ni; Face');
    expect(input.selectionStart).toBe(4);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  中文; Face');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    });
    expect(input.value).toBe('中文 Face');
    expect(readSkinPrefs().tweaks.fontSans).toContain('中文 Face');
  });

  it('opens a settings dropdown toward the page, not past its right edge', async () => {
    const trigger = button('[data-font-role="sans"] [aria-haspopup="listbox"]');
    // A row control at the right edge of a 1024px viewport.
    trigger.getBoundingClientRect = () => ({ left: 880, right: 1000, top: 200, bottom: 232, width: 120, height: 32, x: 880, y: 200, toJSON: () => ({}) });
    await act(async () => { trigger.click(); });
    const panel = container.querySelector('[data-font-role="sans"] [role="listbox"]')!.parentElement!;
    // Viewport-fixed, hung from the trigger's right edge, never past the viewport.
    expect(panel.className).toContain('fixed');
    const left = Number.parseFloat(panel.style.left);
    const width = Number.parseFloat(panel.style.width);
    expect(left + width).toBeLessThanOrEqual(1000);
    expect(left + width).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(panel.style.top).toBe('236px');
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
