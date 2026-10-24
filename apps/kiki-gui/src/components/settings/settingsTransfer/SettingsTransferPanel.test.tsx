// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsTransferPackageSchema, settingsTransferPreferencesSchema } from '@kiki/protocol';
import { translate } from '@kiki/session-core/i18n';
import { I18nProvider } from '../../../i18n';
import { SettingsTransferPanel } from './SettingsTransferPanel';

const fixture = vi.hoisted(() => ({
  api: {
    catalog: vi.fn(),
    export: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
  },
  host: {
    kind: 'browser' as const,
    openSaveSink: vi.fn(),
    saveBlob: undefined,
  },
  onClose: vi.fn(),
}));

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({ klient: { global: { settingsTransfer: fixture.api } } }),
}));
vi.mock('../../../host', () => ({ useHost: () => fixture.host }));

const categories = ['models', 'agents', 'permissions', 'tools', 'browser', 'notifications', 'appearance'] as const;
const catalog = {
  scope: { home: 'example-home', spaceId: 'space-a' },
  categories: categories.map((id) => ({ id, items: id === 'appearance' ? 2 : 1, added: 0, conflicts: 0, unchanged: 0, skipped: 0 })),
  notices: ['localScope'],
};
const packageWithAppearance = settingsTransferPackageSchema.parse({
  format: 'kiki.settings',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  categories: ['appearance'],
  includesCredentials: true,
  config: {},
  resources: [],
  preferences: settingsTransferPreferencesSchema.parse({ settings: { theme: 'dark' }, layout: { sidebarWidth: 320 } }),
  notices: ['omittedCredentials'],
});
const packageWithoutPreferences = settingsTransferPackageSchema.parse({ ...packageWithAppearance, preferences: undefined });
const packageModelsWithPreferences = settingsTransferPackageSchema.parse({ ...packageWithAppearance, categories: ['models'] });
const sink = {
  streaming: false,
  write: vi.fn(async () => undefined),
  close: vi.fn(async () => true),
  abort: vi.fn(async () => undefined),
};

let container: HTMLDivElement;
let root: Root;
const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  runtime.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  fixture.api.catalog.mockReset().mockResolvedValue(catalog);
  fixture.api.export.mockReset().mockResolvedValue(packageWithAppearance);
  fixture.api.preview.mockReset().mockResolvedValue({
    scope: catalog.scope,
    categories: [{ id: 'appearance', items: 2, added: 2, conflicts: 0, unchanged: 0, skipped: 0 }],
    notices: ['omittedCredentials'],
    previewId: 'preview-1',
    includesCredentials: true,
    credentialsSelected: false,
    mode: 'append',
  });
  fixture.api.apply.mockReset().mockResolvedValue({
    status: 'complete',
    scope: catalog.scope,
    items: [{ category: 'appearance', key: 'spaceUi.theme', status: 'applied' }],
    timing: 'settingsReloaded',
  });
  fixture.api.cancel.mockReset().mockResolvedValue(undefined);
  fixture.onClose.mockReset();
  fixture.host.openSaveSink.mockReset().mockResolvedValue(sink);
  sink.write.mockClear();
  sink.close.mockClear();
  sink.abort.mockClear();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
afterAll(() => {
  runtime.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderPanel() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><SettingsTransferPanel categories={categories} onClose={fixture.onClose} /></I18nProvider>); });
  await settle();
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(selector: string) {
  await act(async () => { document.querySelector<HTMLElement>(selector)?.click(); });
  await settle();
}

