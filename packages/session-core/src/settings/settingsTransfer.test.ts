// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  settingsTransferPackageSchema,
  settingsTransferPreferencesSchema,
  type SettingsTransferCatalog,
  type SettingsTransferPackage,
} from '@kiki/protocol';
import {
  applyLocalSettingsTransferPreferences,
  attachLocalSettingsTransferPreferences,
  countLocalSettingsTransferPreferences,
  parseSettingsTransferPackage,
  previewLocalSettingsTransferPreferences,
  readLocalSettingsTransferPreferences,
  withLocalSettingsTransferCatalog,
  withLocalSettingsTransferPreview,
} from './settingsTransfer';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

const emptyCatalog: SettingsTransferCatalog = {
  scope: { home: 'example-home' },
  categories: [
    { id: 'models', items: 2, added: 0, conflicts: 0, unchanged: 0, skipped: 0 },
    { id: 'appearance', items: 4, added: 0, conflicts: 0, unchanged: 0, skipped: 0 },
  ],
  notices: [],
};

const basePackage = (preferences?: SettingsTransferPackage['preferences']): SettingsTransferPackage => settingsTransferPackageSchema.parse({
  format: 'kiki.settings',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  categories: ['appearance'],
  includesCredentials: false,
  config: {},
  resources: [],
  ...(preferences === undefined ? {} : { preferences }),
  notices: [],
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
});

describe('local settings transfer projection', () => {
  it('exports only explicitly persisted appearance values, not normalized defaults', () => {
    expect(readLocalSettingsTransferPreferences()).toBeUndefined();
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'dark', sendShortcut: 'cmd-enter' }));
    localStorage.setItem('kiki.layout', JSON.stringify({ sidebarWidth: 312 }));
    localStorage.setItem('kiki.locale', 'zh');
    expect(readLocalSettingsTransferPreferences()).toEqual({
      settings: { theme: 'dark', sendShortcut: 'cmd-enter' },
      layout: { sidebarWidth: 312 },
      locale: 'zh',
    });
    expect(countLocalSettingsTransferPreferences()).toBe(4);
  });

  it('round-trips general device settings and away notification preferences', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({
      draftPersistence: false,
      foldSteps: false,
      awayNotifications: { completed: false, failed: true, question: false, approval: true },
      requestTimeoutSeconds: 120,
    }));
    expect(readLocalSettingsTransferPreferences()?.settings).toEqual({
      draftPersistence: false,
      foldSteps: false,
      awayNotifications: { completed: false, failed: true, question: false, approval: true },
      requestTimeoutSeconds: 120,
    });
    const incoming = settingsTransferPreferencesSchema.parse({
      settings: {
        draftPersistence: false,
        foldSteps: true,
        awayNotifications: { completed: true, failed: false, question: true, approval: false },
      },
    });
    const result = await applyLocalSettingsTransferPreferences(incoming, 'overwrite');
    expect(result.status).toBe('complete');
    expect(readLocalSettingsTransferPreferences()?.settings).toMatchObject(incoming.settings!);
    expect(readLocalSettingsTransferPreferences()?.settings?.requestTimeoutSeconds).toBe(120);
  });

  it('attaches local preferences only when appearance is selected', () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ motion: 'reduce' }));
    const appearance = attachLocalSettingsTransferPreferences(basePackage());
    expect(appearance.preferences).toEqual({ settings: { motion: 'reduce' } });
    const nonAppearance = settingsTransferPackageSchema.parse({ ...basePackage(), categories: ['models'] });
    expect(attachLocalSettingsTransferPreferences(nonAppearance).preferences).toBeUndefined();
  });

  it('keeps explicit target values on append and writes incoming values on overwrite', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'dark' }));
    const incoming = settingsTransferPreferencesSchema.parse({
      settings: { theme: 'light', proseFont: 'sans' },
      layout: { sidebarWidth: 340 },
      desktop: { closeToTray: false },
      locale: 'zh',
    });

    const append = await applyLocalSettingsTransferPreferences(incoming, 'append');
    expect(append.status).toBe('complete');
    expect(readLocalSettingsTransferPreferences()).toEqual({
      settings: { theme: 'dark', proseFont: 'sans' },
      layout: { sidebarWidth: 340 },
      desktop: { closeToTray: false },
      locale: 'zh',
    });

    const overwrite = await applyLocalSettingsTransferPreferences(incoming, 'overwrite');
    expect(overwrite.status).toBe('complete');
    expect(readLocalSettingsTransferPreferences()?.settings?.theme).toBe('light');
    expect(overwrite.appliedKeys).toContain('settings.theme');
  });

  it('previews local conflicts without treating defaults as existing values', () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'dark' }));
    const incoming = settingsTransferPreferencesSchema.parse({ settings: { theme: 'light', motion: 'reduce' } });
    expect(previewLocalSettingsTransferPreferences(incoming, ['appearance'], 'append')).toEqual({
      items: 2,
      added: 1,
      conflicts: 1,
      unchanged: 0,
      skipped: 1,
    });
    expect(previewLocalSettingsTransferPreferences(incoming, ['models'], 'append')).toEqual({
      items: 2,
      added: 0,
      conflicts: 0,
      unchanged: 0,
      skipped: 2,
    });
  });

  it('adds local preference counts and preview outcomes to the appearance summary', () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'dark' }));
    const catalog = withLocalSettingsTransferCatalog(emptyCatalog);
    expect(catalog.categories.find((entry) => entry.id === 'appearance')?.items).toBe(5);
    const incoming = basePackage(settingsTransferPreferencesSchema.parse({ settings: { theme: 'light', motion: 'reduce' } }));
    const preview = withLocalSettingsTransferPreview({
      scope: { home: 'example-home' },
      categories: [{ id: 'appearance', items: 2, added: 2, conflicts: 0, unchanged: 0, skipped: 0 }],
      notices: [],
      previewId: 'preview-1',
      includesCredentials: false,
      credentialsSelected: false,
      mode: 'append',
    }, incoming, ['appearance'], 'append');
    expect(preview.categories[0]).toEqual({ id: 'appearance', items: 4, added: 3, conflicts: 1, unchanged: 0, skipped: 1 });
  });

  it('reports native desktop readback failures as a partial local import', async () => {
    const incoming = settingsTransferPreferencesSchema.parse({ desktop: { notifications: false } });
    const write = vi.fn(async () => undefined);
    const result = await applyLocalSettingsTransferPreferences(incoming, 'overwrite', {
      write,
      read: async () => ({ notifications: true, closeToTray: true }),
    });
    expect(write).toHaveBeenCalledWith({ notifications: false });
    expect(result.status).toBe('partial');
    expect(result.failedKeys).toEqual(['desktop.notifications']);
  });

  it('validates packages before the GUI stores them', () => {
    expect(parseSettingsTransferPackage(basePackage())).toEqual(basePackage());
    expect(parseSettingsTransferPackage({ format: 'other' })).toBeUndefined();
  });
});