async function selectFile(value: unknown) {
  const file = new File([JSON.stringify(value)], 'settings.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { configurable: true, value: vi.fn(async () => JSON.stringify(value)) });
  const input = document.querySelector<HTMLInputElement>('[data-settings-transfer-file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('SettingsTransferPanel', () => {
  it('exports the selected categories through the host save sink without credentials by default', async () => {
    await renderPanel();
    await click('[data-settings-transfer-export]');
    expect(fixture.api.export).toHaveBeenCalledWith({ categories: [...categories], includeCredentials: false });
    expect(fixture.host.openSaveSink).toHaveBeenCalledWith(expect.stringMatching(/^kiki-settings-.*\.json$/));
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('keeps credentials off by default and supports clear/select-all category controls', async () => {
    await renderPanel();
    expect(fixture.api.catalog).toHaveBeenCalledTimes(1);
    const credential = document.querySelector('[data-settings-transfer-export-credentials]') as HTMLInputElement;
    expect(credential.checked).toBe(false);
    await click('[data-settings-transfer-clear-all]');
    expect(document.querySelectorAll('[data-settings-transfer-category]:checked')).toHaveLength(0);
    expect(document.querySelector('[data-settings-transfer-export]')).toHaveProperty('disabled', true);
    await click('[data-settings-transfer-select-all]');
    expect(document.querySelectorAll('[data-settings-transfer-category]:checked')).toHaveLength(7);
  });

  it('filters out omittedCredentials notice when credentials checkbox is opted in', async () => {
    fixture.api.catalog.mockResolvedValue({
      ...catalog,
      notices: ['localScope', 'omittedCredentials'],
    });
    await renderPanel();
    const noticesList = () => document.querySelector('[data-settings-transfer-notices]');
    expect(noticesList()?.textContent).toContain(translate('en', 'st.settingsTransfer.notice.omittedCredentials'));

    const credentialCheckbox = document.querySelector('[data-settings-transfer-export-credentials]') as HTMLInputElement;
    await act(async () => { credentialCheckbox.click(); });
    await settle();

    expect(credentialCheckbox.checked).toBe(true);
    expect(noticesList()?.textContent).not.toContain(translate('en', 'st.settingsTransfer.notice.omittedCredentials'));
    expect(noticesList()?.textContent).toContain(translate('en', 'st.settingsTransfer.notice.localScope'));

    await act(async () => { credentialCheckbox.click(); });
    await settle();
    expect(credentialCheckbox.checked).toBe(false);
    expect(noticesList()?.textContent).toContain(translate('en', 'st.settingsTransfer.notice.omittedCredentials'));
  });

  it('rejects invalid packages before preview and never calls apply', async () => {
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile({ format: 'not-kiki' });
    expect(document.body.textContent).toContain(translate('en', 'st.settingsTransfer.fileInvalid'));
    expect(fixture.api.preview).not.toHaveBeenCalled();
    expect(fixture.api.apply).not.toHaveBeenCalled();
  });

  it('defaults import to append, previews category changes, and cancels the preview without applying', async () => {
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageWithAppearance);
    expect(fixture.api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'append', includeCredentials: false, categories: ['appearance'] }));
    expect(document.querySelector('[data-settings-transfer-import-credentials]')).not.toBeNull();
    const overwrite = document.querySelector<HTMLInputElement>('input[type="radio"][value="overwrite"]');
    expect(overwrite).not.toBeNull();
    await act(async () => { overwrite!.click(); });
    await settle();
    expect(fixture.api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'overwrite' }));
    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'st.settingsTransfer.cancel');
    await act(async () => { cancel?.click(); });
    await settle();
    expect(fixture.api.cancel).toHaveBeenCalledWith({ previewId: 'preview-1' });
    expect(fixture.api.apply).not.toHaveBeenCalled();
  });

  it('cancels a late preview response after a newer file invalidates its sequence', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    fixture.api.preview
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        scope: catalog.scope,
        categories: [{ id: 'appearance', items: 1, added: 1, conflicts: 0, unchanged: 0, skipped: 0 }],
        notices: [],
        previewId: 'preview-2',
        includesCredentials: true,
        credentialsSelected: false,
        mode: 'append',
      });
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageWithAppearance);
    await selectFile(packageWithAppearance);
    resolveFirst!({
      scope: catalog.scope,
      categories: [{ id: 'appearance', items: 1, added: 1, conflicts: 0, unchanged: 0, skipped: 0 }],
      notices: [],
      previewId: 'preview-1',
      includesCredentials: true,
      credentialsSelected: false,
      mode: 'append',
    });
    await settle();
    expect(fixture.api.cancel).toHaveBeenCalledWith({ previewId: 'preview-1' });
  });

  it('locks the preview snapshot while applying and reports an empty complete result as imported', async () => {
    let resolveApply: ((value: unknown) => void) | undefined;
    fixture.api.apply.mockImplementationOnce(() => new Promise((resolve) => { resolveApply = resolve; }));
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageWithoutPreferences);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-settings-transfer-apply]')!.click(); });
    await settle();
    expect(document.querySelector<HTMLInputElement>('[data-settings-transfer-file]')?.disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>('[data-settings-transfer-category]')].every((input) => input.disabled)).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="settings-transfer-mode"]')].every((input) => input.disabled)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-settings-transfer-import-credentials]')?.disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].every((button) => button.disabled)).toBe(true);
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click(); });
    expect(fixture.onClose).not.toHaveBeenCalled();
    resolveApply!({ status: 'complete', scope: catalog.scope, items: [], timing: 'settingsReloaded' });
    await settle();
    expect(document.querySelector('[data-settings-transfer-apply-result]')?.textContent).toContain(translate('en', 'st.settingsTransfer.imported'));
  });

  it('reports partial backend results and item statuses without exposing backend error text', async () => {
    fixture.api.apply.mockResolvedValueOnce({
      status: 'partial',
      scope: catalog.scope,
      items: [{ category: 'appearance', key: 'spaceUi.theme', status: 'applied' }, { category: 'appearance', key: 'spaceUi.font', status: 'failed' }],
      failure: 'writeFailed',
      timing: 'settingsReloaded',
    });
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageWithAppearance);
    await click('[data-settings-transfer-apply]');
    expect(fixture.api.apply).toHaveBeenCalledWith({ previewId: 'preview-1' });
    expect(document.querySelector('[data-settings-transfer-apply-result]')?.textContent).toContain('spaceUi.font');
    expect(document.querySelector('[data-settings-transfer-apply-result]')?.textContent).toContain(translate('en', 'st.settingsTransfer.failure.writeFailed'));
    expect(document.body.textContent).not.toContain('secret');
  });

  it('does not write device preferences when appearance is not selected', async () => {
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageModelsWithPreferences);
    await click('[data-settings-transfer-apply]');
    expect(localStorage.getItem('kiki.settings')).toBeNull();
    expect(localStorage.getItem('kiki.layout')).toBeNull();
  });

  it('imports appearance preferences after a complete backend apply and reads them back', async () => {
    await renderPanel();
    await click('[role="tab"]:nth-of-type(2)');
    await selectFile(packageWithAppearance);
    await click('[data-settings-transfer-apply]');
    expect(JSON.parse(localStorage.getItem('kiki.settings') ?? '{}')).toMatchObject({ theme: 'dark' });
    expect(JSON.parse(localStorage.getItem('kiki.layout') ?? '{}')).toMatchObject({ sidebarWidth: 320 });
  });
});
